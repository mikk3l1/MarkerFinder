/// <reference lib="webworker" />
/**
 * Recognition worker: OpenCV.js + PP-OCR (ONNX Runtime Web, WASM), all loaded from
 * this site's static files. Models are loaded once and reused across scans.
 */
import * as ort from 'onnxruntime-web/wasm';
import { loadCv, type CV } from './cv';
import type { OcrEngine } from './ocr';
import { createPaddleEngine } from './paddleRec';
import { recognize } from './recognize';
import type { CapResult, RGBAImage } from './types';

/**
 * `baseUrl` is the absolute app root; relative URLs inside a worker resolve against the worker script.
 * `refSize` is the long side of the full photo when `image` is a crop of it.
 * `preload` downloads and initializes the engines ahead of the first scan.
 */
export type WorkerRequest =
  | { type: 'scan'; id: number; image: RGBAImage; baseUrl: string; refSize?: number }
  | { type: 'preload'; baseUrl: string };
export type WorkerResponse =
  | { type: 'progress'; id: number; stage: 'load' | 'detect' | 'ocr'; done: number; total: number }
  | { type: 'result'; id: number; results: CapResult[]; ms: number }
  | { type: 'error'; id: number; message: string };

let engines: Promise<{ cv: CV; ocr: OcrEngine }> | null = null;

function loadEngines(base: string): Promise<{ cv: CV; ocr: OcrEngine }> {
  if (!engines) {
    ort.env.wasm.wasmPaths = `${base}ort/`;
    // Threads need cross-origin isolation, which static hosts like GitHub Pages lack.
    ort.env.wasm.numThreads = 1;
    engines = (async () => {
      const [cv, model, dict] = await Promise.all([
        loadCv(),
        fetch(`${base}models/en-rec/rec.onnx`).then((r) => {
          if (!r.ok) throw new Error(`model download failed (${r.status})`);
          return r.arrayBuffer();
        }),
        fetch(`${base}models/en-rec/dict.txt`).then((r) => r.text()),
      ]);
      const ocr = await createPaddleEngine(ort as never, new Uint8Array(model), dict, { executionProviders: ['wasm'] });
      return { cv, ocr };
    })();
    engines.catch(() => (engines = null));
  }
  return engines;
}

const post = (m: WorkerResponse) => (self as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === 'preload') {
    // Failure is not reported here: engines reset on error and the next scan retries and reports it.
    loadEngines(msg.baseUrl).catch(() => undefined);
    return;
  }
  const { id } = msg;
  try {
    post({ type: 'progress', id, stage: 'load', done: 0, total: 1 });
    const { cv, ocr } = await loadEngines(msg.baseUrl);
    const t0 = performance.now();
    const results = await recognize(cv, msg.image, ocr, {
      concurrency: 2,
      detect: { refSize: msg.refSize },
      onProgress: (done, total, stage) => post({ type: 'progress', id, stage, done, total }),
    });
    post({ type: 'result', id, results, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
  }
};
