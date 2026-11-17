/** Dump crops + OCR for caps near given coordinates: tsx scripts/debug-cap.ts file out.png x,y [x,y...] */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { loadCv } from '../src/pipeline/cv';
import { detectCaps } from '../src/pipeline/detectCaps';
import { analyzeCap, uprightCandidate } from '../src/pipeline/orientText';
import { createPaddleEngine } from '../src/pipeline/paddleRec';
import { loadImage } from './loadImage';

const [, , file, out, ...pts] = process.argv;
const cv = await loadCv();
const img = await loadImage(file);
const caps = detectCaps(cv, img);
const src = cv.matFromImageData(img);
const ocr = await createPaddleEngine(ort as never, readFileSync('public/models/en-rec/rec.onnx'), readFileSync('public/models/en-rec/dict.txt', 'utf8'));
const T = 192;
const tiles: object[] = [];
let row = 0;
for (const p of pts) {
  const [x, y] = p.split(',').map(Number);
  const cap = caps.reduce((a, b) => (Math.hypot(a.cx - x, a.cy - y) < Math.hypot(b.cx - x, b.cy - y) ? a : b));
  const a = analyzeCap(cv, src, cap);
  console.log(`cap ${Math.round(cap.cx)},${Math.round(cap.cy)} r${Math.round(cap.r)} angle=${a.lineAngle} conf=${a.confident} dark=${a.dark} ink=${a.inkRatio.toFixed(3)}`);
  let col = 0;
  for (const deg of [a.lineAngle, a.lineAngle + 180]) {
    const c = uprightCandidate(cv, src, cap, deg, a.dark);
    const put = (im: { data: Uint8Array; width: number; height: number }, left: number) => {
      const w = Math.min(im.width, T * 2);
      const h = Math.min(im.height, T);
      const rgb = Buffer.alloc(w * h * 3);
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) rgb.fill(im.data[yy * im.width + xx], (yy * w + xx) * 3, (yy * w + xx) * 3 + 3);
      tiles.push({ input: rgb, left, top: row * T, raw: { width: w, height: h, channels: 3 } });
    };
    put(c.image, col * 3 * T);
    if (c.codeLine) put(c.codeLine, col * 3 * T + T);
    const words = c.codeLine ? await ocr.recognize(c.codeLine) : [];
    console.log(`  ${deg.toFixed(0)} layout=${c.layoutScore} nearRim=${c.nearRim} ->`, words.map((w) => `${w.text}:${w.conf.toFixed(0)}`).join(' '));
    col++;
  }
  row++;
}
await sharp({ create: { width: T * 6, height: T * row, channels: 3, background: '#808080' } }).composite(tiles as never).png().toFile(out);
process.exit(0);
