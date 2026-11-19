/**
 * End-to-end check of the production build in headless Chromium.
 *   npm run build && npx tsx scripts/e2e.ts [outDir]
 * Loads a sample photo through the file input, waits for recognition, runs
 * searches, saves screenshots, and fails on console errors or off-origin requests.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, devices } from 'playwright';

const outDir = process.argv[2] ?? 'e2e-out';
// TIMING_ONLY=<photo> scans that photo, reports the time, and exits.
const timingOnly = process.env.TIMING_ONLY;
mkdirSync(outDir, { recursive: true });
const PORT = 4179;
const origin = `http://localhost:${PORT}`;

// Own process group, so cleanup also stops Vite's child processes.
const server = spawn('node_modules/.bin/vite', ['preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
const stopServer = () => {
  try {
    process.kill(-server.pid!, 'SIGTERM');
  } catch {
    /* already gone */
  }
};
process.on('exit', stopServer);
await new Promise<void>((resolve, reject) => {
  server.stdout.on('data', (d) => d.toString().includes(String(PORT)) && resolve());
  server.on('exit', (c) => reject(new Error(`preview exited ${c}`)));
  setTimeout(() => reject(new Error('preview did not start')), 20000);
});

const failures: string[] = [];
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const offOrigin: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:')) offOrigin.push(u);
  });
  page.on('console', (m) => m.type() === 'error' && failures.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));

  await page.goto(`${origin}/`);
  await page.screenshot({ path: `${outDir}/1-intro.png` });

  // Models start downloading on page load, before a photo is chosen.
  await page.waitForResponse((r) => r.url().endsWith('/models/en-rec/rec.onnx'), { timeout: 30000 });

  await page.locator('input[type=file]:not([capture])').setInputFiles(timingOnly ?? 'samples/PXL_20261117_133709353.jpg');
  await page.getByRole('button', { name: 'Scan photo' }).waitFor();
  await page.screenshot({ path: `${outDir}/1b-crop.png` });
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Scan photo' }).click();
  await page.getByText(/Read \d+ codes|No marker codes|Recognition failed/).waitFor({ timeout: 240000 });
  const status = await page.locator('.msg').first().innerText();
  console.log(`scan: ${((Date.now() - t0) / 1000).toFixed(1)} s — ${status}`);
  if (!/Read \d+ codes/.test(status)) failures.push(`scan status: ${status}`);
  await page.screenshot({ path: `${outDir}/2-scanned.png` });
  if (timingOnly) throw new Error('TIMING_DONE');

  const search = async (q: string, shot: string) => {
    await page.getByLabel('Marker code').fill(q);
    await page.getByRole('button', { name: 'Find' }).click();
    await page.waitForTimeout(400);
    const msg = await page.locator('.msg').first().innerText();
    await page.screenshot({ path: `${outDir}/${shot}.png` });
    console.log(`search ${JSON.stringify(q)}: ${msg}`);
    return msg;
  };
  if (!/^Found YR313/.test(await search('yr313', '3-yr313'))) failures.push('YR313 not found');
  if (!/^Found E515/.test(await search(' E515 ', '4-e515'))) failures.push('E515 not found');
  if (!/not found in this photo/.test(await search('BG3', '5-bg3'))) failures.push('BG3 should be absent');
  if (!/not an Ohuhu code/.test(await search('hello', '6-invalid'))) failures.push('invalid query not flagged');

  // Rescan replaces results; the current query is re-applied to the new results.
  await search('YR313', '7-before-rescan');
  await page.getByRole('button', { name: 'Rescan' }).click();
  await page.locator('.status').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.status').waitFor({ state: 'detached', timeout: 240000 });
  const after = await page.locator('.msg').first().innerText();
  console.log(`after rescan: ${after}`);
  if (!/^Found YR313/.test(after)) failures.push(`rescan: ${after}`);

  // Crop to the left half: drag the right edge of the selection to the middle.
  await page.getByRole('button', { name: 'Crop' }).click();
  const box = (await page.locator('.viewer-canvas').boundingBox())!;
  const imgRight = await page.evaluate(() => {
    const c = document.querySelector('.viewer-canvas') as HTMLCanvasElement;
    return c.clientWidth - 16; // photo is fitted with a 16 px pad; a landscape photo fills the width
  });
  const midY = box.y + box.height / 2;
  await page.mouse.move(box.x + imgRight, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + (16 + imgRight) / 2, midY, { steps: 8 });
  await page.mouse.up();
  await page.screenshot({ path: `${outDir}/8-crop-left.png` });
  const tc = Date.now();
  await page.getByRole('button', { name: 'Scan area' }).click();
  // The last query (YR313) stays active and is re-applied to the new results.
  await page.locator('.status').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('.status').waitFor({ state: 'detached', timeout: 240000 });
  const cropStatus = await page.locator('.msg').first().innerText();
  console.log(`cropped scan: ${((Date.now() - tc) / 1000).toFixed(1)} s — ${cropStatus}`);
  if (/Recognition failed|No marker codes/.test(cropStatus)) failures.push(`cropped scan status: ${cropStatus}`);
  await page.screenshot({ path: `${outDir}/9-cropped-result.png` });
  if (!/not found in the selected area/.test(await search('BG3', '10-cropped-bg3'))) failures.push('cropped search: absent code not reported for the selected area');

  if (offOrigin.length) failures.push(`off-origin requests: ${offOrigin.join(', ')}`);
} catch (e) {
  if ((e as Error).message !== 'TIMING_DONE') throw e;
} finally {
  await browser.close();
  stopServer();
}
if (failures.length) {
  console.error('FAIL\n' + failures.join('\n'));
  process.exit(1);
}
console.log('PASS');
process.exit(0);
