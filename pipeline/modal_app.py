"""
Brace pipeline on Modal - all stages as web endpoints + nightly discover.

Reuses the logic from the brace-pipeline scripts (discover.py, triage.py,
clipper.py, prelabel logic) which are bundled into the image.

Deploy:
    modal deploy modal_app.py

Endpoints (POST, header x-pipeline-token required):
    .../brace-pipeline-discover.modal.run
    .../brace-pipeline-triage.modal.run
    .../brace-pipeline-clip.modal.run
    .../brace-pipeline-prelabel.modal.run

Nothing calls these directly from a browser. The owners portal posts to
/api/run/<stage> on the website, which is a server-side proxy: it checks the
caller is a two-factor portal owner and only then attaches PIPELINE_TOKEN.

Modal secret 'brace-pipeline' must contain:
    SUPABASE_URL, SUPABASE_SERVICE_KEY, YOUTUBE_API_KEY, ANTHROPIC_API_KEY,
    ROBOFLOW_API_KEY, ROBOFLOW_PROJECT, PIPELINE_TOKEN
"""

import fastapi
import modal

app = modal.App("brace-pipeline")

# fastapi_endpoint is the current name; web_endpoint is the older spelling.
web_endpoint = getattr(modal, "fastapi_endpoint", None) or modal.web_endpoint

# Videos and clips persist here between stages
volume = modal.Volume.from_name("brace-media", create_if_missing=True)
MEDIA = "/media"

# The PO-token provider: YouTube withholds real formats from datacenter
# addresses unless the request carries a proof-of-trust token that its own
# player normally generates. This runs that generation locally (it needs
# node), and the yt-dlp plugin asks it for a token per download.
POT = "/opt/bgutil/server/build/generate_once.js"

base_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "curl", "ca-certificates")
    .run_commands(
        # Debian's packaged node is 18, which is end-of-life and not a
        # runtime the challenge solver accepts. Current node from nodesource.
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - "
        "&& apt-get install -y nodejs",
        "node --version",
        "git clone --depth 1 https://github.com/Brainicism/bgutil-ytdlp-pot-provider /opt/bgutil",
        "cd /opt/bgutil/server && npm install --no-audit --no-fund && npx tsc",
        f"test -f {POT}",   # fail the build loudly if the layout ever changes
    )
    # yt-dlp[default] rather than yt-dlp: the extra carries the challenge
    # solver scripts that current YouTube extraction runs in a JS runtime.
    # Without them every real format is withheld — "Only images are
    # available" — and node must be named, since only deno is looked for.
    .pip_install("numpy", "scipy", "requests", "supabase", "yt-dlp[default]",
                 "fastapi", "anthropic", "python-dotenv",
                 "bgutil-ytdlp-pot-provider",
                 # the upload stage runs here now: it reads stored boxes and
                 # ships frames to Roboflow, no GPU involved
                 "roboflow", "opencv-python-headless")
    .add_local_python_source("discover", "triage", "clipper")
)

gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install(
        "torch", "torchvision", "transformers>=4.44",
        "supabase", "roboflow", "opencv-python-headless", "pillow", "numpy",
        "fastapi", "anthropic",   # anthropic: the hit/miss verdict on each shot
    )
)

secret = modal.Secret.from_name("brace-pipeline")

UNAUTHORISED = fastapi.responses.JSONResponse(
    {"error": "unauthorised"}, status_code=401)


def _authorised(request: fastapi.Request) -> bool:
    import hmac
    import os
    # Compare bytes: compare_digest raises on non-ASCII str, which would turn a
    # junk header into a 500 instead of a refusal.
    sent = (request.headers.get("x-pipeline-token") or "").encode("utf-8", "ignore")
    want = (os.environ.get("PIPELINE_TOKEN") or "").encode("utf-8", "ignore")
    return bool(want) and hmac.compare_digest(sent, want)


def _sb():
    import os
    from supabase import create_client
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])


def _hold(video_id: str) -> bool:
    """Deterministic ~15% golden-holdout draw, per video.

    Whole videos go to the holdout, never individual clips: frames from one
    flight are near-duplicates, and splitting them across train and test is
    how a model scores 100% on paper and misses in the field. Must stay
    identical to the SQL backfill in the golden_holdout migration —
    first seven hex chars of md5, mod 100, under 15.
    """
    import hashlib
    return int(hashlib.md5(video_id.encode()).hexdigest()[:7], 16) % 100 < 15


# ---------------------------------------------------------------- advance

# The pipeline's heartbeat. Every hour it pushes work downhill: triage what
# discover found, clip what the owner approved, pre-label what clip cut.
# The review gate stays human on purpose — this automates everything either
# side of it, so the owner's whole job is approving and checking boxes.
# It calls the stages over HTTP with the pipeline's own token, so the logic
# and its limits live in exactly one place.
@app.function(image=base_image, secrets=[secret], timeout=3500,
              schedule=modal.Cron("30 * * * *"))
