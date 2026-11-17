import type { CV } from './cv';
import type { Cap } from './types';

/** 8-bit grayscale image. */
export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface TextBand {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface UprightCandidate {
  /** Rotation in degrees applied (counter-clockwise) to make text upright. */
  angle: number;
  /** Full cap crop, text dark on light (for debugging/fallback). */
  image: GrayImage;
  /** Crop of the code line only (tallest text line), padded; null if no line found. */
  codeLine: GrayImage | null;
  /** Layout plausibility: +1 code line is tallest and topmost, -1 tallest and bottom-most. */
  layoutScore: number;
  /** Ink reaches the edge of the code-line window: text may be truncated. */
  nearRim: boolean;
}

export interface OrientResult {
  /** Text line direction in [0,180), or null when no text structure was found. */
  lineAngle: number | null;
  /** Fraction of disc pixels classified as text. */
  inkRatio: number;
  candidates: UprightCandidate[];
}

export interface OrientOptions {
  /** Crop size in px (cap diameter maps to this). */
  outputSize?: number;
  /** Pixel height the code line is scaled to before OCR. */
  lineHeight?: number;
}

/** Text lives well inside the cap face; the rim and its shadow are outside this. */
const TEXT_DISC = 0.8;

/** Crop a square around the cap, rotate by `angle` degrees about its center, resize to `size`. Returns gray Mat. */
function cropGrayRotated(cv: CV, src: CV, cap: Cap, angle: number, size: number): CV {
  const s = size / (2 * cap.r);
  const M = cv.getRotationMatrix2D(new cv.Point(cap.cx, cap.cy), angle, s);
  M.doublePtr(0, 2)[0] += size / 2 - cap.cx;
  M.doublePtr(1, 2)[0] += size / 2 - cap.cy;
  const rgba = new cv.Mat();
  cv.warpAffine(src, rgba, M, new cv.Size(size, size), cv.INTER_AREA, cv.BORDER_REPLICATE);
  M.delete();
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  return gray;
}

/** Is the text darker than the cap face? Majority of the inner disc is background. */
function textIsDark(gray: Uint8Array, size: number): boolean {
  const c = (size - 1) / 2;
  const rr = (size / 2) * 0.6;
  const vals: number[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if ((x - c) ** 2 + (y - c) ** 2 <= rr * rr) vals.push(gray[y * size + x]);
  vals.sort((a, b) => a - b);
  const median = vals[vals.length >> 1];
  const p10 = vals[Math.floor(vals.length * 0.1)];
  const p90 = vals[Math.floor(vals.length * 0.9)];
  // Background is the median; text sits in the tail farther from it.
  return median - p10 >= p90 - median;
}

/**
 * Clean text mask (255 = text) for a gray crop: local adaptive threshold with the
 * detected polarity, then keep only character-sized components that stay inside the
 * text disc (removes the rim, its shadow and specular arcs).
 */
function textMask(cv: CV, gray: CV, size: number, dark: boolean): Uint8Array {
  const blur = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0);
  const bin = new cv.Mat();
  const block = (Math.round(size / 6) | 1) + 0;
  cv.adaptiveThreshold(blur, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, dark ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY, block, 10);
  blur.delete();

  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const cents = new cv.Mat();
  const n = cv.connectedComponentsWithStats(bin, labels, stats, cents, 8, cv.CV_32S);
  const c = (size - 1) / 2;
  const rr = (size / 2) * TEXT_DISC;
  const keep = new Uint8Array(n);
  const maxDim = size * 0.45;
  const minArea = Math.max(4, (size * size) / 8000);
  for (let i = 1; i < n; i++) {
    const x = stats.intAt(i, cv.CC_STAT_LEFT);
    const y = stats.intAt(i, cv.CC_STAT_TOP);
    const w = stats.intAt(i, cv.CC_STAT_WIDTH);
    const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
    const area = stats.intAt(i, cv.CC_STAT_AREA);
    if (area < minArea || w > maxDim || h > maxDim) continue;
    // all four bbox corners' nearest points must lie inside the text disc
    const fx = Math.max(Math.abs(x - c), Math.abs(x + w - 1 - c));
    const fy = Math.max(Math.abs(y - c), Math.abs(y + h - 1 - c));
    const nearX = Math.min(Math.abs(x - c), Math.abs(x + w - 1 - c));
    const nearY = Math.min(Math.abs(y - c), Math.abs(y + h - 1 - c));
    const centerInside = (cents.doubleAt(i, 0) - c) ** 2 + (cents.doubleAt(i, 1) - c) ** 2 <= rr * rr;
    const farOutside = fx * fx + nearY * nearY > (size / 2) ** 2 * 0.92 || nearX * nearX + fy * fy > (size / 2) ** 2 * 0.92;
    if (!centerInside || farOutside) continue;
    // thin long arcs: low fill ratio and elongated
    const fill = area / (w * h);
    if (fill < 0.12 && Math.max(w, h) > size * 0.15) continue;
    keep[i] = 1;
  }
  const lab = labels.data32S as Int32Array;
  const mask = new Uint8Array(size * size);
  for (let i = 0; i < mask.length; i++) if (keep[lab[i]]) mask[i] = 255;
  labels.delete();
  stats.delete();
  cents.delete();
  bin.delete();
  return mask;
}

/**
 * Estimate text line direction by maximizing projection-profile energy:
 * when lines are horizontal, row sums are peaky (lines vs gaps).
 * Returns the angle in [0,180) and a peakiness ratio vs the mean over all angles.
 */
export function estimateLineAngle(mask: Uint8Array, size: number): { angle: number; score: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (mask[y * size + x]) {
        xs.push(x - c);
        ys.push(y - c);
      }
  const n = xs.length;
  if (n < 30) return { angle: 0, score: 0 };
  const bins = new Float64Array(size * 2 + 2);
  const energy = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    const s = Math.sin(t);
    const co = Math.cos(t);
    bins.fill(0);
    for (let i = 0; i < n; i++) bins[Math.round(-xs[i] * s + ys[i] * co + size)]++;
    let e = 0;
    for (let i = 0; i < bins.length; i++) e += bins[i] * bins[i];
    return e;
  };
  let best = 0;
  let bestE = -1;
  let sum = 0;
  let cnt = 0;
  for (let a = 0; a < 180; a += 2) {
    const e = energy(a);
    sum += e;
    cnt++;
    if (e > bestE) {
      bestE = e;
      best = a;
    }
  }
  for (let a = best - 2; a <= best + 2; a += 0.5) {
    const e = energy(a);
    if (e > bestE) {
      bestE = e;
      best = a;
    }
  }
  return { angle: ((best % 180) + 180) % 180, score: bestE / (sum / cnt) };
}

