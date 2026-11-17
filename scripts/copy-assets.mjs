// Copy ONNX Runtime's WASM runtime into public/ so it is served as a static file.
import { copyFileSync, mkdirSync } from 'node:fs';
const src = 'node_modules/onnxruntime-web/dist/';
const dst = 'public/ort/';
mkdirSync(dst, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copyFileSync(src + f, dst + f);
console.log('copied onnxruntime-web wasm to', dst);