def _advance():
    import os
    import requests

    sb = _sb()
    base = "https://elohughes-arch--brace-pipeline"   # this deployment's own prefix
    headers = {"x-pipeline-token": os.environ["PIPELINE_TOKEN"]}

    def videos_in(status):
        return (sb.table("pipeline_videos").select("video_id", count="exact", head=True)
                .eq("status", status).execute().count or 0)

    def clips_queued():
        return (sb.table("pipeline_clips").select("clip_id", count="exact", head=True)
                .eq("label_status", "queued").execute().count or 0)

    def hit(stage, query=""):
        r = requests.post(f"{base}-{stage}.modal.run{query}",
                          headers=headers, timeout=3000)
        print(f"[advance] {stage}: {r.status_code} {r.text[:300]}")

    if videos_in("discovered"):
        hit("triage", "?limit=25")
    def clips_unpreviewed():
        return (sb.table("pipeline_clips").select("clip_id", count="exact", head=True)
                .in_("label_status", ["pending", "queued"])
                .or_("preview_path.is.null,poster_path.is.null").execute().count or 0)

    def clips_in(status):
        return (sb.table("pipeline_clips").select("clip_id", count="exact", head=True)
                .eq("label_status", status).execute().count or 0)

    if videos_in("approved") or clips_unpreviewed():
        hit("clip")   # cuts approved videos and backfills missing previews
    if clips_in("raw"):
        hit("screen")
    if clips_queued():
        hit("prelabel")
    return {"stage": "advance"}


# ---------------------------------------------------------------- discover

