/**
 * What moves when you drive through an item box?
 *
 * Reported from a phone as "it sort of shifts the web view, like, the
 * perspective". That description fits two completely different faults — the
 * BROWSER scrolling/zooming the page, or the GAME camera changing lens — and
 * they have nothing to do with each other, so this measures both across the
 * moment of a pickup and prints whichever one actually moved.
 *
 * Runs mobile-emulated and single-player: if it reproduces here it is not a
 * multiplayer bug, which is worth knowing before looking at any netcode.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5182;
const server = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
// A landscape phone, with touch — the HUD reflows on `html[data-touch]`, so a
// desktop viewport would be measuring a different screen to the one reported.
await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`http://127.0.0.1:${PORT}/?quality=low&scaler=off`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

const result = await page.evaluate(async () => {
  const ctx = window.__ctx;
  ctx.race.autoDrive = true;          // nobody is holding a phone in here
  ctx.race.start();

  const sample = () => ({
    t: +performance.now().toFixed(1),
    // --- the browser ---
    scrollY: window.scrollY,
    scrollX: window.scrollX,
    docTop: document.documentElement.scrollTop,
    bodyTop: document.body.scrollTop,
    vvTop: +(visualViewport?.offsetTop ?? -1).toFixed(2),
    vvLeft: +(visualViewport?.offsetLeft ?? -1).toFixed(2),
    vvScale: +(visualViewport?.scale ?? -1).toFixed(3),
    vvH: +(visualViewport?.height ?? -1).toFixed(1),
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
    // --- the game camera ---
    fov: +ctx.camera.fov.toFixed(3),
    fovPunch: +ctx.fovPunch.toFixed(3),
    aspect: +ctx.camera.aspect.toFixed(4),
    camY: +ctx.camera.position.y.toFixed(3),
    // --- why the camera might be moving, so the reading can be attributed ---
    // The first run of this probe caught fovPunch swinging 3.1 -> 7.8 across a
    // pickup and nearly blamed the pickup. The kart was being driven by the AI,
    // and the AI FIRES an item the moment it gets one — so what was measured
    // was a mushroom boost, which is supposed to punch the lens. Without these
    // three columns there is no way to tell the two apart.
    boost: +ctx.race.player.boostTime.toFixed(3),
    stun: +ctx.race.player.stunTime.toFixed(3),
    speed: +ctx.race.player.forwardSpeed.toFixed(2),
  });

  const log = [];
  const events = [];
  let pickupAt = -1;
  let fired = 0;
  const off = ctx.bus.on((e) => {
    if (!e.kart || !e.kart.isPlayer) return;
    // Everything the player's own kart raises, timestamped. If a boost or a
    // collision landed in the same window as the pickup, that is the
    // explanation and the pickup is innocent.
    if (['item-pickup', 'item-use', 'boost', 'hit', 'collide', 'land', 'hop'].includes(e.type)) {
      events.push({ t: +performance.now().toFixed(1), type: e.type, kind: e.kind, tier: e.tier });
    }
    if (e.type === 'item-pickup' && pickupAt < 0) { pickupAt = performance.now(); fired++; }
  });

  // ISOLATE THE PICKUP. Waiting for one to happen naturally is what produced
  // the first, wrong reading: a mini-turbo fired 83 ms later and the lens kick
  // it caused got attributed to the box. So instead we wait for a genuinely
  // calm stretch — no boost, no drift, no stun, steady speed — and then deal
  // the player an item by hand, with nothing else going on to blame.
  const k = ctx.race.player;
  const calm = () => k.boostTime <= 0 && k.driftTier === 0 && k.driftDir === 0
    && k.stunTime <= 0 && !k.airborne && k.forwardSpeed > 12;

  const deadline = performance.now() + 90000;
  let forced = false;
  let calmFor = 0;
  while (performance.now() < deadline) {
    await new Promise((r) => requestAnimationFrame(r));
    log.push(sample());
    if (log.length > 400) log.shift();

    if (!forced) {
      calmFor = calm() ? calmFor + 1 : 0;
      // ~half a second of nothing happening, then hand over an item.
      if (calmFor > 30) { ctx.items.pickup(k); forced = true; }
      continue;
    }
    if (pickupAt > 0 && performance.now() - pickupAt > 900) break;
  }
  off();

  if (pickupAt < 0) return { error: 'no pickup happened in 90s' };

  const window_ = log.filter((s) => s.t > pickupAt - 500 && s.t < pickupAt + 1200);
  const before = log.filter((s) => s.t <= pickupAt);
  const base = before[before.length - 1] ?? window_[0];

  // What actually changed, and by how much?
  const moved = {};
  for (const key of Object.keys(base)) {
    if (key === 't') continue;
    let lo = Infinity, hi = -Infinity;
    for (const s of window_) { if (s[key] < lo) lo = s[key]; if (s[key] > hi) hi = s[key]; }
    if (hi - lo > 1e-3) moved[key] = { base: base[key], min: +lo.toFixed(3), max: +hi.toFixed(3), swing: +(hi - lo).toFixed(3) };
  }
  return {
    pickups: fired,
    samples: window_.length,
    moved,
    // Relative to the pickup, so "+41ms: boost" reads at a glance.
    eventsAroundPickup: events
      .filter((e) => e.t > pickupAt - 500 && e.t < pickupAt + 1200)
      .map((e) => ({ ms: Math.round(e.t - pickupAt), type: e.type, kind: e.kind, tier: e.tier })),
  };
});

console.log(JSON.stringify(result, null, 2));
await browser.close();
server.stop();
