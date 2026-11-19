# Marker Finder

Mobile-first web app that finds a specific Ohuhu marker in a photo of a collection. Take or choose a photo, type a code (`BG3`, `YR313`), and the matching cap is highlighted on the photo.

Everything runs in the browser. There is no backend, no upload and no external API. The models are static files served with the app.

## Usage

```bash
nvm use            # Node 22 (see .nvmrc)
npm install
npm run dev        # http://localhost:5173 (add -- --host to test on a phone over LAN)
npm run build      # static site in dist/
npm run preview    # serve dist/
```

`dist/` uses a relative base path, so it can be deployed to any GitHub Pages path as-is.

## How it works

One scan per photo runs in a Web Worker. Searching reads only the stored results and never rescans.

The worker starts downloading and initializing the models (~29 MB) when the app opens, so this overlaps with taking the photo (skipped when the browser's data saver is on). After a photo is chosen, the user can crop it to the part that holds the markers. Only that region is scanned, and scan time scales with the number of caps in it (a quarter of the photo scans about 4× faster). A crop is processed at the same scale as the full photo ([detectCaps.ts](src/pipeline/detectCaps.ts) `refSize`), so cap sizes and detection thresholds don't change.

1. **Cap detection** ([detectCaps.ts](src/pipeline/detectCaps.ts)): OpenCV Hough circles on a 1600 px copy of the photo. The typical cap radius is estimated first, by scanning radius bands for the band whose circles cover the most area. Circles are then searched for on luminance and on saturation (pastel caps against white barrels) and merged.
2. **Orientation** ([orientText.ts](src/pipeline/orientText.ts)): per cap, an adaptive-threshold text mask with rim and arc components removed, then a projection-profile search for the text line angle. The code is always the tallest line and sits on top. That layout rule picks between θ and θ+180 and isolates the code line.
3. **Recognition** ([paddleRec.ts](src/pipeline/paddleRec.ts)): PP-OCRv5 English text-line recognizer (ONNX, 7.8 MB) on ONNX Runtime Web (WASM, single-threaded).
4. **Validation** ([codes.ts](src/pipeline/codes.ts), [recognize.ts](src/pipeline/recognize.ts)): output must match the Ohuhu code format. At most one OCR confusion is repaired (`YR2S`→`YR25`). A reading is **confirmed** only if all of these hold:
   - it needed no repair;
   - its least-certain character has ≥ 90% probability;
   - the code line didn't run off the edge of the crop (truncation guard).

   Everything else is **uncertain** or **failed**. If a cap isn't confirmed, the pipeline retries the ±90° orientations and then the opposite text polarity.
5. **Search** ([search.ts](src/search.ts)): exact, case-insensitive, full-code match. Results are split into confirmed (solid circle), uncertain (dashed) and, only when nothing is confirmed, look-alike codes (e.g. `R43` when searching `R48`).

## Measured on the sample photos

| Photo | Caps with visible code | Confirmed | False confirmed | Scan time (desktop Chromium) |
|---|---|---|---|---|
| `samples/PXL_…709353.jpg` (≈45 markers, slightly blurred) | 38 | 28 (74%) | 0 | 10 s incl. model load |
| `samples/PXL_…705819.jpg` (≈450 markers) | not fully labeled | 176 | 1 found by visual audit (`R48` read as `R43`) | 30 s |

On phones, expect scans to take a few times longer than these desktop figures.

Known weak spots:
- dark and low-contrast caps (dark browns, saturated blues and violets);
- caps where a reflection arc crosses the text;
- caps the circle detector misses (about 15–20% in the dense photo).

## Development tools

```bash
npm test                         # unit tests (Vitest)
npm run eval                     # pipeline accuracy on samples/ vs samples/ground-truth.json; overlays in eval-out/
QUADS=1 VERBOSE=1 npm run eval   # + per-cap readings and quadrant overlays for visual audits
npx tsx scripts/debug-cap.ts samples/<photo> out.png 634,764   # crops + OCR for the cap nearest a pixel
npx tsx scripts/e2e.ts [outDir]  # headless Chromium end-to-end test of dist/ (run npm run build first)
```

The e2e test fails on console errors and on any request outside the app's own origin. Chromium needs `libnss3`, `libnspr4` and `libasound2`. If they aren't installed system-wide, extract them locally with `apt-get download` + `dpkg-deb -x` and set `LD_LIBRARY_PATH`.

## Third-party assets

- PP-OCRv5 English recognition model, converted to ONNX: [monkt/paddleocr-onnx](https://huggingface.co/monkt/paddleocr-onnx), Apache-2.0, from PaddleOCR.
- OpenCV.js via `@techstark/opencv-js`, Apache-2.0.
- ONNX Runtime Web, MIT.