/** Split a text mask (nonzero = text) into horizontal text bands at profile valleys. */
export function findBands(mask: Uint8Array, w: number, h: number): TextBand[] {
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (mask[y * w + x]) n++;
    rows[y] = n;
  }
  // light smoothing, then valleys below a fraction of the peak separate lines
  const sm = new Float64Array(h);
  for (let y = 0; y < h; y++) sm[y] = (rows[Math.max(0, y - 1)] + rows[y] * 2 + rows[Math.min(h - 1, y + 1)]) / 4;
  let peak = 0;
  for (let y = 0; y < h; y++) peak = Math.max(peak, sm[y]);
  if (peak === 0) return [];
  const thr = Math.max(1, peak * 0.12);
  const raw: [number, number][] = [];
  let start = -1;
  for (let y = 0; y <= h; y++) {
    const on = y < h && sm[y] >= thr;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      raw.push([start, y - 1]);
      start = -1;
    }
  }
  const minH = Math.max(4, h * 0.035);
  const bands: TextBand[] = [];
  for (const [t0, b0] of raw) {
    // extend to where the raw profile actually reaches zero-ish, bounded by neighbors
    let t = t0;
    let b = b0;
    while (t > 0 && rows[t - 1] > 0 && sm[t - 1] < sm[t]) t--;
    while (b < h - 1 && rows[b + 1] > 0 && sm[b + 1] < sm[b]) b++;
    if (b - t + 1 < minH) continue;
    let left = w;
    let right = -1;
    for (let y = t; y <= b; y++)
      for (let x = 0; x < w; x++)
        if (mask[y * w + x]) {
          if (x < left) left = x;
          if (x > right) right = x;
        }
    if (right - left >= h * 0.05) bands.push({ top: t, bottom: b, left, right });
  }
  return bands;
}

