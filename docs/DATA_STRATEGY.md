# Brace data strategy

The question this machine exists to answer: **how much footage, of what kind,
buys a given level of detection reliability?** The method is scaling-law-based
data budgeting — fit the accuracy-vs-data curve from our own retrains and
extrapolate to the target — combined with curriculum learning (easy conditions
first, difficulty added one axis at a time) and, later, active learning
(labelling the model's own failures).

## The three rules

1. **The currency is distinct, diverse shots — never hours or frames.**
   Frames from one flight are near-copies; an hour of footage can hold 100
   shots or 5. ~3,000 distinct shots across conditions is the working estimate
   for ~92% mAP@50. Cap frames kept per flight (the prelabel stride does
   this); the Mastersheet counts clips per video so our real shots-per-hour
   exchange rate is measured, not guessed.

2. **The curve is logarithmic and diversity is the multiplier.**
   Each doubling of data buys a shrinking slice of the remaining error, and
   3,000 shots at one ground on clear days plateaus far below 3,000 spread
   across weather × background × camera. The planning tool is the coverage
   matrix on the portal's Home page, not a single hours number: a thin row is
   the next condition to source.

3. **Reliability only exists against a golden test set.**
   Accuracy measured on training data is fiction. Roughly one video in seven
   is drawn into the **golden holdout** — whole videos, drawn
   deterministically from a hash of the video id, so no flight's frames can
   ever straddle the train/test line. Golden frames land in Roboflow's *test*
   split, are never auto-accepted (ground truth must be human-verified), and
   no training run sees them. The mAP Roboflow reports after each train is
   therefore a real number, and after retrains at ~1,000 / 2,000 / 3,000
   shots the three points fit our own scaling curve.

## The phases

- **Phase 0 — the ruler.** Build the golden holdout before optimising
  anything. *(Implemented: `holdout` on videos and clips, test-split routing
  in prelabel, coverage matrix on Home.)*
- **Phase 1 — core competence (~1,000 shots).** Clear sky, orange clays,
  close range. Labels are cheap and near-perfect; the model learns what a
  clay *is*. Slow motion is welcome here — sharp frames label beautifully —
  but it is tagged (`slo-mo`, source ≥ 45 fps) and capped under ~25% of the
  final mix, because the deployed model watches real-speed motion blur.
- **Phase 2 — one axis at a time (~250–400 shots per axis).** Black clays →
  overcast → treeline backgrounds → long range → real-speed blur → dusk/rain.
  Never two axes at once: the per-slice delta on the golden set must say what
  each addition bought.
- **Phase 3 — active learning (~the last 1,000).** Run the model on fresh
  footage and label its failures — missed clays and false fires on birds,
  drones, planes. A labelled failure is worth ~10× a labelled random frame.
- **Phase 4 — consolidate.** Every retrain uses the full cumulative dataset
  (never just the new slice), and the per-slice report is read every time so
  gains on hard conditions never silently cost the easy ones.

## The ladder

Phases 1–3 made operational: eight rungs, easiest sight first, one axis of
difficulty added at a time. Live progress per rung is on the portal's
**Dataset strategy** page (fed by `dataset_progress()`), each video's rung
is on the Mastersheet (`ds_level`, stamped by criteria discovery or set by
hand), and each rung's search phrases live in `api/run/[stage].js`.
Targets are **distinct shots** — the strategy's currency — and sum to
~3,000, the working estimate for ~92% mAP@50.

| Level | Name | Teaches | Target shots |
|---|---|---|---|
| 1 | Foundation | Orange clays, clear sky, close and slow (slo-mo welcome): what a clay *is* | 600 |
| 2 | Standard sporting | Real presentations — crossers, going-away, skeet, trap, first person | 500 |
| 3 | Dark clays | Black, midi, blaze discs on clear sky | 350 |
| 4 | Overcast | Grey disc on grey sky — most of British shooting | 400 |
| 5 | Cluttered ground | Treeline, hillside, valley backgrounds | 400 |
| 6 | Long and fast | 40-yard birds, high towers, fast crossers, motion blur | 300 |
| 7 | Hard light | Rain, dusk, fog, low winter sun | 250 |
| 8 | Edge cases | Sim-game flushes, rabbit clays, battue and chandelle | 200 |

A rung is *done* when its slice holds target on the golden set — then stop
buying it and fund the thinnest rung instead.

## Standing rules

- No condition exceeds ~40% of the training set by the end.
- A slice that hits target on the golden set is done — stop buying it.
- Third-party footage bootstraps and benchmarks; it is never commercialised.
  The owned dataset (filming days, consenting Brace-app users,
  permission-granted channels tracked on the Sources page) is what ships.
