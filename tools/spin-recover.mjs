/**
 * After a spin-out, is the kart pointing down the track or back up it?
 *
 * Spins a kart repeatedly, at every stun length the game actually uses, and
 * measures the heading error against the track's own direction once the stun
 * clears. A kart left facing backwards on a live circuit has to three-point
 * turn out of it — and with auto-accelerate holding the throttle it simply
 * drives away the wrong way.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5194;
const server = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 620 });
await page.goto(`http://127.0.0.1:${PORT}/?quality=low&scaler=off`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

const r = await page.evaluate(async () => {
  const ctx = window.__ctx;
  ctx.race.autoDrive = true;
  ctx.race.start();
  const k = ctx.race.player;
  const step = () => new Promise((res) => requestAnimationFrame(res));
  for (let i = 0; i < 400; i++) await step();

  // Heading error in degrees against the track direction under the kart.
  const err = () => {
    const s = ctx.track.sample(k.t);
    const want = Math.atan2(s.tangent.x, s.tangent.z);
    const have = Math.atan2(k.forward.x, k.forward.z);
    let d = (want - have) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    else if (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d) * 180 / Math.PI;
  };

  const runs = [];
  // Every stun length the game actually deals.
  for (const secs of [0.65, 0.75, 0.9, 1.1]) {
    for (let n = 0; n < 4; n++) {
      // Let it drive normally between attempts so each spin starts from a
      // different place, speed and steering state.
      for (let i = 0; i < 90; i++) await step();
      k.invulnTime = 0;
      k.spinOut(secs);
      // Run past the end of the stun, then read the heading before the AI has
      // had time to steer it back itself.
      while (k.stunTime > 0) await step();
      runs.push({ secs, errDeg: +err().toFixed(1) });
    }
  }
  const errs = runs.map((x) => x.errDeg);
  return {
    runs,
    worstDeg: +Math.max(...errs).toFixed(1),
    medianDeg: +errs.slice().sort((a, b) => a - b)[errs.length >> 1].toFixed(1),
    facingBackwards: errs.filter((e) => e > 90).length,
    of: errs.length,
  };
});

console.log(JSON.stringify(r, null, 2));
await browser.close();
server.stop();