/** Pick the code line: the tallest band (ties favor the upper one). */
function codeBand(bands: TextBand[]): { band: TextBand; layoutScore: number } | null {
  if (bands.length === 0) return null;
  let bi = 0;
  for (let i = 1; i < bands.length; i++) {
    const hi = bands[i].bottom - bands[i].top;
    const hb = bands[bi].bottom - bands[bi].top;
    if (hi > hb * 1.08) bi = i;
  }
  const layoutScore = bands.length === 1 ? 0 : bi === 0 ? 1 : bi === bands.length - 1 ? -1 : 0;
  return { band: bands[bi], layoutScore };
}

/**
 * Render the code line for OCR: the full chord of the cap face across the band's
 * rows (so characters near the rim are never cut off), contrast-stretched so text
 * is dark; pixels outside the cap face are white.
 */
function renderLine(gray: Uint8Array, mask: Uint8Array, size: number, b: TextBand, targetH: number): { line: GrayImage; edgeInk: boolean } {
  const pad = Math.max(2, Math.round((b.bottom - b.top) * 0.2));
  const t = Math.max(0, b.top - pad);
  const bo = Math.min(size - 1, b.bottom + pad);
  // Horizontal extent: detected text plus ~one character of margin per side, so a
  // glyph dropped by the mask (e.g. touching the rim) is still visible to OCR.
  const charW = Math.round((b.bottom - b.top) * 0.75);
  const l = Math.max(0, b.left - charW);
  const r = Math.min(size - 1, b.right + charW);
  const sw = r - l + 1;
  const sh = bo - t + 1;

  // ink/background levels from the band's text mask
  let inkSum = 0;
  let inkN = 0;
  let bgSum = 0;
  let bgN = 0;
  for (let y = b.top; y <= b.bottom; y++)
    for (let x = b.left; x <= b.right; x++) {
      const v = gray[y * size + x];
      if (mask[y * size + x]) {
        inkSum += v;
        inkN++;
      } else {
        bgSum += v;
        bgN++;
      }
    }
  const ink = inkN ? inkSum / inkN : 0;
  const bg = bgN ? bgSum / bgN : 255;
  const span = bg - ink || 1;
  const src = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const v = ((gray[(y + t) * size + (x + l)] - ink) / span) * 255;
      src[y * sw + x] = Math.max(0, Math.min(255, v));
    }

  // Ink in the outer columns of the window (within the band rows) means the text may
  // continue beyond what OCR sees: a truncated code could still look valid.
  const edgeW = Math.max(2, Math.round(sw * 0.06));
  const bandRows = b.bottom - b.top + 1;
  let edgeInk = false;
  for (const [x0, x1] of [[0, edgeW], [sw - edgeW, sw]]) {
    let n = 0;
    for (let y = b.top - t; y <= b.bottom - t; y++) for (let x = x0; x < x1; x++) if (src[y * sw + x] < 110) n++;
    if (n > bandRows * edgeW * 0.08) edgeInk = true;
  }
  // Also truncated when the window itself hit the crop border.
  if (b.left - charW < 0 || b.right + charW > size - 1) edgeInk = true;

  // bilinear resample to target height, with a white border
  const k = targetH / sh;
  const ow = Math.max(1, Math.round(sw * k));
  const oh = targetH;
  const border = Math.round(oh * 0.15);
  const W = ow + 2 * border;
  const H = oh + 2 * border;
  const out = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < oh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) / k - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) / k - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const v = (src[y0 * sw + x0] * (1 - fx) + src[y0 * sw + x1] * fx) * (1 - fy) + (src[y1 * sw + x0] * (1 - fx) + src[y1 * sw + x1] * fx) * fy;
      out[(y + border) * W + (x + border)] = v;
    }
  }
  return { line: { data: out, width: W, height: H }, edgeInk };
}

