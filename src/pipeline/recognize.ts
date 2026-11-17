import type { CV } from './cv';
import { detectCaps } from './detectCaps';
import { parseCode } from './codes';
import type { OcrEngine } from './ocr';
import { analyzeCap, uprightCandidate, type OrientOptions } from './orientText';
import type { Cap, CapResult, RGBAImage } from './types';

export interface RecognizeOptions {
  /** OCR confidence (0–100) required for a confirmed result. */
  confirmConf?: number;
  /** Minimum confidence for an uncertain result; below this the cap counts as failed. */
  minConf?: number;
  onProgress?: (done: number, total: number, stage: 'detect' | 'ocr') => void;
  /** Max caps OCR'd concurrently (should be ≥ the OCR worker count). */
  concurrency?: number;
  orient?: OrientOptions;
}

interface Reading {
  code: string;
  raw: string;
  conf: number;
  angle: number;
  fixes: number;
  /** Reading came from a code line touching the rim (possible truncation). */
  nearRim: boolean;
}

/**
 * Choose the best code reading for one cap. Attempts escalate only while no
 * confirmed reading exists:
 *   1. estimated line angle θ and θ+180, ordered by layout (code line on top)
 *   2. θ±90 (line angle estimate off by a quarter turn)
 *   3. the opposite text polarity
 * A reading that needed character repairs is never confirmed.
 */
export async function readCap(cv: CV, src: CV, cap: Cap, ocr: OcrEngine, opts: RecognizeOptions): Promise<CapResult> {
  const confirmConf = opts.confirmConf ?? 90;
  const minConf = opts.minConf ?? 50;
  const a = analyzeCap(cv, src, cap, opts.orient);
  const base = a.confident ? a.lineAngle : 0;
  const attempts: { angles: number[]; dark: boolean }[] = [
    { angles: [base, base + 180], dark: a.dark },
    { angles: [base + 90, base + 270], dark: a.dark },
    { angles: [base, base + 180, base + 90, base + 270], dark: !a.dark },
  ];
  let best: Reading | null = null;
  let firstRaw = '';
  const isConfirmed = (r: Reading | null) => r !== null && r.fixes === 0 && !r.nearRim && r.conf >= confirmConf && r.code !== '0';
  const confirmed = () => isConfirmed(best);

  for (const at of attempts) {
    if (confirmed()) break;
    const cands = at.angles.map((deg) => uprightCandidate(cv, src, cap, deg, at.dark, opts.orient)).sort((x, y) => y.layoutScore - x.layoutScore);
    for (const c of cands) {
      if (confirmed()) break;
      if (!c.codeLine) continue;
      const words = await ocr.recognize(c.codeLine);
      const text = words.map((w) => w.text).join('');
      if (!firstRaw) firstRaw = text;
      const options = [{ text, conf: words.length ? Math.min(...words.map((w) => w.conf)) : 0 }, ...(words.length > 1 ? words.map((w) => ({ text: w.text, conf: w.conf })) : [])];
      for (const o of options) {
        const parsed = parseCode(o.text);
        if (!parsed) continue;
        const cand: Reading = { code: parsed.code, raw: o.text, conf: o.conf - parsed.fixes * 20, angle: c.angle, fixes: parsed.fixes, nearRim: c.nearRim };
        const cur = best as Reading | null;
        // Prefer readings that could be confirmed; then fewer repairs; then confidence.
        const key = (r: Reading) => [isConfirmed(r) ? 1 : 0, r.conf >= minConf ? 1 : 0, -r.fixes, r.nearRim ? 0 : 1, r.conf];
        const better = !cur || key(cand).join() !== key(cur).join() && (() => { const a = key(cand), b2 = key(cur); for (let i = 0; i < a.length; i++) if (a[i] !== b2[i]) return a[i] > b2[i]; return false; })();
        if (better) best = cand;
      }
    }
  }
  const b = best as Reading | null;
  if (!b || b.conf < minConf) {
    return { ...cap, code: b?.code ?? null, rawText: b?.raw ?? firstRaw, conf: b?.conf ?? 0, status: 'failed', angle: b?.angle ?? 0 };
  }
  const status = isConfirmed(b) ? 'confirmed' : 'uncertain';
  return { ...cap, code: b.code, rawText: b.raw, conf: Math.min(100, b.conf), status, angle: b.angle };
}

/**
 * Full pipeline: detect caps, OCR each one, de-duplicate overlapping detections.
 * Runs once per image; searching is done on the returned list.
 */
export async function recognize(cv: CV, img: RGBAImage, ocr: OcrEngine, opts: RecognizeOptions = {}): Promise<CapResult[]> {
  opts.onProgress?.(0, 1, 'detect');
  const caps = detectCaps(cv, img);
  opts.onProgress?.(1, 1, 'detect');
  const src = cv.matFromImageData(img);
  const out: CapResult[] = new Array(caps.length);
  let next = 0;
  let done = 0;
  const conc = opts.concurrency ?? 4;
  try {
    await Promise.all(
      Array.from({ length: conc }, async () => {
        while (next < caps.length) {
          const i = next++;
          out[i] = await readCap(cv, src, caps[i], ocr, opts);
          opts.onProgress?.(++done, caps.length, 'ocr');
        }
      }),
    );
  } finally {
    src.delete();
  }
  return dedupe(out);
}

/** Overlapping detections of the same cap: keep the most confident reading. */
export function dedupe(results: CapResult[]): CapResult[] {
  const rank = (r: CapResult) => (r.status === 'confirmed' ? 2 : r.status === 'uncertain' ? 1 : 0) * 1000 + r.conf;
  const sorted = [...results].sort((a, b) => rank(b) - rank(a));
  const kept: CapResult[] = [];
  for (const r of sorted) {
    if (kept.some((k) => Math.hypot(k.cx - r.cx, k.cy - r.cy) < 0.8 * Math.min(k.r, r.r))) continue;
    kept.push(r);
  }
  return kept;
}
