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

Env (.env): ANTHROPIC_API_KEY, optionally TRIAGE_MODEL
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

# Haiku, at the larger frame width below.
#
# The triage fix and the model change were shipped in the same commit and the
# win was credited to both, which was sloppy: they were never separated, and
# the evidence points almost entirely at the resolution. A clay two pixels
# across is not a model-capability problem, it is an information problem —
# Haiku can read a clay that is thirty-five pixels, it could not read one that
# was two. Nothing about the rubric is beyond it.
#
# The cost difference is not marginal. Image tokens dominate, and at 1536 a
# video runs about 15,000 of them: roughly £0.015 on Haiku against £0.03 on
# Sonnet. Run unattended over eight hundred videos a night that is the
# difference between twelve pounds and twenty-four — which is how a
# twenty-five dollar balance disappeared overnight without anyone watching.
#
# Set TRIAGE_MODEL=claude-sonnet-5 to trade back up, ideally after measuring
# whether it actually scores better at this frame width rather than assuming
# it does.
MODEL = os.environ.get("TRIAGE_MODEL", "claude-haiku-4-5")

# 0-10. Six is 'usable footage with visible clays'; below that the clip stage
# would be cutting around shots we could never label.
KEEP_THRESHOLD = 6.0

N_FRAMES = 8          # frames sampled across the video

# 768 was wrong, and it was the whole problem. A clay at forty yards is a
# couple of pixels across in a 768-wide frame — the judge was not being harsh,
# it genuinely could not see the thing it was being asked to look for. With
# `keep` requiring clays_visible, a judge that cannot see clays rejects
# everything: 619 of 755 videos scored 0, 1 or 2, and the score distribution
# came out bimodal rather than graded, which is what a detector looks like
# when it is guessing.
#
# 1536 sits inside the high-resolution tier (2576px on the long edge) rather
# than at the ceiling: four times the pixels, roughly three times the image
# tokens, and a clay that is now tens of pixels instead of two or three.
FRAME_WIDTH = int(os.environ.get("TRIAGE_FRAME_WIDTH", 1536))
JPEG_QUALITY = 4      # ffmpeg -q:v, lower is better

CAMERA_VALUES = ("pov_glasses", "barrel", "gopro", "third_person", "broadcast", "unknown")

# Point of view, or nothing. The model this trains watches the world through
# hardware mounted on a shooter — a barrel cam, glasses, a GoPro on the chest.
# Broadcast and third-person footage shows the same clays from somewhere the
# deployed camera will never stand: different lens, different distance,
# different angle on the same flight. It looks like useful data and trains the
# model to read a view it will not be given.
#
# 'unknown' is kept deliberately. It means the judge could not tell, which is
# not the same as knowing it is wrong, and throwing away the unclassifiable
# would bin footage on the judge's uncertainty rather than on the footage.
POV_CAMERAS = ("pov_glasses", "barrel", "gopro", "unknown")

SYSTEM = """You triage third-party shooting footage for a clay-pigeon object-detection \
training set. You are shown frames sampled evenly across one video. Judge only what \
is in the frames.

Footage is useful ONLY when it is point of view: filmed from a camera carried by \
the shooter — mounted on the gun or barrel, worn on the head or glasses, or on the \
chest. It must also show clays in flight against sky or treeline and be clean enough \
that a human could draw a box round a clay.

Footage filmed from beside, behind or in front of the shooter is NOT point of view, \
however good it looks. Neither is broadcast or competition coverage, tripod or \
drone footage, or anything cut between multiple camera angles. Score these 0-2 \
whatever else is in them — a clear clay filmed from the wrong place is worse than \
useless here, because it teaches a view the deployed camera will never have.

Footage is also useless when it is a talking head, a product review, a range of \
static targets, live quarry, a video game, heavily edited with overlays or \
transitions, too dark, or so compressed that a clay is a smudge.

Score 0-10 for training value:
  0-2  wrong subject entirely (talking head, review, game, static targets, live quarry)
  3-5  right subject, unusable picture (clays never visible, heavy overlay, very dark)
  6-7  usable: first-person or close, clays visible in at least some frames
  8-10 excellent: sustained clay-in-flight against clean sky, sharp, minimal editing

Reply with JSON only, no prose and no code fence:
{"score": <number 0-10>, "camera": "<pov_glasses|barrel|gopro|third_person|broadcast|unknown>", \
"clays_visible": <true|false>, "weather": "<clear|overcast|rain|fog|dusk|indoor|unknown>", \
"criteria": "<3-6 words naming the clays and conditions, e.g. 'slow orange clays, clear sky'>", \
"notes": "<one short British-English sentence>"}"""

WEATHER_VALUES = ("clear", "overcast", "rain", "fog", "dusk", "indoor", "unknown")


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


def sample_frames_at(video: Path, outdir: Path, times: list[float],
                     n: int = N_FRAMES, after_s: float = 0.5) -> list[Path]:
    """Frames taken just after known gunshots, spread across the video.

    The audio gate has already found the bangs, and half a second after a
    bang a clay is airborne by construction — the even spread can land on
    walking, talking and reloading, and fail a video full of shooting.
    """
    outdir.mkdir(parents=True, exist_ok=True)
    if not times:
        return []
    picks = times[:: max(1, len(times) // n)][:n]
    frames: list[Path] = []
    for i, ts in enumerate(picks):
        fp = outdir / f"shotframe{i:02d}.jpg"
        r = subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{ts + after_s:.2f}", "-i", str(video),
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
    # Adaptive thinking exists on the 4.6+ families but is rejected with a
    # 400 by Haiku, so it follows the model choice. With thinking on,
    # max_tokens caps the reasoning *and* the reply — too tight and the model
    # can spend the lot reasoning about eight frames and return no text at
    # all, which reaches _parse_json as "no JSON in reply".
    extra = {} if "haiku" in MODEL else {"thinking": {"type": "adaptive"}}
    msg = client.messages.create(
        model=MODEL,
        max_tokens=1024 if "haiku" in MODEL else 8192,
        system=SYSTEM,
        messages=[{"role": "user", "content": blocks}],
        **extra,
    )

    text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
    data = _parse_json(text)

    score = float(data.get("score", 0))
    camera = str(data.get("camera", "unknown"))
    usage = getattr(msg, "usage", None)
    return {
        "score": max(0.0, min(10.0, score)),
        "camera": camera if camera in CAMERA_VALUES else "unknown",
        "clays_visible": bool(data.get("clays_visible", False)),
        "weather": (str(data.get("weather", "unknown"))
                    if str(data.get("weather", "unknown")) in WEATHER_VALUES else "unknown"),
        # The criteria label the Review card wears: what the footage holds,
        # in the judge's own few words — clay colour, pace, sky.
        "criteria": str(data.get("criteria", ""))[:80],
        "notes": str(data.get("notes", ""))[:400],
        # What this verdict actually cost, so the run can be priced from
        # recorded fact rather than a rate card and a guess.
        "in_tokens": getattr(usage, "input_tokens", None),
        "out_tokens": getattr(usage, "output_tokens", None),
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
