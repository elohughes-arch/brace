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

base_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install("numpy", "scipy", "requests", "supabase", "yt-dlp", "fastapi",
                 "anthropic", "python-dotenv")
    .add_local_python_source("discover", "triage", "clipper")
)

gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0")
    .pip_install(
        "torch", "torchvision", "transformers>=4.44",
        "supabase", "roboflow", "opencv-python-headless", "pillow", "numpy",
        "fastapi",
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

@app.function(image=base_image, secrets=[secret], timeout=1800,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def triage(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import subprocess
    import tempfile
    from pathlib import Path
    from triage import sample_frames, score_frames, KEEP_THRESHOLD

    limit = min(int(request.query_params.get("limit", 10) or 10), 25)

    sb = _sb()
    rows = (sb.table("pipeline_videos").select("*")
            .eq("status", "discovered").limit(limit).execute().data)
    kept = dropped = failed = 0
    for row in rows:
        vid = row["video_id"]
        try:
            out = Path(MEDIA) / "videos" / f"{vid}.mp4"
            out.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                ["yt-dlp", "-f", "bv*[height<=720]+ba/b[height<=720]",
                 "--merge-output-format", "mp4", "-o", str(out), row["url"]],
                check=True, capture_output=True,
            )
            with tempfile.TemporaryDirectory() as td:
                frames = sample_frames(out, Path(td))
                r = score_frames(frames)
            keep = r["score"] >= KEEP_THRESHOLD
            # 'downloaded' means triaged and waiting on a human in the review
            # queue. Only 'approved' reaches the clip stage.
            sb.table("pipeline_videos").update({
                "status": "downloaded" if keep else "rejected",
                "triage_score": r["score"],
                "triage_notes": f"[{r.get('camera', '?')}] {r.get('notes', '')}",
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
            sb.table("pipeline_videos").update(
                {"status": "error", "triage_notes": "local file missing"}
            ).eq("video_id", row["video_id"]).execute()
            continue
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
                "label_status": "pending",
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
    return {"stage": "clip", "videos": len(rows), "clips_created": made,
            "errors": failed}


# ---------------------------------------------------------------- prelabel

@app.function(image=gpu_image, secrets=[secret], gpu="T4", timeout=1800,
              volumes={MEDIA: volume})
@web_endpoint(method="POST")
def prelabel(request: fastapi.Request):
    if not _authorised(request):
        return UNAUTHORISED

    import os
    import cv2
    import torch
    from pathlib import Path
    from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection

    DETECT_PROMPT = "flying clay pigeon. small orange disc. small black disc in sky."
    sb = _sb()
    rows = (sb.table("pipeline_clips").select("*")
            .eq("label_status", "pending").limit(10).execute().data)
    if not rows:
        return {"stage": "prelabel", "processed": 0, "uploaded": 0}

    device = "cuda"
    proc = AutoProcessor.from_pretrained("IDEA-Research/grounding-dino-base")
    gdino = AutoModelForZeroShotObjectDetection.from_pretrained(
        "IDEA-Research/grounding-dino-base").to(device)

    from roboflow import Roboflow
    rf = Roboflow(api_key=os.environ["ROBOFLOW_API_KEY"])
    project = rf.workspace().project(os.environ["ROBOFLOW_PROJECT"])

    done = uploaded = 0
    for row in rows:
        path = row["file_path"]
        if not Path(path).exists():
            sb.table("pipeline_clips").update(
                {"label_status": "rejected"}).eq("clip_id", row["clip_id"]).execute()
            continue
        cap = cv2.VideoCapture(path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        step = max(1, int(round(fps / 5)))
        frames, idx = [], 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                frames.append(frame)
            idx += 1
        cap.release()

        boxes_per_frame = {}
        for i, frame in enumerate(frames):
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            inputs = proc(images=rgb, text=DETECT_PROMPT,
                          return_tensors="pt").to(device)
            with torch.no_grad():
                out = gdino(**inputs)
            res = proc.post_process_grounded_object_detection(
                out, inputs.input_ids, threshold=0.25,
                target_sizes=[rgb.shape[:2]])[0]
            if len(res["boxes"]):
                boxes_per_frame[i] = [
                    {"xyxy": b.tolist(), "conf": float(s)}
                    for b, s in zip(res["boxes"].cpu(), res["scores"].cpu())
                ]

        sb.table("pipeline_labels").upsert({
            "clip_id": row["clip_id"],
            "n_clays": max((len(v) for v in boxes_per_frame.values()), default=0),
            "boxes_json": boxes_per_frame,
        }).execute()

        tmp = Path("/tmp/frames")
        tmp.mkdir(parents=True, exist_ok=True)
        for i in list(boxes_per_frame)[::3]:
            fp = tmp / f"{row['clip_id']}_{i:04d}.jpg"
            cv2.imwrite(str(fp), frames[i])
            h, w = frames[i].shape[:2]
            lines = []
            for b in boxes_per_frame[i]:
                x1, y1, x2, y2 = b["xyxy"]
                lines.append(f"0 {(x1+x2)/2/w:.6f} {(y1+y2)/2/h:.6f} "
                             f"{(x2-x1)/w:.6f} {(y2-y1)/h:.6f}")
            ann = fp.with_suffix(".txt")
            ann.write_text("\n".join(lines))
            project.upload(str(fp), annotation_path=str(ann),
                           batch_name="prelabelled-pipeline",
                           tag_names=["prelabel"])
            uploaded += 1

        sb.table("pipeline_clips").update(
            {"label_status": "prelabelled"}).eq("clip_id", row["clip_id"]).execute()
        done += 1

    return {"stage": "prelabel", "processed": done, "frames_uploaded": uploaded}
