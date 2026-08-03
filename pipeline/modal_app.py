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
        # Our own detector: trained here from our own boxes, and the thing
        # that eventually replaces Grounding DINO on the screening path.
        "ultralytics", "pyyaml",
    )
)

# Where the training set is written and the weights land, both on the volume
# so a run survives the container that made it.
DATASETS = f"{MEDIA}/datasets"
MODELS = f"{MEDIA}/models"

secret = modal.Secret.from_name("brace-pipeline")

# What the verdicts actually cost. Judging was spending real money with
# nothing counting it — the portal priced triage alone — so every call
# appends its usage here and the stage that ran flushes one row per model
# when it finishes. Module-level is right: a request runs in one container.
_USAGE: list = []


def _flush_usage(sb, stage):
    """Write what this run's verdicts cost, then forget it."""
    if not _USAGE:
        return
    per: dict = {}
    for model, i, o in _USAGE:
        row = per.setdefault(model, [0, 0, 0])
        row[0] += 1
        row[1] += i or 0
        row[2] += o or 0
    _USAGE.clear()
    try:
        sb.table("pipeline_spend_log").insert([
            {"stage": stage, "model": m, "calls": c,
             "in_tokens": i, "out_tokens": o}
            for m, (c, i, o) in per.items()]).execute()
    except Exception as e:  # noqa: BLE001 — accounting must never stop work
        print(f"[spend] could not record usage: {e}")

def _latest_weights(sb):
    """The newest trained detector's weights, if there is one on the volume.

    MODEL_NAME in the secret pins a particular run — the way to stay on a
    known-good detector while a newer one is still being judged. Absent
    that, the most recent training run wins. A row whose weights are no
    longer on the volume is skipped rather than trusted.
    """
    from pathlib import Path
    try:
        import os
        q = sb.table("pipeline_models").select("name,weights_path")
        pin = os.environ.get("MODEL_NAME")
        if pin:
            q = q.eq("name", pin)
        rows = q.order("created_at", desc=True).limit(5).execute().data or []
        for r in rows:
            p = r.get("weights_path")
            if p and Path(p).exists():
                return p
    except Exception as e:  # noqa: BLE001 — no model is a fallback, not a failure
        print(f"[detector] could not read the model book: {e}")
    return None


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


def _noted(sb, summary, tone="good"):
    """Record a finished run in the portal's activity feed, then return it.

    The browser only hears a 202 for long runs; this is how their real
    outcome reaches the feed. Best-effort — the feed must never stop work.
    """
    try:
        stage = summary.get("stage", "?")
        said = " \u00b7 ".join(f"{k.replace('_', ' ')} {v}"
                                for k, v in summary.items() if k != "stage")
        sb.table("pipeline_activity").insert({
            "stage": stage, "tone": tone, "email": "modal",
            "line": f"{stage} finished on Modal" + (f" \u2014 {said}" if said else ""),
        }).execute()
    except Exception as e:  # noqa: BLE001
        print(f"[activity] not recorded: {e}")
    return summary


def _split(group: str) -> str:
    """The split judge: deal a whole scene into train, valid or test.

    The group is the channel when one is recorded, else the video id. A
    channel is a scene — the same shooter at the same ground with the same
    camera across every upload — and held-out scenes are the only split
    protocol that eliminates all train/test information sharing: frame-level
    splits leak near-duplicate frames, video-level splits still test the
    model on grounds it trained on. Deterministic md5, first seven hex chars
    mod 100: under 15 test (the golden ruler, human-verified, never trained
    on), under 30 valid (tunes training runs), the rest train — ~70/15/15.
    Must stay identical to the channel_level_split migration.
    """
    import hashlib
    h = int(hashlib.md5(group.encode()).hexdigest()[:7], 16) % 100
    return "test" if h < 15 else "valid" if h < 30 else "train"


# ---------------------------------------------------------------- advance

# The pipeline's heartbeat. Every hour it pushes work downhill: triage what
# discover found, clip what the owner approved, pre-label what clip cut.
# The review gate stays human on purpose — this automates everything either
# side of it, so the owner's whole job is approving and checking boxes.
# It calls the stages over HTTP with the pipeline's own token, so the logic
# and its limits live in exactly one place.
@app.function(image=base_image, secrets=[secret], timeout=3500,
              schedule=modal.Cron("*/30 * * * *"))
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

    def clips_unpreviewed():
        return (sb.table("pipeline_clips").select("clip_id", count="exact", head=True)
                .in_("label_status", ["pending", "queued", "rejected"])
                .or_("preview_path.is.null,poster_path.is.null").execute().count or 0)

    def clips_in(status):
        return (sb.table("pipeline_clips").select("clip_id", count="exact", head=True)
                .eq("label_status", status).execute().count or 0)

    def errored():
        return videos_in("error")

    def clips_to_recut():
        return (sb.table("pipeline_clips").select("clip_id", count="exact", head=True)
                .eq("needs_recut", True).execute().count or 0)

    # One pass an hour was the reason the machine kept needing to be pushed
    # by hand: screening takes ten clips a call, so a backlog of seven
    # hundred would have taken seventy hours of beats to clear while the
    # queue only grew. Each stage now keeps going while it still has work
    # and there is time left in the hour, so the beat drains a backlog
    # instead of nibbling at it.
    import time
    started = time.time()
    BUDGET = 24 * 60          # inside the half-hour, so beats never overlap

    def drain(stage, work, query="", passes=12):
        for _ in range(passes):
            if time.time() - started > BUDGET:
                print(f"[advance] out of time before {stage}")
                return
            if not work():
                return
            hit(stage, query)

    # An errored video was a dead end — nothing in the machine ever looked
    # at one again, so a download that failed on a bad night stayed failed
    # for good. One retry a beat, and if it fails again it lands back here
    # and is retried next time rather than being lost.
    if errored():
        try:
            back = (sb.table("pipeline_videos").select("video_id")
                    .eq("status", "error").limit(5).execute().data or [])
            for v in back:
                sb.table("pipeline_videos").update(
                    {"status": "discovered", "local_path": None}
                ).eq("video_id", v["video_id"]).execute()
            print(f"[advance] returned {len(back)} errored videos to discovered")
        except Exception as e:  # noqa: BLE001 — never sink the beat
            print(f"[advance] could not retry errored videos: {e}")

    # Order matters: a re-cut clip goes back to raw, so cut before screening
    # and it is boxed on the same beat rather than waiting for the next.
    drain("triage", lambda: videos_in("discovered"), "?limit=25", passes=6)
    drain("recut", clips_to_recut, "?limit=25", passes=4)
    drain("clip", lambda: videos_in("approved") or clips_unpreviewed(), "", passes=4)
    drain("screen", lambda: clips_in("raw"), "?limit=20")
    # The last gate. Screening has already proved a clay is in the cut, and
    # Roboflow is itself where boxes get checked — so holding every clip for
    # a press before it can be boxed is a second queue doing the first one's
    # job. AUTOSEND=1 in the secret hands checked clips over on the beat and
    # makes the flow hands-off apart from Review. Off by default, because it
    # spends Roboflow quota and that should be a decision, not a surprise.
    if os.environ.get("AUTOSEND") in ("1", "true", "yes"):
        try:
            ready = (sb.table("pipeline_clips").select("clip_id")
                     .eq("label_status", "pending")
                     .neq("owner_outcomes", "[]")
                     .limit(200).execute().data or [])
            if ready:
                ids = [r["clip_id"] for r in ready]
                sb.table("pipeline_clips").update({"label_status": "queued"}) \
                  .in_("clip_id", ids).execute()
                print(f"[advance] auto-sent {len(ids)} checked clips to the labeller")
        except Exception as e:  # noqa: BLE001
            print(f"[advance] autosend failed: {e}")

    drain("prelabel", clips_queued, "?limit=50", passes=6)

    # The pulse: every beat stamps the clock, so the Health page can tell a
    # quiet machine from a dead one.
    import datetime
    sb.table("pipeline_health").upsert({
        "probe": "heartbeat", "status": "ok", "detail": "beat completed",
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }).execute()
    return {"stage": "advance"}


# ---------------------------------------------------------------- health

# The machine's physical: probe every external dependency the pipeline
# stands on and write the findings where the portal can read them. Runs
# daily on its own, and on demand from the Health page — because an
# autonomous system that cannot report its own sickness fails silently,
# and every outage this pipeline has had was discovered by accident.
@app.function(image=base_image, secrets=[secret], timeout=600,
              volumes={MEDIA: volume},
              schedule=modal.Cron("0 7 * * *"))  # daily, 7am UTC
