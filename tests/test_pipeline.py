"""
Pure-logic checks for the pipeline stages.

Deliberately no ffmpeg, no numpy, no network: this covers the decisions that
silently corrupt a training set if they are wrong — where a clip starts and
ends, what counts as a true pair, and whether a model's reply can be read.

    python3 tests/test_pipeline.py
"""

import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

# clipper imports numpy and scipy at module level for the audio pass. The shot
# grouping below touches neither, so stub them rather than pull in the wheels.
for name in ("numpy", "scipy", "scipy.io", "scipy.io.wavfile"):
    sys.modules.setdefault(name, types.ModuleType(name))

import clipper  # noqa: E402
import triage   # noqa: E402


class GroupPairs(unittest.TestCase):
    """Two shots close together are one clip, not two. Everything else is one
    clip per shot."""

    def test_no_shots(self):
        self.assertEqual(clipper.group_pairs([]), [])

    def test_single_shot_window(self):
        (c,) = clipper.group_pairs([10.0])
        self.assertFalse(c["is_pair"])
        self.assertIsNone(c["pair_gap_s"])
        self.assertAlmostEqual(c["start"], 10.0 - clipper.PRE_S)   # launch + flight
        self.assertAlmostEqual(c["end"], 10.0 + clipper.POST_S)    # break + dying

    def test_start_never_goes_negative(self):
        # A shot inside the first four seconds must not ask ffmpeg to seek
        # before the start of the file.
        (c,) = clipper.group_pairs([1.0])
        self.assertEqual(c["start"], 0.0)

    def test_true_pair_becomes_one_clip(self):
        (c,) = clipper.group_pairs([10.0, 12.0])
        self.assertTrue(c["is_pair"])
        self.assertEqual(c["pair_gap_s"], 2.0)
        self.assertAlmostEqual(c["start"], 10.0 - clipper.PRE_S)
        self.assertAlmostEqual(c["end"], 12.0 + clipper.POST_S)  # runs to the *second* shot

    def test_shots_far_apart_stay_separate(self):
        cs = clipper.group_pairs([10.0, 30.0])
        self.assertEqual(len(cs), 2)
        self.assertFalse(any(c["is_pair"] for c in cs))

    def test_boundary_is_inclusive(self):
        exact = clipper.PAIR_WINDOW_S
        (c,) = clipper.group_pairs([10.0, 10.0 + exact])
        self.assertTrue(c["is_pair"], "a gap of exactly the window is still a pair")

        cs = clipper.group_pairs([10.0, 10.0 + exact + 0.01])
        self.assertEqual(len(cs), 2, "a hair over the window is two singles")

    def test_a_shot_is_only_used_once(self):
        # Three shots in quick succession: the first two pair, the third is its
        # own clip even though it is close to the second.
        cs = clipper.group_pairs([10.0, 12.0, 13.0])
        self.assertEqual(len(cs), 2)
        self.assertTrue(cs[0]["is_pair"])
        self.assertFalse(cs[1]["is_pair"])
        self.assertEqual(cs[1]["shot_ts"], 13.0)

    def test_every_clip_has_positive_duration(self):
        for shots in ([0.0], [0.5, 0.6], [1.0, 4.9], [100.0, 104.0, 200.0]):
            for c in clipper.group_pairs(shots):
                self.assertGreater(c["end"], c["start"], f"empty clip from {shots}")


class MergeSpikes(unittest.TestCase):
    """One event per run of loud frames — not one every MIN_GAP_S."""

    def frames(self, start, seconds):
        """A solid run of above-threshold 20ms frames."""
        step = clipper.FRAME_MS / 1000.0
        return [start + i * step for i in range(int(seconds / step))]

    def test_a_sustained_noise_passage_is_one_event(self):
        # Two seconds of continuous racket: a gust, a crowd, the trap machine.
        # Measuring from the last accepted shot produced one every 0.26s.
        got = clipper.merge_spikes(self.frames(0.0, 2.0))
        self.assertEqual(len(got), 1, f"expected one event, got {len(got)}")

    def test_a_sustained_passage_does_not_become_pairs(self):
        # The consequence that actually costs money: bogus clips.
        clips = clipper.group_pairs(clipper.merge_spikes(self.frames(0.0, 2.0)))
        self.assertEqual(len(clips), 1)
        self.assertFalse(clips[0]["is_pair"])

    def test_two_real_shots_stay_two(self):
        # Two short reports a second apart, each a few frames long.
        got = clipper.merge_spikes(self.frames(0.0, 0.08) + self.frames(1.0, 0.08))
        self.assertEqual(len(got), 2)
        self.assertAlmostEqual(got[0], 0.0)
        self.assertAlmostEqual(got[1], 1.0)

    def test_event_is_reported_at_its_start(self):
        got = clipper.merge_spikes(self.frames(5.0, 0.1))
        self.assertAlmostEqual(got[0], 5.0)

    def test_edges(self):
        self.assertEqual(clipper.merge_spikes([]), [])
        self.assertEqual(clipper.merge_spikes([3.0]), [3.0])

    def test_gap_boundary(self):
        g = clipper.MIN_GAP_S
        self.assertEqual(len(clipper.merge_spikes([0.0, g])), 1, "exactly the gap is one event")
        self.assertEqual(len(clipper.merge_spikes([0.0, g + 0.01])), 2)


class ParseModelReply(unittest.TestCase):
    """The triage score arrives as text. It has to survive the usual noise."""

    def test_plain_json(self):
        self.assertEqual(triage._parse_json('{"score": 7.5}')["score"], 7.5)

    def test_fenced_json(self):
        r = triage._parse_json('```json\n{"score": 8, "camera": "gopro"}\n```')
        self.assertEqual(r["camera"], "gopro")

    def test_json_with_prose_either_side(self):
        r = triage._parse_json('Here you go:\n{"score": 3}\nHope that helps.')
        self.assertEqual(r["score"], 3)

    def test_no_json_raises(self):
        with self.assertRaises(ValueError):
            triage._parse_json("I could not see the frames.")


class ScoreFrames(unittest.TestCase):
    def test_no_frames_is_a_drop_not_a_crash(self):
        # A video ffmpeg could not read must not take the whole batch down,
        # and must never score high enough to keep.
        r = triage.score_frames([])
        self.assertEqual(r["score"], 0.0)
        self.assertLess(r["score"], triage.KEEP_THRESHOLD)
        self.assertEqual(r["camera"], "unknown")


class Thresholds(unittest.TestCase):
    def test_keep_threshold_sits_on_the_documented_scale(self):
        # schema.sql calls triage_score "0-10 from vision model"; the prompt
        # and the threshold have to agree with that or every video is kept.
        self.assertGreater(triage.KEEP_THRESHOLD, 0)
        self.assertLess(triage.KEEP_THRESHOLD, 10)
        self.assertIn("0-10", triage.SYSTEM)

    def test_camera_values_match_the_prompt(self):
        for v in triage.CAMERA_VALUES:
            self.assertIn(v, triage.SYSTEM, f"{v} is accepted but never offered")


if __name__ == "__main__":
    unittest.main(verbosity=2)
