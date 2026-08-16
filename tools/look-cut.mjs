/**
 * How many frames does look-behind take to actually be behind?
 *
 * The answer must be 1. Twice now this has been "fixed" by making the rig's
 * TARGET flip instantly while `constrainEye`'s MAX_EYE_SLIP and the per-frame
 * orientation slerp quietly walked the real camera round over ~0.8 s. Measure
 * the rendered camera, not the intent.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5191;
const server = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 620 });
await page.goto(`http://127.0.0.1:${PORT}/?quality=low&scaler=off`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

const before = await page.evaluate(async () => {
  const ctx = window.__ctx;
  ctx.race.autoDrive = true;
  ctx.race.start();
  const k = ctx.race.player;
  const step = () => new Promise((res) => requestAnimationFrame(res));
  for (let i = 0; i < 400; i++) await step();

  // Dot of (kart -> camera) with the kart's forward.
  //   -1 = the camera is BEHIND the kart, i.e. the normal chase view
  //   +1 = the camera is IN FRONT, i.e. swung round to look back at yourself
  // The first draft of this had the sign backwards and reported a pass on
  // frame 1 without the camera moving at all, because the resting state
  // already satisfied its "flipped" test. Check `before` is about -1.
  const side = () => {
    const dx = ctx.camera.position.x - k.position.x;
    const dz = ctx.camera.position.z - k.position.z;
    const len = Math.hypot(dx, dz) || 1;
    return (dx / len) * k.forward.x + (dz / len) * k.forward.z;
  };

  const before = +side().toFixed(3);
  window.__lookSample = { before, trace: [], framesToFlip: -1 };
  window.__lookWatch = async () => {
    const t = window.__lookSample;
    for (let i = 0; i < 40; i++) {
      await step();
      const s = side();
      t.trace.push(+s.toFixed(3));
      if (t.framesToFlip < 0 && s > 0.6) t.framesToFlip = i + 1;
    }
  };
  return before;
});

// Press the REAL key. Writing to `input.state` does not work: `Input.update`
// runs at the top of every frame and rebuilds the whole state object from the
// actual sources, so a poked flag is gone before the camera ever reads it —
// the first draft of this harness did exactly that and measured nothing
// happening, which was true and told us nothing about the fix.
const watching = page.evaluate(() => window.__lookWatch());
await page.keyboard.down('KeyQ');
await watching;
await page.keyboard.up('KeyQ');
const r = await page.evaluate(() => window.__lookSample);

console.log(JSON.stringify({ ...r, trace: r.trace.slice(0, 8) }, null, 2));
if (!(r.before < -0.6)) {
  console.log(`\nFAIL — instrument: resting camera should sit behind (about -1), measured ${r.before}.`);
} else if (r.framesToFlip === 1) {
  console.log('\nPASS — the view is behind you on the very next frame.');
} else {
  console.log(`\nFAIL — took ${r.framesToFlip} frames to swing round.`);
}
await browser.close();
server.stop();
