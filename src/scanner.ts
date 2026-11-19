import type { WorkerRequest, WorkerResponse } from './pipeline/worker';
import type { CapResult } from './pipeline/types';

export interface ScanProgress {
  stage: 'load' | 'detect' | 'ocr';
  done: number;
  total: number;
}

/** A rectangle in image pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Longest image side sent to recognition; larger photos are downscaled to save memory. */
const MAX_SIDE = 4096;

const baseUrl = () => new URL(import.meta.env.BASE_URL, document.baseURI).href;

export const fullRegion = (bitmap: ImageBitmap): Region => ({ x: 0, y: 0, width: bitmap.width, height: bitmap.height });

export const isFullRegion = (r: Region, bitmap: ImageBitmap) => r.x === 0 && r.y === 0 && r.width === bitmap.width && r.height === bitmap.height;

/** Owns the recognition worker. One scan at a time; a new scan supersedes the old one. */
export class Scanner {
  private worker: Worker | null = null;
  private seq = 0;

  private getWorker(): Worker {
    if (!this.worker) this.worker = new Worker(new URL('./pipeline/worker.ts', import.meta.url), { type: 'module' });
    return this.worker;
  }

  /** Start downloading and initializing the recognition engines (~29 MB) before the first scan. */
  preload(): void {
    const msg: WorkerRequest = { type: 'preload', baseUrl: baseUrl() };
    this.getWorker().postMessage(msg);
  }

  /** Scan `region` of `bitmap`. Returned caps are in full-bitmap coordinates. */
  scan(bitmap: ImageBitmap, region: Region, onProgress: (p: ScanProgress) => void): Promise<CapResult[]> {
    const id = ++this.seq;
    const { x, y, width, height } = region;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
    const imgData = ctx.getImageData(0, 0, width, height);
    canvas.width = canvas.height = 0;

    const worker = this.getWorker();
    return new Promise((resolve, reject) => {
      const onMessage = (e: MessageEvent<WorkerResponse>) => {
        const m = e.data;
        if (m.id !== id) return;
        if (id !== this.seq) {
          worker.removeEventListener('message', onMessage);
          reject(new DOMException('superseded', 'AbortError'));
          return;
        }
        if (m.type === 'progress') onProgress({ stage: m.stage, done: m.done, total: m.total });
        else {
          worker.removeEventListener('message', onMessage);
          if (m.type === 'result') resolve(m.results.map((r) => ({ ...r, cx: r.cx + x, cy: r.cy + y })));
          else reject(new Error(m.message));
        }
      };
      worker.addEventListener('message', onMessage);
      const msg: WorkerRequest = {
        type: 'scan',
        id,
        baseUrl: baseUrl(),
        refSize: Math.max(bitmap.width, bitmap.height),
        image: { data: imgData.data, width: imgData.width, height: imgData.height },
      };
      worker.postMessage(msg, [imgData.data.buffer]);
    });
  }
}

/** Decode a user file, honoring EXIF orientation, downscaled to MAX_SIDE. */
export async function decodeImage(file: Blob): Promise<ImageBitmap> {
  const probe = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const long = Math.max(probe.width, probe.height);
  if (long <= MAX_SIDE) return probe;
  const k = MAX_SIDE / long;
  const w = Math.round(probe.width * k);
  const h = Math.round(probe.height * k);
  probe.close();
  return createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
}
