"""
Brace pipeline - Stage 2: triage.

Samples frames from a downloaded video and asks Claude whether the footage is
worth keeping for clay-pigeon training data: is it first-person shooting
footage, are clays actually visible against the sky, is the picture clean
enough to label. Returns a 0-10 score; anything below KEEP_THRESHOLD is
dropped and the file deleted.

Scoring is deliberately harsh. A rejected video costs one API call; a kept
video costs a download, a clip pass, a GPU pass and a human's attention in
Roboflow, so the cheap 'no' is the one worth getting right.

Usage:
    python triage.py path/to/video.mp4
    python triage.py path/to/video.mp4 --frames 12 --json

Env (.env): ANTHROPIC_API_KEY
"""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

MODEL = "claude-opus-5"

# 0-10. Six is 'usable footage with visible clays'; below that the clip stage
# would be cutting around shots we could never label.
KEEP_THRESHOLD = 6.0

N_FRAMES = 8          # frames sampled across the video
FRAME_WIDTH = 768     # downscale before sending; clays stay legible at this size
JPEG_QUALITY = 4      # ffmpeg -q:v, lower is better

CAMERA_VALUES = ("pov_glasses", "barrel", "gopro", "third_person", "broadcast", "unknown")

SYSTEM = """You triage third-party shooting footage for a clay-pigeon object-detection \
training set. You are shown frames sampled evenly across one video. Judge only what \
is in the frames.

Footage is useful when it is filmed from or near the shooter's eyeline, shows clays \
in flight against sky or treeline, and is clean enough that a human could draw a box \
round a clay. Footage is useless when it is a talking head, a product review, a range \
of static targets, live quarry, a video game, heavily edited with overlays or \
transitions, too dark, or so compressed that a clay is a smudge.

Score 0-10 for training value:
  0-2  wrong subject entirely (talking head, review, game, static targets, live quarry)
  3-5  right subject, unusable picture (clays never visible, heavy overlay, very dark)
  6-7  usable: first-person or close, clays visible in at least some frames
  8-10 excellent: sustained clay-in-flight against clean sky, sharp, minimal editing

Reply with JSON only, no prose and no code fence:
{"score": <number 0-10>, "camera": "<pov_glasses|barrel|gopro|third_person|broadcast|unknown>", \
"clays_visible": <true|false>, "notes": "<one short British-English sentence>"}"""


def video_duration_s(video: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def sample_frames(video: Path, outdir: Path, n: int = N_FRAMES) -> list[Path]:
    """Grab n frames spread across the video, skipping the top and tail.

    The first and last 5% are intros, outros and end cards on almost every
    upload, so sampling inside 5-95% asks the model about the actual footage.
    """
    outdir.mkdir(parents=True, exist_ok=True)
    dur = video_duration_s(video)
    if dur <= 0:
        return []

    lo, hi = dur * 0.05, dur * 0.95
    step = (hi - lo) / max(1, n - 1) if n > 1 else 0.0
    frames: list[Path] = []
    for i in range(n):
        ts = lo + step * i
        fp = outdir / f"frame{i:02d}.jpg"
        r = subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{ts:.2f}", "-i", str(video),
             "-frames:v", "1", "-vf", f"scale={FRAME_WIDTH}:-2",
             "-q:v", str(JPEG_QUALITY), str(fp)],
            capture_output=True,
        )
        if r.returncode == 0 and fp.exists() and fp.stat().st_size > 0:
            frames.append(fp)
    return frames


def _parse_json(text: str) -> dict:
    """Pull the JSON object out of a reply, fence or stray prose notwithstanding."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError(f"no JSON in reply: {text[:200]}")
    return json.loads(m.group(0))


def score_frames(frames: list[Path]) -> dict:
    """Ask Claude to score the sampled frames. Returns score/camera/notes."""
    if not frames:
        return {"score": 0.0, "camera": "unknown", "clays_visible": False,
                "notes": "No frames could be sampled from the file."}

    import anthropic

    blocks: list[dict] = []
    for i, fp in enumerate(frames, 1):
        blocks.append({"type": "text", "text": f"Frame {i} of {len(frames)}:"})
        blocks.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": base64.standard_b64encode(fp.read_bytes()).decode(),
            },
        })
    blocks.append({"type": "text", "text": "Score this video. JSON only."})

    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    # max_tokens caps thinking *and* the reply. Too tight and the model can
    # spend the lot reasoning about eight frames and return no text at all,
    # which reaches _parse_json as "no JSON in reply".
    msg = client.messages.create(
        model=MODEL,
        max_tokens=8192,
        thinking={"type": "adaptive"},
        system=SYSTEM,
        messages=[{"role": "user", "content": blocks}],
    )

    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    data = _parse_json(text)

    score = float(data.get("score", 0))
    camera = str(data.get("camera", "unknown"))
    return {
        "score": max(0.0, min(10.0, score)),
        "camera": camera if camera in CAMERA_VALUES else "unknown",
        "clays_visible": bool(data.get("clays_visible", False)),
        "notes": str(data.get("notes", ""))[:400],
    }


def triage_video(video: Path, n: int = N_FRAMES) -> dict:
    with tempfile.TemporaryDirectory() as td:
        frames = sample_frames(video, Path(td), n)
        return score_frames(frames)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--frames", type=int, default=N_FRAMES)
    ap.add_argument("--json", action="store_true", help="print raw JSON only")
    args = ap.parse_args()

    if not args.video.exists():
        sys.exit(f"Not found: {args.video}")

    r = triage_video(args.video, args.frames)
    if args.json:
        print(json.dumps(r))
        return

    verdict = "KEEP" if r["score"] >= KEEP_THRESHOLD else "DROP"
    print(f"{verdict}  score {r['score']:.1f}/10  camera {r['camera']}")
    print(f"  {r['notes']}")


if __name__ == "__main__":
    main()
