// ── Metrics generation — PLACEHOLDER for the real model ────────────────────
// Until the computer-vision model is wired in, we synthesise a plausible read
// of a session so the whole loop (pick clip → process → metrics) works end to
// end. To go live, replace `processClip()` with a call to your processing model
// (e.g. a Supabase Edge Function triggered by the upload, or your own API), and
// have it write the same fields back onto the session row.

const GROUNDS = ['West Wycombe', 'Bisley', 'Dovers', 'EJ Churchill', 'Owls Lodge', 'Honesberie'];
const DISCIPLINES = ['Sporting', 'Trap', 'Skeet'];

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

// Synthesise metrics for a session. Returns the shape stored on `sessions`.
export function generateMetrics() {
  const targets = pick([50, 75, 100]);
  const rate = rand(64, 92);
  const hits = Math.round((rate / 100) * targets);
  const hitRate = Math.round((hits / targets) * 100);
  const bestRun = rand(6, Math.max(8, Math.round(targets * 0.18)));
  // a WHOOP-style 0–100 "form" score blending hit rate, consistency and timing
  const timeToBreak = (Math.random() * 0.35 + 0.45).toFixed(2); // seconds
  const mount = rand(82, 96); // consistency %
  const score = Math.min(99, Math.round(hitRate * 0.6 + mount * 0.25 + bestRun * 0.6));
  // a hit/miss shot map of length = targets (capped for display)
  const map = [];
  for (let i = 0; i < targets; i++) map.push(Math.random() * 100 < hitRate ? 1 : 0);
  return {
    discipline: pick(DISCIPLINES),
    ground: pick(GROUNDS),
    targets, hits, hitRate, bestRun, score,
    metrics: { timeToBreak: Number(timeToBreak), mount, shotMap: map },
  };
}

// Simulate processing latency (the model "reading" the footage). Resolves with
// the metrics. Swap the body for a real upload+model call.
export function processClip(/* file */) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(generateMetrics()), 50);
  });
}

export const PROC_STEPS = [
  'Uploading your footage…',
  'Reading the session…',
  'Finding every shot…',
  'Calling hits and misses…',
  'Scoring your form…',
];

export function greeting(d = new Date()) {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