function toTextDark(gray: Uint8Array, dark: boolean): Uint8Array {
  if (dark) return gray.slice();
  const o = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) o[i] = 255 - gray[i];
  return o;
}

export interface CapAnalysis {
  /** Text line direction in [0,180). */
  lineAngle: number;
  /** Whether the line angle estimate is trustworthy. */
  confident: boolean;
  /** Text darker than the cap face. */
  dark: boolean;
  /** Fraction of the text disc classified as text. */
  inkRatio: number;
}

/** Estimate text polarity and line direction for a cap (no rotation yet). */
export function analyzeCap(cv: CV, srcRgba: CV, cap: Cap, opts: OrientOptions = {}): CapAnalysis {
  const size = opts.outputSize ?? 192;
  const g0 = cropGrayRotated(cv, srcRgba, cap, 0, size);
  const dark = textIsDark(g0.data as Uint8Array, size);
  const m0 = textMask(cv, g0, size, dark);
  g0.delete();
  let ink = 0;
  for (let i = 0; i < m0.length; i++) if (m0[i]) ink++;
  const inkRatio = ink / (Math.PI * (size / 2) ** 2 * TEXT_DISC ** 2);
  const { angle, score } = estimateLineAngle(m0, size);
  return { lineAngle: angle, confident: score > 1.15 && inkRatio > 0.01 && inkRatio < 0.5, dark, inkRatio };
}

/**
 * Rotate the cap by `deg` (counter-clockwise; the line-angle estimate θ makes lines
 * horizontal at deg = θ) and isolate the code line, assuming the given polarity.
 */
export function uprightCandidate(cv: CV, srcRgba: CV, cap: Cap, deg: number, dark: boolean, opts: OrientOptions = {}): UprightCandidate {
  const size = opts.outputSize ?? 192;
  const g = cropGrayRotated(cv, srcRgba, cap, deg, size);
  const gd = (g.data as Uint8Array).slice();
  const mask = textMask(cv, g, size, dark);
  g.delete();
  const image = { data: toTextDark(gd, dark), width: size, height: size };
  const cb = codeBand(findBands(mask, size, size));
  const rendered = cb ? renderLine(gd, mask, size, cb.band, opts.lineHeight ?? 40) : null;
  const codeLine = rendered?.line ?? null;
  return { angle: ((deg % 360) + 360) % 360, image, codeLine, layoutScore: cb?.layoutScore ?? 0, nearRim: rendered?.edgeInk ?? false };
}

/**
 * Convenience: analysis + the two primary upright candidates (θ, θ+180), or four
 * axis-aligned rotations when no line structure was found.
 */
export function orientCap(cv: CV, srcRgba: CV, cap: Cap, opts: OrientOptions = {}): OrientResult {
  const a = analyzeCap(cv, srcRgba, cap, opts);
  const angles = a.confident ? [a.lineAngle, a.lineAngle + 180] : [0, 90, 180, 270];
  return {
    lineAngle: a.confident ? a.lineAngle : null,
    inkRatio: a.inkRatio,
    candidates: angles.map((deg) => uprightCandidate(cv, srcRgba, cap, deg, a.dark, opts)),
  };
}
