import type { OcrEngine, OcrWord } from './ocr';
import type { GrayImage } from './orientText';

/**
 * Minimal subset of the onnxruntime API shared by onnxruntime-web and
 * onnxruntime-node, so the same recognizer runs in the browser and in Node eval.
 */
export interface OrtLike {
  InferenceSession: { create(model: ArrayBuffer | Uint8Array | string, opts?: object): Promise<OrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
}

const H = 48;
const MAX_W = 320;

/**
 * PP-OCR text-line recognizer (CTC). Input: a single text line, dark on light.
 * Output: one "word" holding the decoded line and its mean character probability (0–100).
 */
export async function createPaddleEngine(ort: OrtLike, model: ArrayBuffer | Uint8Array | string, dictText: string, sessionOpts?: object): Promise<OcrEngine> {
  const session = await ort.InferenceSession.create(model, sessionOpts);
  // class 0 = CTC blank, 1..N = dict entries, N+1 = space
  const chars = ['', ...dictText.split(/\r?\n/).filter((l, i, a) => l.length > 0 || i < a.length - 1), ' '];
  let queue = Promise.resolve();

  async function run(img: GrayImage): Promise<OcrWord[]> {
    const w = Math.max(8, Math.min(MAX_W, Math.round((img.width * H) / img.height)));
    const data = new Float32Array(3 * H * w);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(img.height - 1, ((y + 0.5) * img.height) / H - 0.5);
      const y0 = Math.max(0, Math.floor(sy));
      const y1 = Math.min(img.height - 1, y0 + 1);
      const fy = Math.max(0, sy - y0);
      for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, ((x + 0.5) * img.width) / w - 0.5);
        const x0 = Math.max(0, Math.floor(sx));
        const x1 = Math.min(img.width - 1, x0 + 1);
        const fx = Math.max(0, sx - x0);
        const p = (yy: number, xx: number) => img.data[yy * img.width + xx];
        const v = (p(y0, x0) * (1 - fx) + p(y0, x1) * fx) * (1 - fy) + (p(y1, x0) * (1 - fx) + p(y1, x1) * fx) * fy;
        const n = v / 127.5 - 1;
        const i = y * w + x;
        data[i] = n;
        data[H * w + i] = n;
        data[2 * H * w + i] = n;
      }
    }
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, H, w]) };
    const out = (await session.run(feeds))[session.outputNames[0]];
    const [, T, C] = out.dims as number[];
    let text = '';
    let probMin = 1;
    let n = 0;
    let prev = 0;
    for (let t = 0; t < T; t++) {
      let best = 0;
      let bp = -Infinity;
      for (let c = 0; c < C; c++) {
        const v = out.data[t * C + c];
        if (v > bp) {
          bp = v;
          best = c;
        }
      }
      if (best !== 0 && best !== prev) {
        text += chars[best] ?? '';
        probMin = Math.min(probMin, bp);
        n++;
      }
      prev = best;
    }
    // Line confidence = least certain character (one bad digit makes the code wrong).
    return text && n ? [{ text: text.trim(), conf: probMin * 100 }] : [];
  }

  return {
    recognize(img) {
      // ONNX Runtime sessions are not re-entrant on the wasm backend: serialize calls.
      const p = queue.then(() => run(img));
      queue = p.then(
        () => undefined,
        () => undefined,
      );
      return p;
    },
    async terminate() {
      /* session is GC'd */
    },
  };
}
