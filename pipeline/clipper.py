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
PRE_S = 5.0          # generous raw window: pre-label trims to the tracked flight
POST_S = 6.0         # a missed clay flies on; the trim reclaims the slack
PAIR_WINDOW_S = 4.0  # shots chained within this of each other = one burst, one clip
MAX_BURST_SHOTS = 6  # a flush chains forever otherwise: cap the shots per clip
MAX_BURST_S = 20.0   # and the span — a 3-minute 'burst' is a GPU bill, not a clip
MIN_GAP_S = 0.25     # spikes closer than this are one shot (echo/report)
FRAME_MS = 20        # energy analysis frame size
K_MAD = 12.0         # spike threshold: median + K * MAD of frame energy
MAX_REPORT_S = 0.35  # a gunshot report, echo included, dies within this; anything
                     # louder for longer is wind, crowd, music — not a shot


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

    spike = energy > threshold
    if not spike.any():
        return []

    # A loud moment is only a shot if it is *shaped* like one: a report is a
    # sharp transient that dies within MAX_REPORT_S. A run of loud frames
    # longer than that is sustained racket — wind, a crowd, music, the trap
    # machine — and filtering it here is what keeps a shooting-free video
    # from producing 'shots' at all.
    events: list[float] = []
    i, n = 0, len(spike)
    while i < n:
        if spike[i]:
            j = i
            while j + 1 < n and spike[j + 1]:
                j += 1
            if (j - i + 1) * FRAME_MS / 1000.0 <= MAX_REPORT_S:
                # float() because numpy scalars do not survive the trip into
                # Supabase as JSON.
                events.append(float(i * FRAME_MS / 1000.0))
            i = j + 1
        else:
            i += 1
    return merge_spikes(events)


def merge_spikes(times: list[float], min_gap: float = MIN_GAP_S) -> list[float]:
    """Collapse each run of above-threshold frames into one event.

    The gap that decides where an event ends is the one between *consecutive
    spikes*, not the time since the last event we accepted. Measuring from the
    last accepted shot looks equivalent on a gunshot — a sharp report that dies
    inside min_gap — but on anything sustained it is not: wind, a crowd, the
    trap machine running, and a two-second passage becomes a new "shot" every
    min_gap seconds. group_pairs then reads those as pairs, so one gust turns
    into several clips, each costing a GPU pass and a human's attention in
    Roboflow, and each teaching the model that a clay was in shot.
    """
    if not times:
        return []
    shots = [times[0]]
    prev = times[0]
    for t in times[1:]:
        if t - prev > min_gap:
            shots.append(t)
        prev = t                      # every spike moves the reference, accepted or not
    return shots


def group_bursts(shots: list[float]) -> list[dict]:
    """Group shots into clip specs, one clip per burst.

    A burst is every shot fired at the same presentation: shots chain while
    each is within PAIR_WINDOW_S of the one before, however many that is.
    The old pairing logic stopped at two, so a pair-plus-reload third clay
    fell just past the clip's end and was cut off mid-flight — the clip now
    runs from the first bang to POST_S after the last.
    """
    clips = []
    i = 0
    while i < len(shots):
        burst = [shots[i]]
        while (i + 1 < len(shots)
               and shots[i + 1] - burst[-1] <= PAIR_WINDOW_S
               and len(burst) < MAX_BURST_SHOTS
               and shots[i + 1] - burst[0] <= MAX_BURST_S):
            i += 1
            burst.append(shots[i])
        first, last = burst[0], burst[-1]
        clips.append({
            "shot_ts": first,
            "n_shots": len(burst),
            "shot_offsets": [round(t - first, 2) for t in burst],
            "is_pair": len(burst) >= 2,
            "pair_gap_s": round(burst[1] - first, 2) if len(burst) >= 2 else None,
            "start": max(0.0, first - PRE_S),
            "end": last + POST_S,
        })
        i += 1
    return clips


group_pairs = group_bursts   # the old name, for callers and muscle memory


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
