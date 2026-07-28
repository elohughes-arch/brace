"""
Brace pipeline - Stage 3: shot detection + clipping.

Detects gunshots via short-time audio energy spikes, cuts clips around
each shot with ffmpeg, and tags true pairs (two shots close together).

Usage:
    python clipper.py path/to/video.mp4 --outdir clips/
    python clipper.py path/to/video.mp4 --dry-run    # just list detected shots

No API keys needed. Test on your own Vanguard footage first.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from scipy.io import wavfile

# Tunables - adjust after testing on real footage
PRE_S = 4.0          # seconds before shot to include (launch + flight)
POST_S = 3.0         # seconds after shot (break/dying behaviour window)
PAIR_WINDOW_S = 4.0  # two shots within this = true pair, single merged clip
MIN_GAP_S = 0.25     # spikes closer than this are one shot (echo/report)
FRAME_MS = 20        # energy analysis frame size
K_MAD = 12.0         # spike threshold: median + K * MAD of frame energy


def extract_audio(video: Path, wav_path: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000",
         "-f", "wav", str(wav_path)],
        check=True, capture_output=True,
    )


def detect_shots(wav_path: Path) -> list[float]:
    """Return timestamps (s) of detected gunshots."""
    sr, audio = wavfile.read(wav_path)
    audio = audio.astype(np.float64)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    frame_len = int(sr * FRAME_MS / 1000)
    n_frames = len(audio) // frame_len
    frames = audio[: n_frames * frame_len].reshape(n_frames, frame_len)
    energy = np.sqrt((frames ** 2).mean(axis=1))  # RMS per frame

    med = np.median(energy)
    mad = np.median(np.abs(energy - med)) + 1e-9
    threshold = med + K_MAD * mad

    spike_frames = np.where(energy > threshold)[0]
    if len(spike_frames) == 0:
        return []

    # Merge consecutive/near spikes into single shot events
    times = spike_frames * FRAME_MS / 1000.0
    shots = [times[0]]
    for t in times[1:]:
        if t - shots[-1] > MIN_GAP_S:
            shots.append(t)
    return shots


def group_pairs(shots: list[float]) -> list[dict]:
    """Group shots into clip specs, merging true pairs into one clip."""
    clips = []
    i = 0
    while i < len(shots):
        first = shots[i]
        if i + 1 < len(shots) and shots[i + 1] - first <= PAIR_WINDOW_S:
            second = shots[i + 1]
            clips.append({
                "shot_ts": first,
                "is_pair": True,
                "pair_gap_s": round(second - first, 2),
                "start": max(0.0, first - PRE_S),
                "end": second + POST_S,
            })
            i += 2
        else:
            clips.append({
                "shot_ts": first,
                "is_pair": False,
                "pair_gap_s": None,
                "start": max(0.0, first - PRE_S),
                "end": first + POST_S,
            })
            i += 1
    return clips


def cut_clip(video: Path, spec: dict, out_path: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-ss", f"{spec['start']:.2f}", "-to", f"{spec['end']:.2f}",
         "-i", str(video), "-c:v", "libx264", "-preset", "fast", "-crf", "20",
         "-c:a", "aac", str(out_path)],
        check=True, capture_output=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video", type=Path)
    ap.add_argument("--outdir", type=Path, default=Path("clips"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.video.exists():
        sys.exit(f"Not found: {args.video}")

    with tempfile.TemporaryDirectory() as td:
        wav = Path(td) / "audio.wav"
        extract_audio(args.video, wav)
        shots = detect_shots(wav)

    if not shots:
        print("No shots detected. Try lowering K_MAD (currently "
              f"{K_MAD}) if shots are definitely present.")
        return

    clips = group_pairs(shots)
    print(f"Detected {len(shots)} shots -> {len(clips)} clips "
          f"({sum(c['is_pair'] for c in clips)} pairs)")
    for c in clips:
        tag = f"PAIR gap={c['pair_gap_s']}s" if c["is_pair"] else "single"
        print(f"  shot @ {c['shot_ts']:7.2f}s  clip {c['start']:.2f}-{c['end']:.2f}s  [{tag}]")

    if args.dry_run:
        return

    args.outdir.mkdir(parents=True, exist_ok=True)
    stem = args.video.stem
    manifest = []
    for n, spec in enumerate(clips, 1):
        out = args.outdir / f"{stem}_shot{n:03d}{'_pair' if spec['is_pair'] else ''}.mp4"
        cut_clip(args.video, spec, out)
        manifest.append({**spec, "file": str(out)})
        print(f"  wrote {out}")

    (args.outdir / f"{stem}_manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"Manifest: {args.outdir / f'{stem}_manifest.json'}")


if __name__ == "__main__":
    main()
