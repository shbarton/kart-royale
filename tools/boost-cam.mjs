/**
 * How far does the camera drop on a boost, on a phone versus a desktop?
 *
 * The complaint was that a boost puts the camera down behind the kart and
 * hides the road ahead. That is the rig's dolly-zoom doing its job, and the
 * fix scales it down on touch only — so the check is that the two now differ,
 * and that desktop is unchanged.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5189;
const server = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});

const out = {};
for (const mode of ['desktop', 'phone']) {
  const page = await browser.newPage();
  const phone = mode === 'phone';
  await page.setViewport(phone
    ? { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/?quality=low&scaler=off`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });
  if (phone) {
    await page.touchscreen.tap(422, 40);
    await page.waitForFunction('window.__ctx.input.touch === true', { timeout: 5000 });
  }

  out[mode] = await page.evaluate(async () => {
    const ctx = window.__ctx;
    ctx.race.autoDrive = true;
    ctx.race.start();
    const k = ctx.race.player;
    const settle = async (n) => { for (let i = 0; i < n; i++) await new Promise(r => requestAnimationFrame(r)); };

    // Get it rolling and steady, with no boost anywhere near.
    await settle(420);
    const rest = [];
    for (let i = 0; i < 60; i++) {
      await settle(1);
      if (k.boostTime <= 0) rest.push(ctx.camera.position.y - k.position.y);
    }

    // Now boost, repeatedly, and take the LOWEST the camera gets relative to
    // the kart — the moment the road disappears is the moment that matters.
    let lowest = Infinity;
    for (let n = 0; n < 3; n++) {
      k.applyBoost(1.6, 1.3);
      for (let i = 0; i < 70; i++) {
        await settle(1);
        lowest = Math.min(lowest, ctx.camera.position.y - k.position.y);
      }
    }
    const avg = rest.reduce((a, b) => a + b, 0) / Math.max(1, rest.length);
    return {
      touch: ctx.input.touch,
      restHeight: +avg.toFixed(3),
      lowestOnBoost: +lowest.toFixed(3),
      dropMetres: +(avg - lowest).toFixed(3),
    };
  });
  await page.close();
}

console.log(JSON.stringify(out, null, 2));
console.log(`\ncamera drop on boost — desktop ${out.desktop.dropMetres} m, phone ${out.phone.dropMetres} m`);
await browser.close();
server.stop();
