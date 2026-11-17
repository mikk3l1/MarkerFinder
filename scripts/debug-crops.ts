/** Write a contact sheet of the binarized upright candidates for the first N caps. */
import sharp from 'sharp';
import { loadCv } from '../src/pipeline/cv';
import { detectCaps } from '../src/pipeline/detectCaps';
import { orientCap } from '../src/pipeline/orientText';
import { loadImage } from './loadImage';

const [, , file, out, nStr] = process.argv;
const cv = await loadCv();
const img = await loadImage(file);
const caps = detectCaps(cv, img).slice(Number(process.argv[5] ?? 0), Number(process.argv[5] ?? 0) + Number(nStr ?? 24));
const src = cv.matFromImageData(img);
const tiles: { input: Buffer; left: number; top: number }[] = [];
const T = 224;
caps.forEach((cap, row) => {
  const res = orientCap(cv, src, cap);
  res.candidates.slice(0, 2).forEach((c, col) => {
    const put = (im: { data: Uint8Array; width: number; height: number }, left: number) => {
      const w = Math.min(im.width, T);
      const h = Math.min(im.height, T);
      const rgb = Buffer.alloc(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.fill(im.data[y * im.width + x], (y * w + x) * 3, (y * w + x) * 3 + 3);
      tiles.push({ input: rgb, left, top: row * T, raw: { width: w, height: h, channels: 3 } } as never);
    };
    put(c.image, col * 2 * T);
    if (c.codeLine) put(c.codeLine, col * 2 * T + T);
  });
  console.log(row, Math.round(cap.cx), Math.round(cap.cy), 'lineAngle', res.lineAngle?.toFixed(1), 'layout', res.candidates.map((c) => c.layoutScore).join('/'));
});
await sharp({ create: { width: T * 4, height: T * caps.length, channels: 3, background: '#808080' } }).composite(tiles).png().toFile(out);
process.exit(0);