@app.function(image=base_image, secrets=[secret], timeout=300)
@web_endpoint(method="POST")
def discover(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED
    return _discover_impl.local()


@app.function(image=base_image, secrets=[secret], timeout=300,
              schedule=modal.Cron("0 2 * * *"))  # nightly 02:00 UTC
def _discover_impl():
    import os
    from discover import DEFAULT_QUERIES, search
    sb = _sb()
    total = 0
    for q in DEFAULT_QUERIES:
        rows = search(os.environ["YOUTUBE_API_KEY"], q)
        if rows:
            sb.table("pipeline_videos").upsert(
                rows, on_conflict="video_id", ignore_duplicates=True
            ).execute()
        total += len(rows)
    return {"stage": "discover", "candidates": total}


# ---------------------------------------------------------------- triage

# An hour of timeout: fifty downloads plus fifty verdicts fits with room,
# and the caller stopped waiting at 25 seconds anyway.
@app.function(image=base_image, secrets=[secret], timeout=3600,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def triage(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import os

    # setup.sh lets this key be skipped so the rest can deploy. Say so
    # plainly, rather than failing one video at a time with a bare 401.
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return fastapi.responses.JSONResponse(
            {"error": "no Anthropic API key in the brace-pipeline secret — "
                      "re-run pipeline/setup.sh once you have one"},
            status_code=503)

    import subprocess
    import tempfile

    from pathlib import Path
    from triage import sample_frames, score_frames, KEEP_THRESHOLD

    limit = min(int(request.query_params.get("limit", 10) or 10), 50)

    def download(url: str, out: Path) -> None:
        # A failed earlier run can leave a partial file under this name, and
        # yt-dlp treats an existing file as already downloaded — success, on
        # top of garbage ffprobe then chokes on. Start clean.
        out.unlink(missing_ok=True)
        # YouTube refuses anonymous downloads from datacenter addresses
        # ("Sign in to confirm you're not a bot"), so a signed-in session's
        # cookies live on the volume, put there by:
        #   modal volume put brace-media cookies.txt /cookies/cookies.txt
        # yt-dlp rewrites the file as YouTube rotates the session, hence the
        # copy to local disk: the mounted original stays as exported.
        cookies: list[str] = []
        jar = Path(MEDIA) / "cookies" / "cookies.txt"
        if jar.exists():
            local = Path(tempfile.gettempdir()) / "cookies.txt"
            local.write_bytes(jar.read_bytes())
            cookies = ["--cookies", str(local)]

        # Preference, not demand: -S sorts what YouTube actually offers,
        # capped at 720p, where a -f selector errors outright when the named
        # shapes are withheld — which they now routinely are. Each attempt
        # asks a different set of player clients, because YouTube gates each
        # client's formats separately and not every gate wants a proof-of-
        # trust token from a datacenter address. If all fail, keep yt-dlp's
        # actual words: "exit status 1" diagnoses nothing.
        # The fallback clients run WITHOUT cookies, deliberately: android_vr
        # refuses a cookie jar outright ("skipping client ... does not
        # support cookies"), and it is exactly the client that skips the
        # proof-of-trust gate the signed-in web client hits.
        pot = ["--extractor-args", f"youtubepot-bgutilscript:script_path={POT}"]
        js = ["--js-runtimes", "node"]   # in the image for the POT server anyway
        attempts = [
            ["yt-dlp", *cookies, *pot, *js, "-S", "res:720",
             "--merge-output-format", "mp4", "--no-playlist", "--retries", "2",
             "-o", str(out), url],
            ["yt-dlp", *pot, *js, "-S", "res:720", "--no-playlist",
             "-o", str(out), url],
            ["yt-dlp", *js, "-S", "res:720", "--no-playlist",
             "--extractor-args", "youtube:player_client=android_vr",
             "-o", str(out), url],
        ]
        # Warnings above the final line name the actual gate ("requires a
        # PO token", "only images are available"), so keep each attempt's
        # tail, not just the last attempt's last line.
        saids = []
        for i, cmd in enumerate(attempts, 1):
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode == 0:
                return
            # The database note keeps the ERROR lines; the container log gets
            # everything, because the warnings the note drops are the ones
            # that say whether the token provider actually engaged.
            all_said = (r.stderr or r.stdout or "").strip()
            print(f"[download] attempt {i} failed for {url}\n{all_said[-2500:]}")
            lines = all_said.splitlines()
            errors = [l for l in lines if l.startswith("ERROR")]
            tail = " | ".join((errors or lines)[-2:])
            saids.append(tail or f"exit {r.returncode}")
        raise RuntimeError(("yt-dlp: " + " /// ".join(saids))[:490])

    sb = _sb()
    rows = (sb.table("pipeline_videos").select("*")
            .eq("status", "discovered").limit(limit).execute().data)
    kept = dropped = failed = 0
    for row in rows:
        vid = row["video_id"]
        try:
            out = Path(MEDIA) / "videos" / f"{vid}.mp4"
            out.parent.mkdir(parents=True, exist_ok=True)
            download(row["url"], out)
            with tempfile.TemporaryDirectory() as td:
                frames = sample_frames(out, Path(td))
                r = score_frames(frames)
            # A passing score without a clay in sight keeps nothing: the
            # judge is asked both questions, and the whole dataset is clays.
            keep = r["score"] >= KEEP_THRESHOLD and bool(r.get("clays_visible"))
            # 'downloaded' means triaged and waiting on a human in the review
            # queue. Only 'approved' reaches the clip stage.
            sb.table("pipeline_videos").update({
                "status": "downloaded" if keep else "rejected",
                "triage_score": r["score"],
                "triage_notes": f"[{r.get('camera', '?')}] {r.get('notes', '')}",
                "triage_in_tokens": r.get("in_tokens"),
                "triage_out_tokens": r.get("out_tokens"),
                "weather": r.get("weather"),
                "local_path": str(out) if keep else None,
            }).eq("video_id", vid).execute()
            if not keep:
                out.unlink(missing_ok=True)
            kept, dropped = kept + keep, dropped + (not keep)
        except Exception as e:  # noqa: BLE001
            sb.table("pipeline_videos").update(
                {"status": "error", "triage_notes": str(e)[:500]}
            ).eq("video_id", vid).execute()
            failed += 1
    volume.commit()
    return {"stage": "triage", "examined": len(rows),
            "kept": kept, "dropped": dropped, "errors": failed}


# ---------------------------------------------------------------- clip

@app.function(image=base_image, secrets=[secret], timeout=1800,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def clip(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    from pathlib import Path
    from clipper import extract_audio, detect_shots, group_pairs, cut_clip
    import tempfile

    volume.reload()   # triage committed these from a different container

    # Approved in the portal's review queue. Pass ?unreviewed=1 to clip
    # everything that survived triage without waiting for a human.
    statuses = ["approved"]
    if request.query_params.get("unreviewed") in ("1", "true", "yes"):
        statuses.append("downloaded")

    sb = _sb()
    rows = (sb.table("pipeline_videos").select("*")
            .in_("status", statuses).limit(10).execute().data)
    made = failed = 0
    for row in rows:
      try:
        src = row.get("local_path")
        if not src or not Path(src).exists():
            # Recoverable, not terminal: send it back so triage fetches it
            # again. 'error' is a dead end and this file may simply be gone
            # because the volume was pruned.
            sb.table("pipeline_videos").update(
                {"status": "discovered", "local_path": None,
                 "triage_notes": "file was not on the volume; queued to fetch again"}
            ).eq("video_id", row["video_id"]).execute()
            continue
        # Golden-holdout membership is drawn once per video and inherited by
        # every clip cut from it. Drawn here rather than at discovery so the
        # ~15% is spent only on videos that actually produced clips.
        hold = row.get("holdout")
        if hold is None:
            hold = _hold(row["video_id"])
            sb.table("pipeline_videos").update(
                {"holdout": hold}).eq("video_id", row["video_id"]).execute()

        # Slow-motion footage has sharp, unblurred clays — superb for early
        # labelling, but the deployed model watches real-speed blur, so these
        # frames are tagged all the way to Roboflow and capped in the mix.
        import cv2
        probe = cv2.VideoCapture(src)
        src_fps = probe.get(cv2.CAP_PROP_FPS) or 30.0
        probe.release()
        slo_mo = src_fps >= 45.0

        with tempfile.TemporaryDirectory() as td:
            wav = Path(td) / "a.wav"
            extract_audio(Path(src), wav)
            shots = detect_shots(wav)
        specs = group_pairs(shots)
        outdir = Path(MEDIA) / "clips"
        outdir.mkdir(parents=True, exist_ok=True)
        inserts = []
        for n, spec in enumerate(specs, 1):
            out = outdir / f"{row['video_id']}_shot{n:03d}.mp4"
            cut_clip(Path(src), spec, out)
            inserts.append({
                "video_id": row["video_id"],
                "shot_ts": spec["shot_ts"],
                "clip_start": spec["start"],
                "clip_end": spec["end"],
                "is_pair": spec["is_pair"],
                "pair_gap_s": spec["pair_gap_s"],
                "file_path": str(out),
                "label_status": "raw",   # screening promotes clay-bearing cuts to pending
                "holdout": bool(hold),
                "slo_mo": slo_mo,
            })
        if inserts:
            sb.table("pipeline_clips").insert(inserts).execute()
        sb.table("pipeline_videos").update(
            {"status": "clipped"}).eq("video_id", row["video_id"]).execute()
        made += len(inserts)
      except Exception as e:  # noqa: BLE001
        # Park the offender rather than let it wedge every future run.
        sb.table("pipeline_videos").update(
            {"status": "error", "triage_notes": f"clip: {e}"[:500]}
        ).eq("video_id", row["video_id"]).execute()
        failed += 1
    volume.commit()

    # Previews: a small render of each cut goes to Supabase storage so the
    # owner can watch the actual clip in the portal before sending it to the
    # labeller. Also a backfill — clips cut before previews existed get
    # theirs here, a batch per run.
    import subprocess
    previewed = 0
    # Newest first, matching the order the portal lists them — the first
    # batch previewed must be the batch the owner is looking at.
    todo = (sb.table("pipeline_clips").select("clip_id,file_path,preview_path,poster_path")
            .in_("label_status", ["pending", "queued"])
            .or_("preview_path.is.null,poster_path.is.null")
            .order("created_at", desc=True).limit(100).execute().data)
    for k in todo:
        try:
            src = Path(k["file_path"])
            if not src.exists():
                continue
            patch = {}
            if not k.get("preview_path"):
                small = Path("/tmp") / f"{k['clip_id']}.mp4"
                subprocess.run(
                    ["ffmpeg", "-y", "-i", str(src), "-vf", "scale=-2:480",
                     "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                     "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
                     str(small)],
                    check=True, capture_output=True)
                patch["preview_path"] = f"previews/{k['clip_id']}.mp4"
                sb.storage.from_("clips").upload(
                    patch["preview_path"], small.read_bytes(),
                    {"content-type": "video/mp4", "upsert": "true"})
                small.unlink(missing_ok=True)
            if not k.get("poster_path"):
                # a second in: past any black lead-in, before the shot
                still = Path("/tmp") / f"{k['clip_id']}.jpg"
                subprocess.run(
                    ["ffmpeg", "-y", "-ss", "1", "-i", str(src),
                     "-frames:v", "1", "-vf", "scale=-2:480", "-q:v", "5",
                     str(still)],
                    check=True, capture_output=True)
                patch["poster_path"] = f"previews/{k['clip_id']}.jpg"
                sb.storage.from_("clips").upload(
                    patch["poster_path"], still.read_bytes(),
                    {"content-type": "image/jpeg", "upsert": "true"})
                still.unlink(missing_ok=True)
            if patch:
                sb.table("pipeline_clips").update(patch).eq(
                    "clip_id", k["clip_id"]).execute()
            previewed += 1
        except Exception as e:  # noqa: BLE001
            print(f"[clip] preview failed for {k['clip_id']}: {e}")

    return {"stage": "clip", "videos": len(rows), "clips_created": made,
            "previews_made": previewed, "errors": failed}


# ---------------------------------------------------------------- screen

# The machine's eyes, in front of the owner's. Every raw cut is detected at
# PRELABEL_FPS: no clay in any frame rejects it before a human ever sees it;
# a clay promotes it to the check queue, trimmed to its tracked flight, with
# the shot's verdict attached and the whole trajectory stored.
@app.function(image=gpu_image, secrets=[secret], gpu="T4", timeout=1800,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def screen(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import os
    import cv2
    import torch
    from pathlib import Path
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection

    volume.reload()   # see what the previous stage committed from its own container

    DETECT_PROMPT = "flying clay pigeon. small orange disc. small black disc in sky."
    sb = _sb()
    rows = (sb.table("pipeline_clips").select("*")
            .eq("label_status", "raw").limit(10).execute().data)
    if not rows:
        return {"stage": "screen", "processed": 0}

    device = "cuda"
    proc = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
    gdino = AutoModelForZeroShotObjectDetection.from_pretrained(
        "IDEA-Research/grounding-dino-base").to(device)

    done = kept = 0
    for row in rows:
        path = row["file_path"]
        if not Path(path).exists():
            sb.table("pipeline_clips").update(
                {"label_status": "rejected"}).eq("clip_id", row["clip_id"]).execute()
            continue
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        # Detection rate. 30 makes the tracked flight boundaries tight to a
        # frame; PRELABEL_FPS in the secret turns the dial (GPU time scales
        # with it — a 10s clip is ~300 frames at 30).
        detect_fps = float(os.environ.get("PRELABEL_FPS", 30))
        step = max(1, int(round(fps / detect_fps)))
        frames, idx = [], 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                frames.append(frame)
            idx += 1
        cap.release()

        # 0.25 boxed birds, wad and smoke — barrel-cam clips with one clay in
        # shot were claiming ten. Raised, and a dial (SCREEN_THRESHOLD in the
        # secret) because the right number is found by looking at Roboflow,
        # not by guessing here.
        thresh = float(os.environ.get("SCREEN_THRESHOLD", 0.32))
        boxes_per_frame = {}
        for i, frame in enumerate(frames):
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            inputs = proc(images=rgb, text=DETECT_PROMPT,
                          return_tensors="pt").to(device)
            with torch.no_grad():
                out = gdino(**inputs)
            res = proc.post_process_grounded_object_detection(
                out, inputs.input_ids, threshold=thresh,
                target_sizes=[rgb.shape[:2]])[0]
            if len(res["boxes"]):
                boxes_per_frame[i] = [
                    {"xyxy": b.tolist(), "conf": float(s)}
                    for b, s in zip(res["boxes"].cpu(), res["scores"].cpu())
                ]

        # The clipper cuts by sound, which cannot know whether a clay is in
        # view. This is the first stage that can see — a clip with no clay
        # in any frame is rejected here rather than sent on as empty work.
        if not boxes_per_frame:
            sb.table("pipeline_clips").update(
                {"label_status": "rejected"}).eq("clip_id", row["clip_id"]).execute()
            done += 1
            continue

        # Trim to the tracked flight. The audio found the shot; the
        # detections across the clip are the track; the file shrinks to
        # [first box seen, last box seen] — hit and gone, or flown from
        # view. boxes_json keeps the whole trajectory.
        import subprocess as sp
        first_i, last_i = min(boxes_per_frame), max(boxes_per_frame)
        clip_len = len(frames) * step / fps
        t0 = max(0.0, first_i * step / fps - 0.3)
        t1 = min(clip_len, last_i * step / fps + 0.5)
        new_start = float(row["clip_start"]) + t0
        new_end = float(row["clip_start"]) + t1
        pv = row.get("preview_path") or f"previews/{row['clip_id']}.mp4"
        po = row.get("poster_path") or f"previews/{row['clip_id']}.jpg"
        if t0 > 0.6 or t1 < clip_len - 0.6:
            trimmed = Path("/tmp") / f"trim_{row['clip_id']}.mp4"
            sp.run(["ffmpeg", "-y", "-ss", f"{t0:.2f}", "-to", f"{t1:.2f}",
                    "-i", path, "-c:v", "libx264", "-preset", "veryfast",
                    "-crf", "23", "-c:a", "aac", str(trimmed)],
                   check=True, capture_output=True)
            Path(path).write_bytes(trimmed.read_bytes())
            trimmed.unlink()
            small = Path("/tmp") / f"pv_{row['clip_id']}.mp4"
            sp.run(["ffmpeg", "-y", "-i", path, "-vf", "scale=-2:480",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                    "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
                    str(small)], check=True, capture_output=True)
            sb.storage.from_("clips").upload(pv, small.read_bytes(),
                {"content-type": "video/mp4", "upsert": "true"})
            small.unlink(missing_ok=True)
            still = Path("/tmp") / f"po_{row['clip_id']}.jpg"
            sp.run(["ffmpeg", "-y", "-ss", "0.5", "-i", path, "-frames:v", "1",
                    "-vf", "scale=-2:480", "-q:v", "5", str(still)],
                   check=True, capture_output=True)
            sb.storage.from_("clips").upload(po, still.read_bytes(),
                {"content-type": "image/jpeg", "upsert": "true"})
            still.unlink(missing_ok=True)

        sb.table("pipeline_labels").upsert({
            "clip_id": row["clip_id"],
            "n_clays": max((len(v) for v in boxes_per_frame.values()), default=0),
            "boxes_json": boxes_per_frame,
            "frame_dt": step / fps,
            "t_offset": t0 if (t0 > 0.6 or t1 < clip_len - 0.6) else 0.0,
        }).execute()

        # The verdict: did the clay break? Four frames straddling the shot —
        # a hit fragments and vanishes in a puff, a miss keeps flying. The
        # boxes say where the clay is, and now they aim the judge's eye:
        # each frame is cropped around the tracked clay before Sonnet sees it.
        outcome, conf = _judge_shot(row, frames, fps, step, boxes_per_frame)

        metrics = _shot_metrics(
            float(row["shot_ts"]) - float(row["clip_start"]),
            boxes_per_frame, step / fps,
            frames[0].shape[1] if frames else 0, outcome)

        sb.table("pipeline_clips").update(
            {"label_status": "pending",
             "clip_start": new_start, "clip_end": new_end,
             "preview_path": pv, "poster_path": po,
             "outcome": outcome, "outcome_conf": conf, **metrics}
        ).eq("clip_id", row["clip_id"]).execute()
        done += 1
        kept += 1

    volume.commit()   # the trims rewrote clip files on the volume
    return {"stage": "screen", "processed": done, "kept": kept}


# ---------------------------------------------------------------- prelabel

# Upload only, no GPU: the boxes were drawn at screening and stored; this
# reopens the trimmed clip, lifts the same frames, and ships them to
# Roboflow with confidence routing.
@app.function(image=base_image, secrets=[secret], timeout=900,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def prelabel(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import os
    import cv2
    from pathlib import Path

    volume.reload()
    sb = _sb()
    rows = (sb.table("pipeline_clips").select("*")
            .eq("label_status", "queued").limit(25).execute().data)
    if not rows:
        return {"stage": "prelabel", "processed": 0, "uploaded": 0}

    from roboflow import Roboflow
    rf = Roboflow(api_key=os.environ["ROBOFLOW_API_KEY"])
    project = rf.workspace().project(os.environ["ROBOFLOW_PROJECT"])

    sure = float(os.environ.get("AUTO_ACCEPT", 0.55))
    done = uploaded = failed = 0
    for row in rows:
      try:
        lab = (sb.table("pipeline_labels").select("boxes_json,frame_dt,t_offset")
               .eq("clip_id", row["clip_id"]).execute().data)
        boxes = lab[0].get("boxes_json") if lab else None
        if not boxes or not Path(row["file_path"]).exists():
            sb.table("pipeline_clips").update(
                {"label_status": "rejected"}).eq("clip_id", row["clip_id"]).execute()
            continue
        frame_dt = float(lab[0].get("frame_dt") or 0.2)
        t_off = float(lab[0].get("t_offset") or 0.0)
        cap = cv2.VideoCapture(row["file_path"])
        tmp = Path("/tmp/frames")
        tmp.mkdir(parents=True, exist_ok=True)
        idxs = sorted(int(k) for k in boxes)
        stride = max(1, int(round((1.0 / frame_dt) / 1.7)))
        # Golden-holdout clips are the ruler the model is measured with:
        # their frames land in Roboflow's *test* split so no training run
        # can ever see them, and they are never auto-accepted — ground
        # truth is only ground truth once a human has verified every box.
        golden = bool(row.get("holdout"))
        all_confident = True
        sent = 0
        for i in idxs[::stride]:
            t = i * frame_dt - t_off
            if t < 0:
                continue           # trimmed off the front of the file
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok:
                continue
            fp = tmp / f"{row['clip_id']}_{i:04d}.jpg"
            cv2.imwrite(str(fp), frame)
            h, w = frame.shape[:2]
            bxs = boxes[str(i)] if str(i) in boxes else boxes.get(i, [])
            lines = []
            for b in bxs:
                x1, y1, x2, y2 = b["xyxy"]
                lines.append(f"0 {(x1+x2)/2/w:.6f} {(y1+y2)/2/h:.6f} "
                             f"{(x2-x1)/w:.6f} {(y2-y1)/h:.6f}")
            ann = fp.with_suffix(".txt")
            ann.write_text("\n".join(lines))
            confident = (not golden) and (
                all(b["conf"] >= sure for b in bxs) if bxs else False)
            all_confident = all_confident and confident
            tags = ["prelabel", "confident" if confident else "doubtful"]
            if golden:
                tags.append("golden")
            if row.get("slo_mo"):
                tags.append("slo-mo")
            project.upload(str(fp), annotation_path=str(ann),
                           split="test" if golden else "train",
                           batch_name=("golden-holdout" if golden
                                       else "auto-accepted" if confident
                                       else "needs-review"),
                           tag_names=tags,
                           num_retry_uploads=2)
            uploaded += 1
            sent += 1
            fp.unlink(missing_ok=True)
            ann.unlink(missing_ok=True)
        cap.release()
        # Where this clip's frames went, worn on the Labelling page.
        batch = ("golden-holdout" if golden
                 else "auto-accepted" if (sent and all_confident)
                 else "needs-review")
        sb.table("pipeline_clips").update(
            {"label_status": "prelabelled", "roboflow_id": batch}
        ).eq("clip_id", row["clip_id"]).execute()
        done += 1
      except Exception as e:  # noqa: BLE001
        # One bad upload must not sink the batch. The clip stays queued, so
        # the next beat simply tries it again.
        print(f"[prelabel] {row.get('clip_id')} failed, left queued: {e}")
        failed += 1

    return {"stage": "prelabel", "processed": done,
            "frames_uploaded": uploaded, "errors": failed}


def _shot_metrics(into_clip, boxes_per_frame, frame_dt, frame_w, outcome):
    """The instrument panel: what the track and the clock can tell a shooter.

    det_conf is the mean confidence of the best box per frame — how sure the
    detector was of the clay it followed. Range and speed exist only for
    hits: the audio bang is time zero, the track's end is the break, and the
    gap is the pellets' flight time, converted through a ballistics table
    (24g No 7.5 leaving at ~400 m/s and slowing hard). Crossing speed is the
    clay's angular speed just before the break times the range — the camera
    only sees the crossing component, which suits crossers and loopers, and
    the field of view is a nominal dial (CAMERA_HFOV_DEG) until footage
    comes from known hardware. Estimates, and shown as such.
    """
    import math
    import os

    if not boxes_per_frame:
        return {}
    best = {i: max(bs, key=lambda b: b["conf"])
            for i, bs in boxes_per_frame.items() if bs}
    if not best:
        return {}
    out = {"det_conf": round(sum(b["conf"] for b in best.values()) / len(best), 3)}
    if outcome != "hit":
        return out

    # Bang to break: the track ends when the clay stops being a clay.
    tof = max(best) * frame_dt - into_clip
    if not (0.03 <= tof <= 0.35):
        return out          # implausible clock — no estimate beats a wrong one
    table = [(0.00, 0.0), (0.06, 18.3), (0.10, 27.4),
             (0.145, 36.6), (0.19, 45.7), (0.30, 64.0)]
    rng = table[-1][1]
    for (t0, d0), (t1, d1) in zip(table, table[1:]):
        if tof <= t1:
            rng = d0 + (d1 - d0) * (tof - t0) / (t1 - t0)
            break
    out["range_m"] = round(rng, 1)

    # Crossing speed over the last few tracked frames before the break.
    idxs = sorted(best)[-6:]
    if len(idxs) >= 2 and frame_w:
        (ax1, ay1, ax2, ay2) = best[idxs[0]]["xyxy"]
        (bx1, by1, bx2, by2) = best[idxs[-1]]["xyxy"]
        px = math.hypot((bx1 + bx2 - ax1 - ax2) / 2.0,
                        (by1 + by2 - ay1 - ay2) / 2.0)
        secs = (idxs[-1] - idxs[0]) * frame_dt
        if secs > 0:
            hfov = math.radians(float(os.environ.get("CAMERA_HFOV_DEG", 70)))
            mph = (px / secs) * (hfov / frame_w) * rng * 2.23694
            if 5 <= mph <= 130:   # outside this is track noise, not a clay
                out["speed_mph"] = round(mph)
    return out


# ---------------------------------------------------------------- rejudge

# Second opinions with better eyes. Clips screened before the verdict
# learned to zoom carry judgements made on full-width frames; this re-runs
# only the verdict — no GPU, no re-detection — using the stored track to
# aim the crops. A one-off tool after a verdict upgrade, not a beat stage.
@app.function(image=base_image, secrets=[secret], timeout=1800,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def rejudge(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import os
    import cv2
    from pathlib import Path

    if not os.environ.get("ANTHROPIC_API_KEY"):
        return fastapi.responses.JSONResponse(
            {"error": "ANTHROPIC_API_KEY is not set in the Modal secret"},
            status_code=503)

    volume.reload()
    limit = min(int(request.query_params.get("limit", 60)), 200)
    sb = _sb()
    rows = (sb.table("pipeline_clips").select("*")
            .in_("label_status", ["pending", "queued", "prelabelled"])
            .limit(limit).execute().data)

    done = changed = skipped = 0
    for row in rows:
        try:
            lab = (sb.table("pipeline_labels")
                   .select("boxes_json,frame_dt,t_offset")
                   .eq("clip_id", row["clip_id"]).execute().data)
            boxes = lab[0].get("boxes_json") if lab else None
            if not boxes or not Path(row["file_path"]).exists():
                skipped += 1
                continue
            frame_dt = float(lab[0].get("frame_dt") or 0.2)
            t_off = float(lab[0].get("t_offset") or 0.0)
            cap = cv2.VideoCapture(row["file_path"])
            fps = cap.get(cv2.CAP_PROP_FPS) or 30
            step = max(1, int(round(fps * frame_dt)))
            frames, idx = [], 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if idx % step == 0:
                    frames.append(frame)
                idx += 1
            cap.release()
            if not frames:
                skipped += 1
                continue
            # The stored track is indexed against the untrimmed cut; the file
            # on disk may have been trimmed by t_off. Shift the keys so the
            # boxes line up with the frames just read.
            shift = int(round(t_off / frame_dt))
            shifted = {int(k) - shift: v for k, v in boxes.items()
                       if int(k) - shift >= 0}
            outcome, conf = _judge_shot(row, frames, fps, step, shifted)
            if outcome is None:
                skipped += 1
                continue
            if outcome != row.get("outcome") or conf != row.get("outcome_conf"):
                changed += 1
            metrics = _shot_metrics(
                float(row["shot_ts"]) - float(row["clip_start"]),
                shifted, frame_dt,
                frames[0].shape[1] if frames else 0, outcome)
            sb.table("pipeline_clips").update(
                {"outcome": outcome, "outcome_conf": conf, **metrics}
            ).eq("clip_id", row["clip_id"]).execute()
            done += 1
        except Exception as e:  # noqa: BLE001
            print(f"[rejudge] {row.get('clip_id')} failed: {e}")
            skipped += 1

    return {"stage": "rejudge", "rejudged": done,
            "verdicts_changed": changed, "skipped": skipped}


def _judge_shot(row, frames, fps, step, boxes_per_frame=None):
    """hit / miss / unclear for one clip, from frames around the gunshot.

    The detector's boxes aim the judge's eye. At full width a distant clay
    is a handful of grey pixels and the only honest verdict is 'unclear' —
    so each frame sent to the model is cropped around the tracked clay and
    enlarged. A frame with no detection near it falls back to the full
    picture rather than guessing where to look.
    """
    import base64
    import json
    import os
    import re

    import anthropic
    import cv2

    try:
        # where in the sampled-frame list the shot falls
        into_clip = float(row["shot_ts"]) - float(row["clip_start"])
        frame_dt = step / fps          # seconds between sampled frames
        shot_i = int(round(into_clip / frame_dt))
        # Slow motion for the judge, from footage we already have: pellets
        # reach the clay a tenth to a quarter of a second after the bang and
        # the break lasts a tenth more, so the picks cluster densely inside
        # that window — four widely-spaced frames could jump clean over it.
        picks = [shot_i + int(round(off / frame_dt))
                 for off in (-0.3, 0.08, 0.16, 0.25, 0.36, 0.55, 0.9, 1.4)]
        picks = sorted({i for i in picks if 0 <= i < len(frames)})
        if len(picks) < 2:
            return None, None

        def eye(i):
            """The frame at i, cropped to the clay the detector tracked."""
            frame = frames[i]
            if not boxes_per_frame:
                return frame, False
            near = min(boxes_per_frame, key=lambda j: abs(j - i), default=None)
            if near is None or abs(near - i) * frame_dt > 0.7:
                return frame, False   # track lost around this moment
            best = max(boxes_per_frame[near], key=lambda b: b["conf"])
            x1, y1, x2, y2 = best["xyxy"]
            h, w = frame.shape[:2]
            cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            # Enough sky around the disc to show fragments flying or the
            # clay sailing on — a tight crop would hide the very evidence.
            half = max(x2 - x1, y2 - y1, 110.0) * 2.2
            a, b = int(max(0, cx - half)), int(max(0, cy - half))
            c, d = int(min(w, cx + half)), int(min(h, cy + half))
            crop = frame[b:d, a:c]
            if crop.size == 0:
                return frame, False
            if crop.shape[0] < 384:   # a distant clay enlarges to legible
                s = 384.0 / crop.shape[0]
                crop = cv2.resize(crop, (max(1, int(crop.shape[1] * s)), 384))
            return crop, True

        blocks = []
        for n, i in enumerate(picks, 1):
            img, zoomed = eye(i)
            ok, jpg = cv2.imencode(".jpg", img,
                                   [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                return None, None
            when = "before" if i < shot_i else "after"
            blocks.append({"type": "text",
                           "text": f"Frame {n} ({when} the shot"
                                   f"{', zoomed to the tracked clay' if zoomed else ', full view'}):"})
            blocks.append({"type": "image", "source": {
                "type": "base64", "media_type": "image/jpeg",
                "data": base64.standard_b64encode(jpg.tobytes()).decode()}})
        blocks.append({"type": "text", "text": "Verdict. JSON only."})
        # Its own dial, and a sharper default than triage's: the verdict is
        # fine-grained perception on a small volume, so the upgrade costs
        # half a cent a clip and buys real accuracy. VERDICT_MODEL overrides.
        msg = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"]).messages.create(
            model=os.environ.get("VERDICT_MODEL", "claude-sonnet-5"),
            max_tokens=200,
            system=("A clay pigeon is shot at between the 'before' and 'after' "
                    "frames. The after-frames cluster tightly on the moment "
                    "of impact: pellets arrive within a quarter second of the "
                    "shot and a break lasts a tenth more, so study the early "
                    "after-frames for the exact instant. Frames marked "
                    "'zoomed to the tracked clay' are crops centred on the "
                    "detector's box for the clay, so the disc should be near "
                    "the middle. Hit: the clay breaks into fragments or a "
                    "puff of dust and is gone from later frames. Miss: the "
                    "same clay continues its flight intact. If the clay "
                    "cannot be followed across the frames, say unclear. "
                    "Reply with JSON "
                    'only: {"outcome": "hit|miss|unclear", "confidence": <0-1>}'),
            messages=[{"role": "user", "content": blocks}])
        text = "".join(b.text for b in msg.content
                       if getattr(b, "type", "") == "text")
        data = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
        outcome = str(data.get("outcome", "unclear"))
        if outcome not in ("hit", "miss", "unclear"):
            outcome = "unclear"
        return outcome, max(0.0, min(1.0, float(data.get("confidence", 0))))
    except Exception as e:  # noqa: BLE001 — a verdict is never worth a crash
        print(f"[prelabel] verdict failed for {row.get('clip_id')}: {e}")
        return None, None