def _health_impl():
    import datetime
    import os
    import requests
    from pathlib import Path

    volume.reload()
    sb = _sb()

    def put(probe, status, detail=""):
        sb.table("pipeline_health").upsert({
            "probe": probe, "status": status, "detail": str(detail)[:300],
            "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }).execute()

    # Anthropic — the judgement. A one-token ping catches a dead key and,
    # crucially, an empty credit balance: the outage that silently blinded
    # every verdict for an afternoon.
    try:
        import anthropic
        anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"]).messages.create(
            model="claude-haiku-4-5", max_tokens=1,
            messages=[{"role": "user", "content": "ping"}])
        put("anthropic", "ok", "key live, credits present")
    except Exception as e:  # noqa: BLE001
        s = str(e)
        put("anthropic", "fail",
            "credits exhausted — top up at console.anthropic.com" if "credit" in s.lower()
            else s)

    # YouTube Data API — discovery's fuel. 10,000 units/day; each criteria
    # search costs ~100. A 403 here is quota gone or key revoked.
    try:
        r = requests.get("https://www.googleapis.com/youtube/v3/videos",
                         params={"key": os.environ["YOUTUBE_API_KEY"],
                                 "id": "dQw4w9WgXcQ", "part": "id"}, timeout=20)
        if r.status_code == 200:
            put("youtube", "ok", "key live, quota available")
        elif r.status_code == 403:
            put("youtube", "warn", "quota exhausted or key restricted — "
                "resets midnight Pacific; searches cost 100 units each")
        else:
            put("youtube", "fail", f"HTTP {r.status_code}: {r.text[:150]}")
    except Exception as e:  # noqa: BLE001
        put("youtube", "fail", str(e))

    # Roboflow — where the labels land.
    try:
        from roboflow import Roboflow
        Roboflow(api_key=os.environ["ROBOFLOW_API_KEY"]).workspace().project(
            os.environ["ROBOFLOW_PROJECT"])
        put("roboflow", "ok", "key and project reachable")
    except Exception as e:  # noqa: BLE001
        put("roboflow", "fail", str(e))

    # Cookies — YouTube downloads die without them, and YouTube rotates
    # them when the browser session is reused. Age is the early warning.
    try:
        ck = Path(MEDIA) / "cookies" / "cookies.txt"
        if not ck.exists():
            put("cookies", "fail", "no cookies file on the volume — "
                "downloads will fail their first attempt chain")
        else:
            days = (__import__("time").time() - ck.stat().st_mtime) / 86400
            put("cookies", "ok" if days < 14 else "warn",
                f"{days:.0f} days old" + ("" if days < 14 else
                " — re-export from an incognito window when downloads start failing"))
    except Exception as e:  # noqa: BLE001
        put("cookies", "fail", str(e))

    # Backlogs — where work is queued or stuck. Errors outrank volume.
    try:
        def n(table, col, vals):
            return (sb.table(table).select("*", count="exact", head=True)
                    .in_(col, vals).execute().count or 0)
        errs = n("pipeline_videos", "status", ["error"])
        detail = (f"{n('pipeline_videos', 'status', ['discovered'])} to triage · "
                  f"{n('pipeline_videos', 'status', ['downloaded'])} to review · "
                  f"{n('pipeline_clips', 'label_status', ['raw'])} to screen · "
                  f"{n('pipeline_clips', 'label_status', ['queued'])} to upload · "
                  f"{errs} errored")
        put("backlogs", "warn" if errs else "ok", detail)
    except Exception as e:  # noqa: BLE001
        put("backlogs", "fail", str(e))

    return {"stage": "health", "probes": 5}


@app.function(image=base_image, secrets=[secret], timeout=600,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def health(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED
    return _health_impl.local()


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
    from discover import DEFAULT_QUERIES, DEFAULT_CHANNELS, search, channel_uploads
    sb = _sb()
    key = os.environ["YOUTUBE_API_KEY"]
    total = 0
    for q in DEFAULT_QUERIES:
        rows = search(key, q)
        if rows:
            sb.table("pipeline_videos").upsert(
                rows, on_conflict="video_id", ignore_duplicates=True
            ).execute()
        total += len(rows)
    # Channels worth crawling in full — a camera maker or shooting school
    # whose uploads are almost entirely POV clay footage — rather than
    # leaving them to a keyword search's luck. See DEFAULT_CHANNELS.
    for c in DEFAULT_CHANNELS:
        rows = channel_uploads(key, c)
        if rows:
            sb.table("pipeline_videos").upsert(
                rows, on_conflict="video_id", ignore_duplicates=True
            ).execute()
        total += len(rows)
    return {"stage": "discover", "candidates": total}


# Fetching a video is needed by two stages now — triage on the way in, and
# recut when a hand-edited clip needs a source that has since been pruned —
# so it lives out here rather than inside either one.
def _fetch_video(url, out):
    # Imported here, not at the top: the modules live in the container image
    # rather than wherever this file is being read.
    import subprocess
    import tempfile
    from pathlib import Path

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


# ---------------------------------------------------------------- triage

# Six hours of timeout: the whole discovered queue in one press. The caller
# stopped waiting at 25 seconds anyway, statuses advance per video, and the
# volume is committed as the run goes — a killed run keeps what it finished.
@app.function(image=base_image, secrets=[secret], timeout=21600,
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

    limit = min(int(request.query_params.get("limit", 10) or 10), 500)

    download = _fetch_video

    sb = _sb()
    rows = (sb.table("pipeline_videos").select("*")
            .eq("status", "discovered").limit(limit).execute().data)
    kept = dropped = failed = 0
    for done_so_far, row in enumerate(rows):
        if done_so_far and done_so_far % 5 == 0:
            volume.commit()   # keep finished downloads even if this run dies
        vid = row["video_id"]
        try:
            out = Path(MEDIA) / "videos" / f"{vid}.mp4"
            out.parent.mkdir(parents=True, exist_ok=True)
            download(row["url"], out)

            # Forced: the owner has watched this one and wants it in, whatever
            # the machine thinks. Fetch the file, then hand it straight to the
            # clipper — no silence gate, no scoring call. Sending it back
            # through the same judge that already refused it would only reject
            # it a second time, which is the whole reason this flag exists.
            if row.get("forced"):
                sb.table("pipeline_videos").update({
                    "status": "approved",
                    "local_path": str(out),
                    "triage_notes": "forced in by the owner — triage bypassed",
                }).eq("video_id", vid).execute()
                kept += 1
                continue

            # The ears go first, and they are free. A video with no
            # gunshot-shaped sound in it cannot be shooting footage —
            # whatever its thumbnails look like — and it dies here without
            # costing a single Claude token. The count also rides along in
            # the notes for every video that passes.
            from clipper import extract_audio, detect_shots
            with tempfile.TemporaryDirectory() as td:
                wav = Path(td) / "a.wav"
                extract_audio(out, wav)
                shot_times = detect_shots(wav)
                # The clip stage's threshold is tuned tight for a precise
                # cut point; here it only needs to answer yes/no, and a shot
                # too quiet or distant to clear it would otherwise sink the
                # whole video with no recourse. One retry, looser, before
                # calling it silent.
                if not shot_times:
                    shot_times = detect_shots(wav, k_mad=6.0)
            shots_heard = len(shot_times)
            if shots_heard == 0:
                sb.table("pipeline_videos").update({
                    "status": "rejected",
                    "triage_score": 0,
                    "triage_notes": "no gunshots heard — dropped before scoring",
                }).eq("video_id", vid).execute()
                out.unlink(missing_ok=True)
                dropped += 1
                continue

            # The ears aim the eyes: frames taken just after known bangs
            # have clays airborne by construction, where the even spread
            # could land on walking, talking and reloading — and fail a
            # video full of shooting.
            from triage import sample_frames_at
            with tempfile.TemporaryDirectory() as td:
                frames = (sample_frames_at(out, Path(td), shot_times)
                          or sample_frames(out, Path(td)))
                r = score_frames(frames)
            # A passing score without a clay in sight keeps nothing: the
            # judge is asked both questions, and the whole dataset is clays.
            keep = r["score"] >= KEEP_THRESHOLD and bool(r.get("clays_visible"))
            # 'downloaded' means triaged and waiting on a human in the review
            # queue. Only 'approved' reaches the clip stage.
            sb.table("pipeline_videos").update({
                "status": "downloaded" if keep else "rejected",
                "triage_score": r["score"],
                # The camera gets its own column as well as the note: the
                # deployed model watches POV hardware, so what the training
                # footage was shot on is something to group and count by,
                # not a string to read.
                "camera": r.get("camera") or None,
                "triage_notes": f"[{r.get('camera', '?')}] {shots_heard} shots heard · {r.get('notes', '')}",
                "triage_in_tokens": r.get("in_tokens"),
                "triage_out_tokens": r.get("out_tokens"),
                "weather": r.get("weather"),
                "criteria": r.get("criteria") or None,
                "local_path": str(out) if keep else None,
            }).eq("video_id", vid).execute()
            if not keep:
                out.unlink(missing_ok=True)
            kept, dropped = kept + keep, dropped + (not keep)
        except Exception as e:  # noqa: BLE001
            # An outage is not the video's fault. A dead key or a spent
            # balance would otherwise burn one video per attempt — fifty-nine
            # of them, once — so the run stops and leaves the queue intact
            # for whenever the account is topped up.
            s = str(e).lower()
            if any(w in s for w in ("credit", "billing", "quota",
                                    "authentication", "401", "invalid x-api-key")):
                sb.table("pipeline_videos").update(
                    {"triage_notes": "waiting on the Anthropic account: "
                                     f"{str(e)[:300]}"}
                ).eq("video_id", vid).execute()
                volume.commit()
                return _noted(sb, {"stage": "triage", "examined": len(rows),
                        "kept": kept, "dropped": dropped, "errors": failed,
                        "stopped": "the Anthropic account is not answering — "
                                   "nothing was marked errored, the queue is intact"}, "bad")
            sb.table("pipeline_videos").update(
                {"status": "error", "triage_notes": str(e)[:500]}
            ).eq("video_id", vid).execute()
            failed += 1
    volume.commit()
    return _noted(sb, {"stage": "triage", "examined": len(rows),
            "kept": kept, "dropped": dropped, "errors": failed})


# ---------------------------------------------------------------- clip

@app.function(image=base_image, secrets=[secret], timeout=1800,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def clip(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    from pathlib import Path
    from clipper import extract_audio, detect_shots, group_bursts, cut_clip
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
        # The split judge deals the whole scene — channel when known, the
        # video alone otherwise — and every clip cut here inherits the deal.
        # Recomputed each time rather than cached: the maths is deterministic,
        # so this is idempotent, and it self-heals rows dealt before the
        # judge learned about channels.
        key = (row.get("channel") or "").strip() or row["video_id"]
        split = _split(key)
        hold = split == "test"
        sb.table("pipeline_videos").update(
            {"holdout": hold, "rf_split": split}
        ).eq("video_id", row["video_id"]).execute()

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
        specs = group_bursts(shots)
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
                "n_shots": spec["n_shots"],
                "shot_offsets": spec["shot_offsets"],
                "file_path": str(out),
                "label_status": "raw",   # screening promotes clay-bearing cuts to pending
                "holdout": bool(hold),
                "rf_split": split,
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
    # Rejected clips get previews too: the owner audits the machine's
    # discards on the Triage page, and a discard you cannot watch is a
    # verdict you cannot check.
    todo = (sb.table("pipeline_clips").select("clip_id,file_path,preview_path,poster_path")
            .in_("label_status", ["pending", "queued", "rejected"])
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

    return _noted(sb, {"stage": "clip", "videos": len(rows), "clips_created": made,
            "previews_made": previewed, "errors": failed})


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
    # ?limit= for manual pushes through a big backlog; the heartbeat's
    # default of 10 stays comfortably inside the GPU timeout.
    limit = min(int(request.query_params.get("limit", 10)), 20)
    rows = (sb.table("pipeline_clips").select("*")
            .eq("label_status", "raw").limit(limit).execute().data)
    if not rows:
        return {"stage": "screen", "processed": 0}

    # Our own detector if one has been trained, Grounding DINO if not. The
    # trained model is both better on this narrow subject and far cheaper —
    # a small YOLO at these sizes runs orders of magnitude faster than the
    # zero-shot transformer, which is what makes scoring new footage as it
    # arrives affordable rather than a GPU bill. DETECTOR=dino in the secret
    # forces the old path back for a comparison.
    yolo = None
    if os.environ.get("DETECTOR", "auto") != "dino":
        best = _latest_weights(sb)
        if best:
            from ultralytics import YOLO
            yolo = YOLO(best)
            print(f"[screen] detecting with {best}")
    device = "cuda"
    proc = gdino = None
    if yolo is None:
        proc = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
        gdino = AutoModelForZeroShotObjectDetection.from_pretrained(
            "IDEA-Research/grounding-dino-base").to(device)

    done = kept = 0
    for row in rows:
      try:
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
          if yolo is not None:
              # Batched, and at the size it was trained on: a clay is a few
              # pixels, and letting the default shrink the frame to 640
              # throws away the very thing being looked for.
              imgsz = int(os.environ.get("DETECT_IMGSZ", 960))
              for s in range(0, len(frames), 16):
                  chunk = frames[s:s + 16]
                  for j, r in enumerate(yolo.predict(chunk, conf=thresh,
                                                     imgsz=imgsz, verbose=False)):
                      bs = [{"xyxy": list(map(float, b)), "conf": float(c)}
                            for b, c in zip(r.boxes.xyxy.cpu().tolist(),
                                            r.boxes.conf.cpu().tolist())]
                      if bs:
                          boxes_per_frame[s + j] = bs
          else:
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

          # Drop anything that never actually moved — a ShotKam reticle or
          # any other fixed overlay reads as a small disc to the detector
          # every frame, and left in, it would out-stay the real clay in
          # every downstream step: trim, det_conf, and the boxes shipped to
          # Roboflow as ground truth. What survives is scored up by speed.
          boxes_per_frame = _clay_track(
              boxes_per_frame, frames[0].shape[1] if frames else 0)

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
          # Generous padding, especially after: the track's end is not the
          # story's end — fragments fall, the bird sails on — and a cut that
          # feels two seconds premature reads as broken to the owner.
          pad_pre = float(os.environ.get("TRIM_PRE", 0.5))
          pad_post = float(os.environ.get("TRIM_POST", 2.0))
          t0 = max(0.0, first_i * step / fps - pad_pre)
          t1 = min(clip_len, last_i * step / fps + pad_post)
          new_start = float(row["clip_start"]) + t0
          new_end = float(row["clip_start"]) + t1
          pv = row.get("preview_path") or f"previews/{row['clip_id']}.mp4"
          po = row.get("poster_path") or f"previews/{row['clip_id']}.jpg"
          trimmed_now = t0 > 0.6 or t1 < clip_len - 0.6
          if trimmed_now:
              trimmed = Path("/tmp") / f"trim_{row['clip_id']}.mp4"
              sp.run(["ffmpeg", "-y", "-ss", f"{t0:.2f}", "-to", f"{t1:.2f}",
                      "-i", path, "-c:v", "libx264", "-preset", "veryfast",
                      "-crf", "23", "-c:a", "aac", str(trimmed)],
                     check=True, capture_output=True)
              Path(path).write_bytes(trimmed.read_bytes())
              trimmed.unlink()
          # Render whenever the pixels changed OR nothing has ever been
          # rendered for this clip. Rendering only on a trim left every cut
          # that needed no trimming with no preview at all — promoted to the
          # check queue as an unwatchable black card, waiting on a clip-stage
          # backfill that only runs when the clip stage runs. A clip nobody
          # can watch cannot be checked, which is the whole job of the page.
          needs_render = trimmed_now or not row.get("preview_path") or not row.get("poster_path")
          if needs_render:
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
              "t_offset": t0 if trimmed_now else 0.0,
          }).execute()

          # The verdict: did the clay break? Four frames straddling the shot —
          # a hit fragments and vanishes in a puff, a miss keeps flying. The
          # boxes say where the clay is, and now they aim the judge's eye:
          # each frame is cropped around the tracked clay before Sonnet sees it.
          verdicts = _judge_burst(row, frames, fps, step, boxes_per_frame)

          metrics = _shot_metrics(
              float(row["shot_ts"]) - float(row["clip_start"]),
              boxes_per_frame, step / fps,
              frames[0].shape[1] if frames else 0, verdicts.get("outcome"))

          update = {"label_status": "pending",
                    "clip_start": new_start, "clip_end": new_end,
                    "shot_type": _shot_type(
                        boxes_per_frame,
                        frames[0].shape[1] if frames else 0,
                        frames[0].shape[0] if frames else 0),
                    **verdicts, **metrics}
          # Only claim a preview that was actually rendered. Stamping the path
          # without the file behind it is how 143 clips once became unwatchable:
          # the backfill saw a non-null path and skipped them forever.
          if needs_render:
              update["preview_path"] = pv
              update["poster_path"] = po
          sb.table("pipeline_clips").update(update).eq(
              "clip_id", row["clip_id"]).execute()
          done += 1
          kept += 1
      except Exception as e:  # noqa: BLE001
        # One unreadable cut must never wedge the whole stage: park it in
        # the discard pile — visible, auditable, send-back-able — and move
        # on. Before this, a single corrupt file stopped screening for good.
        print(f"[screen] {row.get('clip_id')} failed: {e}")
        sb.table("pipeline_clips").update(
            {"label_status": "rejected"}).eq("clip_id", row["clip_id"]).execute()

    volume.commit()   # the trims rewrote clip files on the volume
    _flush_usage(sb, "screen")
    return _noted(sb, {"stage": "screen", "processed": done, "kept": kept})


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
    limit = min(int(request.query_params.get("limit", 25)), 50)
    rows = (sb.table("pipeline_clips").select("*")
            .eq("label_status", "queued").limit(limit).execute().data)
    if not rows:
        return {"stage": "prelabel", "processed": 0, "uploaded": 0}

    from roboflow import Roboflow
    rf = Roboflow(api_key=os.environ["ROBOFLOW_API_KEY"])
    project = rf.workspace().project(os.environ["ROBOFLOW_PROJECT"])

    sure = float(os.environ.get("AUTO_ACCEPT", 0.55))
    # The mastersheet's conditions ride along as Roboflow tags. They are not
    # training signal — a detector learns from pixels and boxes alone — but
    # they are what makes accuracy measurable per condition rather than as
    # one meaningless average: 94% on clear sky and 71% on overcast is a
    # sourcing instruction; 89% overall is not.
    vids = {}
    try:
        ids = list({r["video_id"] for r in rows})
        vids = {v["video_id"]: v for v in
                (sb.table("pipeline_videos").select("video_id,weather,ds_level,camera")
                 .in_("video_id", ids).execute().data or [])}
    except Exception as e:  # noqa: BLE001 — tags are a nicety, never a blocker
        print(f"[prelabel] could not read video conditions: {e}")

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
        # The split judge dealt every video once: test is the golden ruler
        # (human-verified, never trained on), valid tunes training runs, and
        # only train may auto-accept — the sets the model is measured and
        # steered by deserve human-checked boxes, whatever the confidence.
        split = row.get("rf_split") or ("test" if row.get("holdout") else "train")
        golden = split == "test"
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
            confident = (split == "train") and (
                all(b["conf"] >= sure for b in bxs) if bxs else False)
            all_confident = all_confident and confident
            tags = ["prelabel", "confident" if confident else "doubtful", split]
            if golden:
                tags.append("golden")
            if row.get("slo_mo"):
                tags.append("slo-mo")
            vid = vids.get(row["video_id"]) or {}
            if vid.get("weather") and vid["weather"] != "unknown":
                tags.append(f"weather-{vid['weather']}")
            if vid.get("ds_level"):
                tags.append(f"level-{vid['ds_level']}")
            if row.get("clay_colour") and row["clay_colour"] != "unknown":
                tags.append(f"clay-{row['clay_colour']}")
            if vid.get("camera"):
                tags.append(f"camera-{vid['camera']}")
            if row.get("shot_type"):
                tags.append(f"shot-{row['shot_type']}")
            project.upload(str(fp), annotation_path=str(ann),
                           split=split,
                           batch_name=("golden-holdout" if golden
                                       else "valid-check" if split == "valid"
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
                 else "valid-check" if split == "valid"
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

    return _noted(sb, {"stage": "prelabel", "processed": done,
            "frames_uploaded": uploaded, "errors": failed})


# ---------------------------------------------------------------- recut

# Cut a clip again between the boundaries a person set by hand.
#
# The clipper cuts on sound alone, which cannot know that a clay left the
# frame and came back, or that the bang it heard belonged to the second of
# two presentations. When the eye disagrees, the portal writes the new
# clip_start/clip_end and raises needs_recut; this makes the cut real.
#
# The source video is required — the clip file on the volume is already
# trimmed, so it can be shortened but never lengthened from itself. If the
# source has been pruned it is fetched again from its URL.
@app.function(image=base_image, secrets=[secret], timeout=3600,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def recut(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import subprocess as sp
    import tempfile
    from pathlib import Path

    volume.reload()
    sb = _sb()
    limit = min(int(request.query_params.get("limit", 20) or 20), 100)
    rows = (sb.table("pipeline_clips").select("*")
            .eq("needs_recut", True).limit(limit).execute().data or [])
    if not rows:
        return {"stage": "recut", "processed": 0}

    vids = {}
    try:
        ids = list({r["video_id"] for r in rows})
        vids = {v["video_id"]: v for v in
                (sb.table("pipeline_videos").select("video_id,url,local_path")
                 .in_("video_id", ids).execute().data or [])}
    except Exception as e:  # noqa: BLE001
        print(f"[recut] could not read the source list: {e}")

    done = failed = refetched = 0
    for row in rows:
      try:
        vid = vids.get(row["video_id"]) or {}
        src = Path(vid.get("local_path") or "")
        if not src.exists():
            # The source was pruned after clipping. Fetch it again rather
            # than refuse the edit — the owner has already decided.
            src = Path(MEDIA) / "videos" / f"{row['video_id']}.mp4"
            src.parent.mkdir(parents=True, exist_ok=True)
            if not src.exists():
                url = vid.get("url") or f"https://www.youtube.com/watch?v={row['video_id']}"
                _fetch_video(url, src)
                refetched += 1
            sb.table("pipeline_videos").update(
                {"local_path": str(src)}).eq("video_id", row["video_id"]).execute()

        start = max(0.0, float(row["clip_start"]))
        end = float(row["clip_end"])
        if end - start < 0.4:
            raise ValueError(f"a {end - start:.2f}s clip is not a clip")

        out = Path(row["file_path"] or (Path(MEDIA) / "clips" / f"{row['clip_id']}.mp4"))
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = Path("/tmp") / f"recut_{row['clip_id']}.mp4"
        sp.run(["ffmpeg", "-y", "-ss", f"{start:.2f}", "-to", f"{end:.2f}",
                "-i", str(src), "-c:v", "libx264", "-preset", "fast",
                "-crf", "20", "-c:a", "aac", str(tmp)],
               check=True, capture_output=True)
        out.write_bytes(tmp.read_bytes())
        tmp.unlink(missing_ok=True)

        # New pixels, so the preview, the poster and every stored box are
        # all stale. Re-render the two and throw the boxes away: screening
        # draws them again on the next beat, against the footage that now
        # actually exists. Anything less would leave boxes pointing at
        # frames that have moved.
        pv = row.get("preview_path") or f"previews/{row['clip_id']}.mp4"
        po = row.get("poster_path") or f"previews/{row['clip_id']}.jpg"
        small = Path("/tmp") / f"pv_{row['clip_id']}.mp4"
        sp.run(["ffmpeg", "-y", "-i", str(out), "-vf", "scale=-2:480",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
                "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart",
                str(small)], check=True, capture_output=True)
        sb.storage.from_("clips").upload(pv, small.read_bytes(),
            {"content-type": "video/mp4", "upsert": "true"})
        small.unlink(missing_ok=True)
        still = Path("/tmp") / f"po_{row['clip_id']}.jpg"
        sp.run(["ffmpeg", "-y", "-ss", "0.5", "-i", str(out), "-frames:v", "1",
                "-vf", "scale=-2:480", "-q:v", "5", str(still)],
               check=True, capture_output=True)
        sb.storage.from_("clips").upload(po, still.read_bytes(),
            {"content-type": "image/jpeg", "upsert": "true"})
        still.unlink(missing_ok=True)

        try:
            sb.table("pipeline_labels").delete().eq("clip_id", row["clip_id"]).execute()
        except Exception as e:  # noqa: BLE001 — stale boxes, not a blocker
            print(f"[recut] could not clear boxes for {row['clip_id']}: {e}")

        sb.table("pipeline_clips").update({
            "needs_recut": False,
            "label_status": "raw",     # screening re-boxes and re-judges it
            "preview_path": pv, "poster_path": po,
            "outcome": None, "outcome_conf": None,
            "outcome_2": None, "outcome_2_conf": None,
            "outcome_3": None, "outcome_3_conf": None,
            "outcomes": [], "det_conf": None,
            "range_m": None, "speed_mph": None,
        }).eq("clip_id", row["clip_id"]).execute()
        done += 1
      except Exception as e:  # noqa: BLE001
        # Leave the flag up so the next run tries again, and say why.
        print(f"[recut] {row.get('clip_id')} failed: {e}")
        try:
            sb.table("pipeline_clips").update(
                {"recut_note": f"recut failed: {e}"[:400]}
            ).eq("clip_id", row["clip_id"]).execute()
        except Exception:  # noqa: BLE001
            pass
        failed += 1

    volume.commit()
    return _noted(sb, {"stage": "recut", "processed": done,
                       "refetched_sources": refetched, "errors": failed})


# ---------------------------------------------------------------- dataset

# Build a YOLO training set on the volume from the boxes we already hold.
# Everything here comes out of pipeline_labels and the clip files — Roboflow
# is not consulted and not required.
#
# The stored boxes are raw detector output, drawn before the fixed-overlay
# filter existed, so the reticle is in there. Running every clip's boxes back
# through _clay_track on the way out cleans the whole back catalogue without
# spending a second of GPU re-detecting it: the same pass that will keep new
# footage clean also retro-fits the old.
@app.function(image=base_image, secrets=[secret], timeout=7200,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def dataset(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import cv2
    import shutil
    from pathlib import Path

    volume.reload()
    q = request.query_params
    name = "".join(c for c in q.get("name", "brace") if c.isalnum() or c in "-_") or "brace"
    # Keep one detected frame in every N. Consecutive frames at 30fps are
    # nearly the same picture; each one kept is training time spent teaching
    # the model nothing new and another chance to overfit a single flight.
    # 15 against the usual 30fps detection lands about two frames a second.
    every = max(1, int(q.get("every", 15) or 15))
    # Only boxes the detector was reasonably sure of become ground truth.
    floor = float(q.get("conf", 0.35) or 0.35)
    # ?phases=1 builds the set from the foundation rung alone; ?phases=1,2
    # adds the next layer. This is how the ladder is actually climbed —
    # train on the easy footage, measure, add a rung, measure again, and
    # watch whether the score moved. Absent, everything is included.
    want = {int(x) for x in (q.get("phases") or "").replace(" ", "").split(",") if x.isdigit()}

    sb = _sb()
    rows = (sb.table("pipeline_clips")
            .select("clip_id,video_id,file_path,rf_split,holdout,label_status,"
                    "clay_colour,weather,slo_mo,range_m,speed_mph,background")
            .in_("label_status", ["pending", "queued", "prelabelled"])
            .limit(5000).execute().data or [])
    if want:
        # The same rule the portal counts by, so a set built for phase 1 holds
        # exactly the clips Findings calls phase 1 — no second definition to
        # drift out of step with the first.
        vids = {}
        try:
            ids = list({r["video_id"] for r in rows})
            for i in range(0, len(ids), 200):
                for v in (sb.table("pipeline_videos")
                          .select("video_id,weather,ds_level")
                          .in_("video_id", ids[i:i + 200]).execute().data or []):
                    vids[v["video_id"]] = v
        except Exception as e:  # noqa: BLE001
            print(f"[dataset] could not read video conditions: {e}")
        rows = [r for r in rows if _phase_of(r, vids.get(r["video_id"]) or {}) in want]
        if not rows:
            return {"stage": "dataset", "clips": 0, "images": 0,
                    "detail": f"no clips on phase{'s' if len(want) > 1 else ''} "
                              + ",".join(str(x) for x in sorted(want))}
    if not rows:
        return {"stage": "dataset", "clips": 0, "images": 0}

    root = Path(DATASETS) / name
    if root.exists():
        shutil.rmtree(root)      # a rebuild is a rebuild, not a merge
    for split in ("train", "valid", "test"):
        (root / "images" / split).mkdir(parents=True, exist_ok=True)
        (root / "labels" / split).mkdir(parents=True, exist_ok=True)

    counts = {"train": 0, "valid": 0, "test": 0}
    empties = clips_used = 0
    for row in rows:
      try:
        src = Path(row["file_path"] or "")
        if not src.exists():
            continue
        lab = (sb.table("pipeline_labels").select("boxes_json,frame_dt,t_offset")
               .eq("clip_id", row["clip_id"]).execute().data)
        if not lab or not lab[0].get("boxes_json"):
            continue
        frame_dt = float(lab[0].get("frame_dt") or 0.2)
        t_off = float(lab[0].get("t_offset") or 0.0)
        boxes = {int(k): v for k, v in lab[0]["boxes_json"].items()}

        cap = cv2.VideoCapture(str(src))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        if not width:
            cap.release()
            continue
        boxes = _clay_track(boxes, width)     # the reticle dies here
        if not boxes:
            cap.release()
            continue

        split = row.get("rf_split") or ("test" if row.get("holdout") else "train")
        if split not in counts:
            split = "train"
        for i in sorted(boxes)[::every]:
            t = i * frame_dt - t_off
            if t < 0:
                continue
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok:
                continue
            keep = [b for b in boxes[i] if b.get("conf", 0) >= floor]
            if not keep:
                continue
            h, w = frame.shape[:2]
            lines = []
            for b in keep:
                x1, y1, x2, y2 = b["xyxy"]
                cx, cy = (x1 + x2) / 2 / w, (y1 + y2) / 2 / h
                bw, bh = (x2 - x1) / w, (y2 - y1) / h
                if bw <= 0 or bh <= 0:
                    continue
                lines.append(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
            if not lines:
                empties += 1
                continue
            stem = f"{row['clip_id']}_{i:05d}"
            cv2.imwrite(str(root / "images" / split / f"{stem}.jpg"), frame)
            (root / "labels" / split / f"{stem}.txt").write_text("\n".join(lines))
            counts[split] += 1
        cap.release()
        clips_used += 1
      except Exception as e:  # noqa: BLE001 — one bad clip is not the set
        print(f"[dataset] {row.get('clip_id')} skipped: {e}")

    (root / "data.yaml").write_text(
        f"path: {root}\ntrain: images/train\nval: images/valid\n"
        f"test: images/test\nnames:\n  0: clay\n")
    volume.commit()
    return _noted(sb, {"stage": "dataset", "name": name, "clips": clips_used,
                       "train": counts["train"], "valid": counts["valid"],
                       "test": counts["test"], "empty_frames": empties})


# ---------------------------------------------------------------- train

# Fine-tune a detector on our own boxes. An A10G rather than the T4 the
# screening runs on: training is the one job here worth the faster card,
# and it is charged by the second, so the quicker run is also the cheaper.
@app.function(image=gpu_image, secrets=[secret], gpu="A10G", timeout=14400,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def train(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import os
    from pathlib import Path

    volume.reload()
    q = request.query_params
    name = "".join(c for c in q.get("name", "brace") if c.isalnum() or c in "-_") or "brace"
    root = Path(DATASETS) / name
    data = root / "data.yaml"
    if not data.exists():
        return fastapi.responses.JSONResponse(
            {"error": f"no dataset called {name} — run the dataset stage first"},
            status_code=400)

    n_train = len(list((root / "images" / "train").glob("*.jpg")))
    n_valid = len(list((root / "images" / "valid").glob("*.jpg")))
    n_test = len(list((root / "images" / "test").glob("*.jpg")))
    if not n_train:
        return fastapi.responses.JSONResponse(
            {"error": "the training split is empty"}, status_code=400)
    # Ultralytics validates against 'val' every epoch and would fall over on
    # an empty one. A set too small to have been dealt a valid split trains
    # against itself — honest, and the numbers are marked untrustworthy.
    if not n_valid:
        return fastapi.responses.JSONResponse(
            {"error": "the valid split is empty — no honest score can come out "
                      "of this run. Clip more videos, or re-deal the splits."},
            status_code=400)

    # A clay is a handful of pixels at forty yards, so the image size matters
    # more here than the model size: shrinking to the usual 640 throws away
    # the object we are trying to find. Small model, large canvas.
    base = q.get("base", "yolo11s.pt")
    epochs = max(1, min(int(q.get("epochs", 80) or 80), 400))
    imgsz = max(320, min(int(q.get("imgsz", 960) or 960), 1536))

    from ultralytics import YOLO
    model = YOLO(base)
    model.train(data=str(data), epochs=epochs, imgsz=imgsz,
                project=str(Path(MODELS) / name), name="run",
                exist_ok=True, patience=25, verbose=False)
    metrics = model.val(data=str(data), imgsz=imgsz, verbose=False)

    out_dir = Path(MODELS) / name / "run" / "weights"
    best = out_dir / "best.pt"
    box = getattr(metrics, "box", None)
    row = {
        "name": name, "base": base, "epochs": epochs, "imgsz": imgsz,
        "n_train": n_train, "n_valid": n_valid, "n_test": n_test,
        "map50": float(getattr(box, "map50", 0) or 0),
        "map5095": float(getattr(box, "map", 0) or 0),
        "precision_": float(getattr(box, "mp", 0) or 0),
        "recall": float(getattr(box, "mr", 0) or 0),
        "weights_path": str(best) if best.exists() else None,
    }
    volume.commit()
    sb = _sb()
    try:
        sb.table("pipeline_models").insert(row).execute()
    except Exception as e:  # noqa: BLE001 — the weights are the deliverable
        print(f"[train] could not record the run: {e}")
    return _noted(sb, {"stage": "train", **row})


MAX_CLAYS = 8   # a flush, not a pair — mirrored in portal/portal.js


def _phase_of(clip, video):
    """Which rung of the ladder a clip sits on.

    The same rule as clip_phase() in the database, kept in step by hand
    because the dataset builder cannot call it: one phase per clip, first
    match wins, hardest first — the hardest thing in the frame is what the
    model has to survive, so a black clay in fog is hard light rather than
    dark clays. Phases 5 and 8 need a person's word; 5 arrives once a
    background is recorded, 8 only ever by stamping.
    """
    stamped = video.get("ds_level")
    if isinstance(stamped, int) and 1 <= stamped <= 8:
        return stamped
    clay = clip.get("clay_colour")
    wx = clip.get("weather") or video.get("weather")
    rng, mph = clip.get("range_m"), clip.get("speed_mph")
    bg = clip.get("background")
    if wx in ("rain", "dusk", "fog", "low_light", "low light"):
        return 7
    if (rng or 0) >= 35 or (mph or 0) >= 60:
        return 6
    if bg in ("treeline", "hillside", "valley", "ground", "cluttered", "buildings", "mixed"):
        return 5
    if wx == "overcast":
        return 4
    if clay in ("black", "blaze", "white", "midi"):
        return 3
    if clip.get("slo_mo"):
        return 1
    if clay == "orange" and wx == "clear" and (rng or 0) < 25:
        return 1
    if clay == "orange":
        return 2
    if wx == "clear":
        return 2
    return 0


def _shot_track(boxes_per_frame, shot_i, frame_w, frame_dt):
    """The one clay this bang was aimed at, followed across the whole burst.

    The judge used to crop each frame around whatever box scored highest in
    that frame alone. With a single clay in the sky that is the clay. With a
    pair or a flush it is whichever bird happened to read strongest at that
    instant, so the crop jumped from one clay to another between frames, the
    model was shown A, then B, then A, and it answered — correctly — that it
    could not follow the clay. Pairs were coming back unclear three-fifths of
    the time against a third for singles, on identical detection confidence:
    the eye was being thrown, not the detector.

    So boxes are linked into tracks and one track is chosen for this bang.
    Alive at the moment of the shot beats everything, because that is the
    clay being fired at; among those, the one covering the most ground wins,
    a clay outrunning anything static that survived the overlay filter.
    Gaps inside the chosen track are filled by interpolation, so a frame the
    detector missed still crops to where the clay must have been rather than
    falling back to the full picture.

    Returns {frame index: (cx, cy, size)} for the chosen clay alone.
    """
    import math

    idxs = sorted(boxes_per_frame)
    if not idxs:
        return {}
    cen = lambda b: ((b["xyxy"][0] + b["xyxy"][2]) / 2.0,
                     (b["xyxy"][1] + b["xyxy"][3]) / 2.0)
    size = lambda b: max(b["xyxy"][2] - b["xyxy"][0], b["xyxy"][3] - b["xyxy"][1])

    # A more forgiving gap than the screening tracker uses. There the point
    # is a precise flight boundary; here it is keeping one clay together
    # across the frames the detector happened to miss, and splitting it in
    # two would put the crop back to guessing.
    max_gap = max(3, int(round(0.4 / max(frame_dt, 1e-6))))
    max_jump, tracks = frame_w * 0.12, []
    for i in idxs:
        for b in boxes_per_frame[i]:
            cx, cy = cen(b)
            best_t, best_d = None, None
            for t in tracks:
                if i - t["last"] > max_gap:
                    continue
                lx, ly = t["pts"][-1][1], t["pts"][-1][2]
                d = math.hypot(cx - lx, cy - ly)
                if d <= max_jump and (best_d is None or d < best_d):
                    best_t, best_d = t, d
            if best_t is None:
                best_t = {"last": i, "pts": []}
                tracks.append(best_t)
            best_t["pts"].append((i, cx, cy, size(b)))
            best_t["last"] = i
    if not tracks:
        return {}

    # The impact window: the bang, then the tenth to quarter second the
    # pellets take to arrive and the moment of the break.
    lo, hi = shot_i - int(round(0.3 / frame_dt)), shot_i + int(round(0.9 / frame_dt))

    def score(t):
        pts = t["pts"]
        # Weighted by nearness to the bang, not merely counted inside the
        # window. A clay that happens to be in the sky for the whole clip
        # would otherwise out-vote the one actually being fired at simply by
        # lasting longer — which is how the first barrel of a pair ended up
        # judged on the second bird.
        near = sum(1.0 / (1.0 + abs(p[0] - shot_i) * frame_dt / 0.2)
                   for p in pts if lo <= p[0] <= hi)
        # The strongest tell of which clay this barrel was for: a clay that
        # was hit stops existing. A track that ends inside the impact window
        # died there, and a bird still sailing at the end of the clip did
        # not. With two clays in the sky at the same instant nothing else
        # separates them — both are simply present — so this is what decides
        # it, and density only breaks the tie.
        died_here = bool(pts) and lo <= pts[-1][0] <= hi
        travel = 0.0
        for a, b in zip(pts, pts[1:]):
            travel += math.hypot(b[1] - a[1], b[2] - a[2])
        return (died_here, round(near, 3), travel)

    best = max(tracks, key=score)
    # Presence decides whether there is anything to aim at, not whether it
    # died: a missed clay sails on to the end of the clip and is exactly the
    # thing the judge most needs to see.
    if not score(best)[1]:
        return {}          # nothing alive at this bang — let the judge see wide

    known = {p[0]: (p[1], p[2], p[3]) for p in best["pts"]}
    if len(known) < 2:
        return known
    # Fill the gaps the detector left, so a missed frame still crops to the
    # clay's path instead of throwing the whole frame at the model.
    have = sorted(known)
    out = dict(known)
    for a, b in zip(have, have[1:]):
        if b - a < 2:
            continue
        (ax, ay, asz), (bx, by, bsz) = known[a], known[b]
        for i in range(a + 1, b):
            f = (i - a) / (b - a)
            out[i] = (ax + (bx - ax) * f, ay + (by - ay) * f, asz + (bsz - asz) * f)
    return out


def _judge_burst(row, frames, fps, step, boxes_per_frame):
    """One verdict per bang in the burst.

    The bangs' distances from the first ride on the clip as shot_offsets;
    older rows fall back to pair_gap_s, and a single is just offset zero.
    Each bang gets its own impact window and its own crop aim.

    Every verdict goes into the outcomes array, however many there are — a
    five-bird flush was being judged three times and the rest thrown away.
    The first three are copied into their own columns as well, because the
    mastersheet, the CSV export and the trials all still read them.
    """
    offsets = row.get("shot_offsets") or (
        [0.0, float(row["pair_gap_s"])]
        if row.get("is_pair") and row.get("pair_gap_s") else [0.0])
    cols = {"outcome": None, "outcome_conf": None,
            "outcome_2": None, "outcome_2_conf": None,
            "outcome_3": None, "outcome_3_conf": None,
            "clay_colour": None}
    names = [("outcome", "outcome_conf"), ("outcome_2", "outcome_2_conf"),
             ("outcome_3", "outcome_3_conf")]
    verdicts = []
    for n, off in enumerate(offsets[:MAX_CLAYS]):
        o, c, colour = _judge_shot(row, frames, fps, step, boxes_per_frame,
                                   extra_offset=float(off))
        verdicts.append({"o": o, "c": c})
        if n < len(names):
            oc, cc = names[n]
            cols[oc], cols[cc] = o, c
        # the first confident read of the disc's colour names the clip
        if colour and colour != "unknown" and not cols["clay_colour"]:
            cols["clay_colour"] = colour
    cols["outcomes"] = verdicts
    return cols


def _ask_gemini(model, system, blocks):
    """The same verdict conversation, spoken to Google's API.

    Translates the Anthropic-shaped blocks (text + base64 images) into
    Gemini's parts. Needs GEMINI_API_KEY in the brace-pipeline secret.
    """
    import os
    import requests

    parts = []
    for b in blocks:
        if b["type"] == "text":
            parts.append({"text": b["text"]})
        else:
            parts.append({"inline_data": {
                "mime_type": b["source"]["media_type"],
                "data": b["source"]["data"]}})
    r = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"],
                 "content-type": "application/json"},
        json={"system_instruction": {"parts": [{"text": system}]},
              "contents": [{"role": "user", "parts": parts}],
              "generationConfig": {"maxOutputTokens": 300}},
        timeout=120)
    r.raise_for_status()
    data = r.json()
    # Bench runs cost real money too. Without this a Gemini A/B recorded
    # nothing and read as free next to the Anthropic model it was being
    # compared against — the one comparison the trial exists to make.
    um = data.get("usageMetadata") or {}
    _USAGE.append((model, um.get("promptTokenCount", 0),
                   um.get("candidatesTokenCount", 0)))
    return "".join(p.get("text", "")
                   for c in data.get("candidates", [])[:1]
                   for p in c.get("content", {}).get("parts", []))


def _shot_type(boxes_per_frame, frame_w, frame_h):
    """Name the presentation from the tracked flight: what a coach would
    call it. Pure geometry on boxes the screen already drew — no model,
    no tokens. Horizontal travel makes a crosser (and its direction),
    vertical makes a riser or a dropper, and when the clay barely moves
    across the frame its size change tells incomer from going-away.
    """
    if not boxes_per_frame or not frame_w or not frame_h:
        return None
    pts = []
    for i in sorted(boxes_per_frame):
        bs = boxes_per_frame[i]
        if not bs:
            continue
        b = max(bs, key=lambda x: x.get("conf", 0))["xyxy"]
        pts.append(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2,
                    max(1.0, (b[2] - b[0]) * (b[3] - b[1]))))
    if len(pts) < 3:
        return None
    (x0, y0, a0), (x1, y1, a1) = pts[0], pts[-1]
    # Ends can be noisy single detections; average a small head and tail.
    head = pts[:max(1, len(pts) // 4)]
    tail = pts[-max(1, len(pts) // 4):]
    x0 = sum(p[0] for p in head) / len(head); y0 = sum(p[1] for p in head) / len(head)
    a0 = sum(p[2] for p in head) / len(head)
    x1 = sum(p[0] for p in tail) / len(tail); y1 = sum(p[1] for p in tail) / len(tail)
    a1 = sum(p[2] for p in tail) / len(tail)
    dx = (x1 - x0) / frame_w
    dy = (y1 - y0) / frame_h          # screen y grows downward
    grow = a1 / a0 if a0 else 1.0
    if abs(dx) > 0.22:
        return "crosser-lr" if dx > 0 else "crosser-rl"
    if dy < -0.18:
        return "rising"
    if dy > 0.18:
        return "dropping"
    if grow > 1.7:
        return "incomer"
    if grow < 0.55:
        return "going-away"
    return "quartering"


def _clay_track(boxes_per_frame, frame_w):
    """Enforces one rule: only a moving clay may reach the trim, the metrics
    or a Roboflow annotation. Nothing fixed in the frame — a reticle, a red
    dot, any burned-in overlay — gets to call itself a clay.

    Grounding DINO runs blind, frame by frame — it has no memory that a red
    crosshair dead-centre of the picture is a ShotKam reticle, not a clay,
    and "small orange disc. small black disc" matches both once the
    reticle's centre dot is on-target. Two independent checks enforce the
    rule, because a short clip may not hand the second one enough frames to
    work with:

    1. A burned-in graphic redraws at the exact same pixel spot every time
       it appears — no optical read on a moving clay is ever that precise
       twice, even between two frames far apart in the clip. Every box is
       clustered against the others sitting within a couple of pixels of
       it; a cluster a second frame lands in is the graphic, and every box
       in it is discarded outright, before tracking ever runs.
    2. What is left is linked frame-to-frame into tracks by nearest
       centroid, and any track that sits across a real stretch of the clip
       while barely drifting is dropped too — the same signature with more
       frames to see it in.

    What survives has its confidence lifted by how fast it moved — the
    strongest tell this detector has for which box is the real clay, and it
    keeps paying off as a clip fills with birds, wad or a second distractor.
    """
    import math

    idxs = sorted(boxes_per_frame)
    if not idxs:
        return {}

    def centroid(b):
        x1, y1, x2, y2 = b["xyxy"]
        return (x1 + x2) / 2.0, (y1 + y2) / 2.0

    # Check 1 — exact-repeat: cluster every box centre against the *first*
    # point seen at that spot (a running average would drift along with a
    # slow-moving real object and wrongly chain its whole path into one
    # "fixture"; anchoring to the original point lets real motion, however
    # slow, walk clear of the tolerance within a couple of frames). The
    # tolerance is deliberately tight — a couple of pixels, generous only
    # for video-compression jitter on an otherwise static graphic — because
    # anything actually moving covers far more ground than that per frame.
    tol = max(1.5, frame_w * 0.0015)
    clusters = []   # each: {"cx", "cy" (anchor), "frames": set(), "items": [(i, b)]}
    for i in idxs:
        for b in boxes_per_frame[i]:
            cx, cy = centroid(b)
            match = next((c for c in clusters
                          if math.hypot(cx - c["cx"], cy - c["cy"]) <= tol), None)
            if match is None:
                match = {"cx": cx, "cy": cy, "frames": set(), "items": []}
                clusters.append(match)
            match["items"].append((i, b))
            match["frames"].add(i)

    # Three sightings, not two. Measured against the real stored tracks, the
    # reticle turns up in every frame of a clip — 589 of 589 in the one this
    # was checked against — so three costs nothing against a real overlay,
    # while two was also catching slow or distant clays that had barely
    # crossed a pixel between neighbouring frames. That direction of error is
    # the expensive one: a clay wrongly dropped leaves an unlabelled clay in
    # the training image, which teaches the detector that a clay is
    # background.
    fixtures = [c for c in clusters if len(c["frames"]) >= 3]
    live = {}
    for c in clusters:
        if len(c["frames"]) >= 3:
            continue   # seen again and again at one spot — a fixture
        for i, b in c["items"]:
            live.setdefault(i, []).append(b)
    if not live:
        return {}

    # A graphic does not land on the same pixel every time: compression and
    # the detector's own wobble scatter a few reads a pixel or two off the
    # rest, and those form their own one- and two-frame clusters that check 1
    # then waves through. So each fixture also poisons the ground around it.
    # A track is only killed by this if *every* one of its points sits in
    # that ground — a real clay crossing the centre of the picture, which is
    # exactly where the reticle sits and where clays are often shot, moves
    # through and out, so it lives.
    dead_r = max(4.0, frame_w * 0.006)

    # Check 2 — nearest-centroid tracking over what survived check 1: a gap
    # of a frame or two (a missed detection) keeps a track alive, but a
    # jump too big to be the same object starts a new one. max_jump scales
    # with frame width so the same numbers hold at any resolution.
    max_jump = frame_w * 0.12
    max_gap = 3
    tracks = []
    for i in sorted(live):
        for b in live[i]:
            cx, cy = centroid(b)
            best_t, best_d = None, None
            for t in tracks:
                if i - t["last_idx"] > max_gap:
                    continue
                lx, ly = t["pts"][-1][1], t["pts"][-1][2]
                d = math.hypot(cx - lx, cy - ly)
                if d <= max_jump and (best_d is None or d < best_d):
                    best_t, best_d = t, d
            if best_t is None:
                best_t = {"last_idx": i, "pts": [], "boxes": []}
                tracks.append(best_t)
            best_t["pts"].append((i, cx, cy))
            best_t["boxes"].append((i, b))
            best_t["last_idx"] = i

    span = idxs[-1] - idxs[0] + 1
    out = {}
    for t in tracks:
        xs = [p[1] for p in t["pts"]]
        ys = [p[2] for p in t["pts"]]
        spread = max(max(xs) - min(xs), max(ys) - min(ys))
        # A fixture sits in nearly every frame without moving; present for
        # a real stretch of the clip and stuck within a couple of percent
        # of frame width is the reticle's signature, not a fast clay's.
        fixed = len(t["pts"]) >= max(3, span * 0.4) and spread < frame_w * 0.02
        if fixed:
            continue
        # Loitering entirely inside a fixture's ground — reticle residue.
        if fixtures and all(
                any(math.hypot(px - f["cx"], py - f["cy"]) <= dead_r
                    for f in fixtures)
                for _, px, py in t["pts"]):
            continue

        # Speed, measured per step and taken at the median rather than from
        # the endpoints. Endpoint displacement flatters a box that wandered
        # and came back, and badly under-reads a clay that curls across the
        # frame — the path is what matters, not the straight line between
        # its ends.
        steps = []
        for (ia, ax, ay), (ib, bx, by) in zip(t["pts"], t["pts"][1:]):
            d = max(1, ib - ia)
            steps.append((math.hypot(bx - ax, by - ay) / d, (bx - ax) / d, (by - ay) / d))
        if steps:
            speeds = sorted(s[0] for s in steps)
            px_per_frame = speeds[len(speeds) // 2]
        else:
            px_per_frame = 0.0

        # Direction consistency: a thrown clay holds its heading over the
        # handful of frames it is in shot, while detector noise skitters.
        # The mean step vector's length over the mean step length is 1.0 for
        # a perfectly straight run and near 0 for jitter, so a fast-but-
        # incoherent track cannot buy its way up on speed alone.
        coherence = 1.0
        if len(steps) >= 2:
            mx = sum(s[1] for s in steps) / len(steps)
            my = sum(s[2] for s in steps) / len(steps)
            mean_speed = sum(s[0] for s in steps) / len(steps)
            if mean_speed > 0:
                coherence = min(1.0, math.hypot(mx, my) / mean_speed)

        # The booster: up to +0.15 for whatever is covering the most ground
        # per frame on a coherent heading, so a real crossing clay outranks
        # a slower distractor even when both clear the detector's threshold.
        boost = min(0.15, (px_per_frame / (frame_w * 0.15)) * 0.15) * coherence
        for i, b in t["boxes"]:
            out.setdefault(i, []).append({**b, "conf": min(1.0, b["conf"] + boost)})
    return out


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
    all_best = {i: max(bs, key=lambda b: b["conf"])
                for i, bs in boxes_per_frame.items() if bs}
    if not all_best:
        return {}
    out = {"det_conf": round(sum(b["conf"] for b in all_best.values()) / len(all_best), 3)}
    if outcome != "hit":
        return out

    # Tracks stored by the early 0.25-threshold screenings are salted with
    # phantom boxes — birds, wad, smoke — which keep a track alive long
    # after the real clay died, so 'the break is where the track ends'
    # needs the noise filtered out of the clock first.
    floor = float(os.environ.get("METRICS_CONF", 0.35))
    best = {i: b for i, b in all_best.items() if b["conf"] >= floor} or all_best

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

    # ?metrics=only computes the instrument panel and touches no AI at all —
    # detection, range and speed are arithmetic on the stored track, so they
    # must never be hostage to an API balance.
    metrics_only = request.query_params.get("metrics") == "only"
    if not metrics_only and not os.environ.get("ANTHROPIC_API_KEY"):
        return fastapi.responses.JSONResponse(
            {"error": "ANTHROPIC_API_KEY is not set in the Modal secret"},
            status_code=503)

    volume.reload()
    limit = min(int(request.query_params.get("limit", 60)), 200)
    # ?model= judges this run with a specific model — the A/B lever. A
    # gemini-* name needs GEMINI_API_KEY in the secret alongside the rest.
    override = request.query_params.get("model")
    if override:
        os.environ["VERDICT_MODEL"] = override
    # ?trial=1 puts the run on the bench: verdicts are written to
    # verdict_trials under the model's own name and the live verdict is left
    # alone, so several models can judge the same clips and be compared
    # rather than overwrite one another.
    trial = request.query_params.get("trial") in ("1", "true", "yes")
    model_name = os.environ.get("VERDICT_MODEL", "claude-sonnet-5")

    sb = _sb()
    q = (sb.table("pipeline_clips").select("*")
         .in_("label_status", ["pending", "queued", "prelabelled"]))
    # A trial must judge the *same* clips for every model, so it takes them
    # in a stable order rather than whatever the table hands back.
    rows = (q.order("clip_id").limit(limit).execute().data if trial
            else q.limit(limit).execute().data)

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
            frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
            step = max(1, int(round(fps * frame_dt)))
            frames, idx = [], 0
            if not metrics_only:   # the panel needs no pixels, only the track
                while True:
                    ok, frame = cap.read()
                    if not ok:
                        break
                    if idx % step == 0:
                        frames.append(frame)
                    idx += 1
            cap.release()
            # The stored track is indexed against the untrimmed cut; the file
            # on disk may have been trimmed by t_off. Shift the keys so the
            # boxes line up with the frames just read.
            shift = int(round(t_off / frame_dt))
            shifted = {int(k) - shift: v for k, v in boxes.items()
                       if int(k) - shift >= 0}
            if trial:
                # One verdict per clip on the bench: the first bang is the
                # comparable unit, and a burst's later shots would only add
                # noise to a like-for-like test.
                o, cf, colour = _judge_shot(row, frames, fps, step, shifted)
                if o is None:
                    skipped += 1
                    continue
                sb.table("verdict_trials").upsert({
                    "clip_id": row["clip_id"], "model": model_name,
                    "outcome": o, "outcome_conf": cf, "clay_colour": colour,
                }).execute()
                if o != row.get("outcome"):
                    changed += 1
                done += 1
                continue
            if metrics_only:
                outcome = row.get("outcome")
                verdicts = {}
            else:
                if not frames:
                    skipped += 1
                    continue
                verdicts = _judge_burst(row, frames, fps, step, shifted)
                outcome = verdicts.get("outcome")
                if outcome is None:
                    skipped += 1
                    continue
                if outcome != row.get("outcome") \
                        or verdicts.get("outcome_conf") != row.get("outcome_conf"):
                    changed += 1
            metrics = _shot_metrics(
                float(row["shot_ts"]) - float(row["clip_start"]),
                shifted, frame_dt, frame_w, outcome)
            if metrics_only and not metrics:
                skipped += 1
                continue
            sb.table("pipeline_clips").update(
                metrics if metrics_only else {**verdicts, **metrics}
            ).eq("clip_id", row["clip_id"]).execute()
            done += 1
        except Exception as e:  # noqa: BLE001
            print(f"[rejudge] {row.get('clip_id')} failed: {e}")
            skipped += 1

    _flush_usage(sb, "trial" if trial else "rejudge")
    return _noted(sb, {"stage": "rejudge", "model": model_name,
            "trial": trial, "rejudged": done,
            "differs_from_live": changed, "skipped": skipped})


def _judge_shot(row, frames, fps, step, boxes_per_frame=None, extra_offset=0.0):
    """hit / miss / unclear for one shot, from frames around its gunshot.

    The detector's boxes aim the judge's eye. At full width a distant clay
    is a handful of grey pixels and the only honest verdict is 'unclear' —
    so each frame sent to the model is cropped around the tracked clay and
    enlarged. A frame with no detection near it falls back to the full
    picture rather than guessing where to look.

    One call judges one bang. A pair is judged twice, the second call
    passing pair_gap_s as extra_offset so its impact window — and the crop,
    which follows the strongest box near each pick — belongs to the second
    clay's moment, not the first's.
    """
    import base64
    import json
    import os
    import re

    import anthropic
    import cv2

    try:
        # where in the sampled-frame list the shot falls
        into_clip = float(row["shot_ts"]) - float(row["clip_start"]) + extra_offset
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
            return None, None, None

        # One clay for the whole burst, chosen for this bang, rather than
        # whatever read strongest frame by frame.
        aim = _shot_track(boxes_per_frame or {}, shot_i,
                          frames[0].shape[1] if frames else 0, frame_dt)

        def eye(i):
            """The frame at i, cropped to the clay this bang was aimed at."""
            frame = frames[i]
            if not aim:
                return frame, False
            near = min(aim, key=lambda j: abs(j - i), default=None)
            if near is None or abs(near - i) * frame_dt > 0.7:
                return frame, False   # track lost around this moment
            cx, cy, sz = aim[near]
            h, w = frame.shape[:2]
            x1, y1, x2, y2 = cx - sz / 2, cy - sz / 2, cx + sz / 2, cy + sz / 2
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

        def shrink(frame):
            """A full frame costs four times a crop. Send it smaller."""
            h, w = frame.shape[:2]
            if w <= 768:
                return frame
            return cv2.resize(frame, (768, max(1, int(h * 768.0 / w))))

        blocks = []
        for n, i in enumerate(picks, 1):
            img, zoomed = eye(i)
            if not zoomed:
                img = shrink(img)
            ok, jpg = cv2.imencode(".jpg", img,
                                   [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                return None, None, None
            when = "before" if i < shot_i else "after"
            blocks.append({"type": "text",
                           "text": f"Frame {n} ({when} the shot"
                                   f"{', zoomed to the tracked clay' if zoomed else ', full view'}):"})
            blocks.append({"type": "image", "source": {
                "type": "base64", "media_type": "image/jpeg",
                "data": base64.standard_b64encode(jpg.tobytes()).decode()}})
        blocks.append({"type": "text", "text": "Verdict. JSON only."})
        system = ("A clay pigeon is shot at between the 'before' and 'after' "
                  "frames. The after-frames cluster tightly on the moment "
                  "of impact: pellets arrive within a quarter second of the "
                  "shot and a break lasts a tenth more, so study the early "
                  "after-frames for the exact instant. Frames marked "
                  "'zoomed to the tracked clay' are crops centred on the "
                  "detector's box for the clay, so the disc should be near "
                  "the middle. Hit: the clay breaks into fragments or a "
                  "puff of dust and is gone from later frames. Chipped: a "
                  "visible piece breaks off but the clay continues flying. "
                  "Miss: the same clay continues its flight intact. If the "
                  "clay cannot be followed across the frames, say unclear. "
                  "Also name the clay's colour from the frames. Reply with "
                  'JSON only: {"outcome": "hit|chipped|miss|unclear", '
                  '"clay_colour": "orange|black|blaze|white|unknown", '
                  '"confidence": <0-1>}')
        # Its own dial, and a sharper default than triage's: the verdict is
        # fine-grained perception on a small volume, so the model is worth
        # choosing on measured accuracy. VERDICT_MODEL switches provider by
        # name — a gemini-* value calls Google, anything else Anthropic —
        # so the A/B is a secrets change, never a code change.
        model = os.environ.get("VERDICT_MODEL", "claude-sonnet-5")
        if model.startswith("gemini"):
            text = _ask_gemini(model, system, blocks)
        else:
            msg = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"]).messages.create(
                model=model, max_tokens=200, system=system,
                messages=[{"role": "user", "content": blocks}])
            text = "".join(b.text for b in msg.content
                           if getattr(b, "type", "") == "text")
            u = getattr(msg, "usage", None)
            _USAGE.append((model, getattr(u, "input_tokens", 0),
                           getattr(u, "output_tokens", 0)))
        data = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
        outcome = str(data.get("outcome", "unclear"))
        if outcome not in ("hit", "chipped", "miss", "unclear"):
            outcome = "unclear"
        colour = str(data.get("clay_colour", "unknown"))
        if colour not in ("orange", "black", "blaze", "white", "unknown"):
            colour = "unknown"
        return outcome, max(0.0, min(1.0, float(data.get("confidence", 0)))), colour
    except Exception as e:  # noqa: BLE001 — a verdict is never worth a crash
        print(f"[prelabel] verdict failed for {row.get('clip_id')}: {e}")
        return None, None, None
