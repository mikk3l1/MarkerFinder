import cvImport from '@techstark/opencv-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

let ready: Promise<CV> | null = null;

/** Resolve the OpenCV.js module once its WASM runtime has initialized. */
export function loadCv(): Promise<CV> {
  if (ready) return ready;
  ready = new Promise<CV>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = cvImport;
    const finish = (cv: CV) => {
      // An Emscripten module is itself "thenable"; strip it so awaiting it doesn't loop.
      if (cv && typeof cv.then === 'function') delete cv.then;
      resolve(cv);
    };
    if (mod && mod.Mat) return finish(mod);
    if (mod && typeof mod.then === 'function') {
      mod.then((cv: CV) => finish(cv));
      return;
    }
    mod.onRuntimeInitialized = () => finish(mod);
  });
  return ready;
}
