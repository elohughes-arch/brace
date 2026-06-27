// ── Analysis service interface (the hard ML problem lives behind this) ──────
// MVP ships a mock that returns plausible results so the whole app is buildable
// and demoable. Swap `analyzeClip` for the real model later — NO UI changes.
import type { PerShot, TechniqueScores } from '../types';

export interface AnalyzeResult {
  shotsFired: number;
  hits: number;
  accuracy: number;                 // hits / shotsFired (0–100)
  perShot: PerShot[];
  techniqueScores: TechniqueScores; // mount / swing / follow (0–100)
  processedClipUrl: string;
  bestRun: number;
  discipline: string;
}

const DISCIPLINES = ['Sporting', 'Trap', 'Skeet', 'Simulated'];
const r = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

/**
 * analyzeClip — turns a video reference into shooting metrics.
 * @param videoRef local asset uri or storage path
 */
export async function analyzeClip(videoRef: string): Promise<AnalyzeResult> {
  // simulate the model "reading" the footage
  await new Promise((res) => setTimeout(res, 1600));

  const shotsFired = r(25, 100);
  const accuracy = r(58, 92);
  const hits = Math.round((accuracy / 100) * shotsFired);

  // a per-shot timeline (~1.2s cadence), hit/miss weighted by accuracy
  const perShot: PerShot[] = [];
  let run = 0, bestRun = 0;
  for (let i = 0; i < shotsFired; i++) {
    const hit = Math.random() * 100 < accuracy;
    if (hit) { run++; bestRun = Math.max(bestRun, run); } else { run = 0; }
    perShot.push({ t: Number((i * 1.2 + Math.random() * 0.4).toFixed(1)), hit });
  }

  const techniqueScores: TechniqueScores = { mount: r(72, 96), swing: r(70, 94), follow: r(68, 95) };

  return {
    shotsFired,
    hits,
    accuracy: Math.round((hits / shotsFired) * 100),
    perShot,
    techniqueScores,
    processedClipUrl: videoRef,
    bestRun,
    discipline: DISCIPLINES[r(0, DISCIPLINES.length - 1)],
  };
}
