/**
 * How many metres of road can you actually see in front of you?
 *
 * The honest measure of "I can't see what's coming". Marches along the racing
 * line ahead of the kart, projects each point through the LIVE camera, and
 * reports the furthest one still inside the frame — at rest and mid-boost, on
 * a desktop frame and on a landscape phone.
 *
 * Vertical FOV is reported alongside, because on an ultra-wide aspect the
 * horizontal clamp in `fitFov` used to pin it and that is what this exists to
 * catch coming back.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5192;
const server = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});

const out = {};
for (const [mode, vp] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 844, height: 295, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
]) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  await page.goto(`http://127.0.0.1:${PORT}/?quality=low&scaler=off`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });
  if (mode === 'phone') {
    await page.touchscreen.tap(422, 30);
    await page.waitForFunction('window.__ctx.input.touch === true', { timeout: 5000 }).catch(() => {});
  }

  out[mode] = await page.evaluate(async () => {
    const ctx = window.__ctx;
    ctx.race.autoDrive = true;
    ctx.race.start();
    const k = ctx.race.player;
    const step = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 420; i++) await step();

    const V = k.position.constructor;
    const probe = () => {
      // March forward along the centreline and find the last point on screen.
      const L = ctx.track.length;
      let furthest = 0;
      for (let d = 5; d <= 500; d += 5) {
        const s = ctx.track.sampleByDistance((k.t * L + d) % L);
        const p = new V(s.pos.x, s.pos.y + 0.5, s.pos.z).project(ctx.camera);
        if (Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1) furthest = d;
      }
      return furthest;
    };

    const rest = [];
    for (let i = 0; i < 40; i++) { await step(); if (k.boostTime <= 0) rest.push(probe()); }
    const restFov = +ctx.camera.fov.toFixed(1);

    let boostMin = Infinity;
    let boostFov = 0;
    for (let n = 0; n < 3; n++) {
      k.applyBoost(1.6, 1.3);
      for (let i = 0; i < 60; i++) {
        await step();
        if (k.boostTime > 0) { boostMin = Math.min(boostMin, probe()); boostFov = Math.max(boostFov, ctx.camera.fov); }
      }
    }
    const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    return {
      touch: ctx.input.touch,
      aspect: +(ctx.width / ctx.height).toFixed(2),
      restFov, boostFov: +boostFov.toFixed(1),
      roadAheadRest: Math.round(avg(rest)),
      roadAheadBoostWorst: boostMin,
    };
  });
  await page.close();
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.stop();
