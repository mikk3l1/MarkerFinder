import type { CV } from './cv';
import type { Cap, RGBAImage } from './types';

export interface DetectOptions {
  /** Long side (px) of the working copy used for detection. */
  workSize?: number;
  /** Search bounds for the cap radius, as a fraction of the image's long side. */
  minRadiusFrac?: number;
  maxRadiusFrac?: number;
  /** Hough accumulator threshold for the final pass (lower = more circles). */
  accumulator?: number;
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

function hough(cv: CV, gray: CV, minR: number, maxR: number, minDist: number, acc: number): Circle[] {
  const m = new cv.Mat();
  cv.HoughCircles(gray, m, cv.HOUGH_GRADIENT, 1, minDist, 100, acc, minR, maxR);
  const out: Circle[] = [];
  for (let i = 0; i < m.cols; i++) out.push({ x: m.data32F[i * 3], y: m.data32F[i * 3 + 1], r: m.data32F[i * 3 + 2] });
  m.delete();
  return out; // ordered by accumulator votes, strongest first
}

/**
 * Most caps in one photo share a similar size. Scan radius bands and pick the band
 * whose detected circles cover the largest image fraction (packed caps dominate).
 */
function estimateBand(cv: CV, gray: CV, minR: number, maxR: number): [number, number] | null {
  const area = gray.cols * gray.rows;
  let best: [number, number] | null = null;
  let bestCover = 0;
  for (let r = minR; r < maxR; r = Math.max(r + 1, Math.round(r * 1.2))) {
    const hi = Math.round(r * 1.25);
    const n = hough(cv, gray, r, hi, r * 1.5, 25).length;
    const cover = (n * Math.PI * r * r) / area;
    if (cover > bestCover) {
      bestCover = cover;
      best = [r, hi];
    }
  }
  return best;
}

/** Merge circle lists; drop a circle whose center lies within `frac`·r of an earlier one. */
export function mergeCircles<T extends { x: number; y: number; r: number }>(lists: T[][], frac = 0.6): T[] {
  const out: T[] = [];
  for (const list of lists) {
    for (const c of list) {
      const dup = out.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < frac * Math.min(o.r, c.r) * 2 * 0.75);
      if (!dup) out.push(c);
    }
  }
  return out;
}

/**
 * Find circular cap faces. Returns caps in original-image coordinates.
 * The cap radius band is estimated on the luminance channel; circles are then
 * searched on luminance and saturation (pastel caps on white barrels are
 * low-contrast in luminance but not in saturation) and merged.
 */
export function detectCaps(cv: CV, img: RGBAImage, opts: DetectOptions = {}): Cap[] {
  const workSize = opts.workSize ?? 1600;
  const longSide = Math.max(img.width, img.height);
  const scale = Math.min(1, workSize / longSide);

  const src = cv.matFromImageData(img);
  const small = new cv.Mat();
  cv.resize(src, small, new cv.Size(Math.round(img.width * scale), Math.round(img.height * scale)), 0, 0, cv.INTER_AREA);
  src.delete();

  const gray = new cv.Mat();
  cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  cv.medianBlur(gray, gray, 5);

  const rgb = new cv.Mat();
  cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
  small.delete();
  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  rgb.delete();
  const planes = new cv.MatVector();
  cv.split(hsv, planes);
  hsv.delete();
  const sat = planes.get(1).clone();
  planes.delete();
  cv.medianBlur(sat, sat, 5);

  const ws = Math.max(gray.cols, gray.rows);
  const minR = Math.round(ws * (opts.minRadiusFrac ?? 0.01));
  const maxR = Math.round(ws * (opts.maxRadiusFrac ?? 0.06));

  const band = estimateBand(cv, gray, minR, maxR);
  let circles: Circle[] = [];
  if (band) {
    const lo = Math.floor(band[0] * 0.85);
    const hi = Math.ceil(band[1] * 1.15);
    const acc = opts.accumulator ?? 20;
    circles = mergeCircles([hough(cv, gray, lo, hi, lo * 1.5, acc), hough(cv, sat, lo, hi, lo * 1.5, acc)]);
  }
  gray.delete();
  sat.delete();

  return circles.map((c) => ({ cx: c.x / scale, cy: c.y / scale, r: c.r / scale }));
}
