/**
 * Run the recognition pipeline on sample photos and report accuracy against
 * samples/ground-truth.json. Writes an annotated overlay per sample to --out.
 *   npm run eval -- [--out dir] [files...]
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import sharp from 'sharp';
import { loadCv } from '../src/pipeline/cv';
import * as ort from 'onnxruntime-node';
import { createPaddleEngine } from '../src/pipeline/paddleRec';
import { recognize } from '../src/pipeline/recognize';
import { loadImage } from './loadImage';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args.splice(outIdx, 2)[1] : 'eval-out';
const files = args.length ? args : ['samples/PXL_20261117_133705819.jpg', 'samples/PXL_20261117_133709353.jpg'];
mkdirSync(outDir, { recursive: true });

const gt: Record<string, { codes: string[] }> = JSON.parse(readFileSync('samples/ground-truth.json', 'utf8'));
const cv = await loadCv();
const env = (k: string) => process.env[k];
const ocr = await createPaddleEngine(ort as never, readFileSync('public/models/en-rec/rec.onnx'), readFileSync('public/models/en-rec/dict.txt', 'utf8'));
const orient = { outputSize: Number(env('SIZE') ?? 192), lineHeight: Number(env('LINEH') ?? 40) };
console.log('config', orient);

for (const f of files) {
  const img = await loadImage(f);
  const t0 = performance.now();
  const results = await recognize(cv, img, ocr, { concurrency: 8, orient });
  const ms = performance.now() - t0;
  const confirmed = results.filter((r) => r.status === 'confirmed');
  const uncertain = results.filter((r) => r.status === 'uncertain');
  const failed = results.filter((r) => r.status === 'failed');
  console.log(`\n${basename(f)}: ${results.length} caps, ${confirmed.length} confirmed, ${uncertain.length} uncertain, ${failed.length} failed, ${(ms / 1000).toFixed(1)} s`);

  if (env('VERBOSE'))
    for (const r of results) console.log(`   ${Math.round(r.cx)},${Math.round(r.cy)} r${Math.round(r.r)} ${r.status} ${r.code} raw=${JSON.stringify(r.rawText)} conf=${r.conf.toFixed(0)} angle=${r.angle.toFixed(0)}`);
  const truth = gt[basename(f)]?.codes;
  if (truth) {
    const tset = new Set(truth);
    const conf = new Set(confirmed.map((r) => r.code!));
    const any = new Set([...confirmed, ...uncertain].map((r) => r.code!));
    const fp = [...conf].filter((c) => !tset.has(c));
    const fpU = [...any].filter((c) => !tset.has(c) && !conf.has(c));
    const missed = truth.filter((c) => !any.has(c));
    console.log(`  recall confirmed ${[...conf].filter((c) => tset.has(c)).length}/${truth.length}, incl. uncertain ${truth.length - missed.length}/${truth.length}`);
    console.log(`  FALSE confirmed: ${fp.join(' ') || '-'} | false uncertain: ${fpU.join(' ') || '-'}`);
    console.log(`  missed: ${missed.join(' ') || '-'}`);
  } else {
    console.log('  confirmed:', confirmed.map((r) => r.code).sort().join(' '));
    console.log('  uncertain:', uncertain.map((r) => `${r.code}(${Math.round(r.conf)})`).join(' '));
  }

  const color = { confirmed: '#00e000', uncertain: '#ffb000', failed: '#ff2020' };
  const fs = Math.round(Math.max(img.width, img.height) / 90);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}">${results
    .map(
      (r) =>
        `<circle cx="${r.cx}" cy="${r.cy}" r="${r.r}" fill="none" stroke="${color[r.status]}" stroke-width="6"/>` +
        (r.code ? `<text x="${r.cx}" y="${r.cy - r.r - 6}" font-size="${fs}" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="${color[r.status]}" stroke="black" stroke-width="3" paint-order="stroke">${r.code}</text>` : ''),
    )
    .join('')}</svg>`;
  const full = await sharp(f).rotate().composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  await sharp(full).resize(2000).jpeg({ quality: 85 }).toFile(`${outDir}/${basename(f, '.jpg')}.overlay.jpg`);
  if (env('QUADS')) {
    const hw = Math.floor(img.width / 2);
    const hh = Math.floor(img.height / 2);
    for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]])
      await sharp(full).extract({ left: qx * hw, top: qy * hh, width: hw, height: hh }).jpeg({ quality: 85 }).toFile(`${outDir}/${basename(f, '.jpg')}.q${qx}${qy}.jpg`);
  }
}
await ocr.terminate();
process.exit(0);
