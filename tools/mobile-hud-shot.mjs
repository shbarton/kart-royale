/**
 * Photograph the in-race HUD on a phone, in a race with other humans in it.
 *
 * The player board only appears when the game has been told who the humans
 * are, so a single-player screenshot cannot show it — this stands up a real
 * two-machine race and shoots the client, which is the screen a child is
 * actually holding.
 *
 * Writes to `shots/hud/`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { startVite, portOpen } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const OUT = join(root, 'shots/hud');
mkdirSync(OUT, { recursive: true });
const VITE_PORT = 5187;
const RELAY_PORT = 8097;
const ROOM = 'SHOT';

const relay = spawn(process.execPath, ['server/relay.mjs'], {
  cwd: root, env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: 'ignore',
});
for (let i = 0; i < 60 && !(await portOpen(RELAY_PORT)); i++) await wait(100);

const server = await startVite(VITE_PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const url = `http://127.0.0.1:${VITE_PORT}/?quality=low&scaler=off&relay=http://127.0.0.1:${RELAY_PORT}`;

// The host is a laptop; only the client needs to be a phone.
const host = await open(browser, url, { width: 1280, height: 800 }, 'host');
const phone = await open(browser, url, { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, 'phone');

await host.evaluate((r) => window.__net.connect('host', r, 'Dad'), ROOM);
await phone.evaluate((r) => window.__net.connect('player', r, 'Ida'), ROOM);
await host.waitForFunction('window.__net.players.length >= 2', { timeout: 15000 });

await host.evaluate(() => window.__net.startRace(300));
await Promise.all([
  host.waitForFunction('window.__net.phase === "racing"', { timeout: 10000 }),
  phone.waitForFunction('window.__net.phase === "racing"', { timeout: 10000 }),
]);

// Past the lights and into a lap, with the throttle down so the HUD is live.
await host.evaluate(() => { window.__ctx.race.autoDrive = true; });
await phone.bringToFront();

// TOUCH THE SCREEN, with a real finger event.
//
// `isMobile: true` in the viewport is not enough and this harness reported a
// false pass because of it: the touch layer mounts LAZILY on the first genuine
// pointer (deliberately — it is how an iPad claiming to be a desktop still
// gets controls), so until something actually touches the glass `input.touch`
// is false, `html[data-touch]` is unset, and every touch-only rule under test
// here is inert. The first run photographed a desktop HUD and called it a
// phone. Tap the top rail, which is read-only, so this cannot also press a
// control.
await phone.touchscreen.tap(422, 40);
await phone.waitForFunction('window.__ctx.input.touch === true', { timeout: 5000 })
  .catch(() => console.error('[phone] touch controls never mounted — the shot below is NOT a phone HUD'));

// NO KEYBOARD ON THE PHONE. `Input.onFirstKey` unmounts the touch pad the
// moment a real key arrives — correctly, since a keypress means a keyboard —
// so driving this page with ArrowUp turned touch mode straight back off and
// the first two runs photographed a desktop HUD on a phone-sized viewport.
// Auto-accelerate is on by default on touch, so the kart drives itself.
await wait(11000);
await phone.screenshot({ path: join(OUT, 'hud-phone-race.png') });

const state = await phone.evaluate(() => ({
  boardOn: document.querySelector('.kr-board')?.classList.contains('on'),
  boardRows: [...document.querySelectorAll('.kr-board-row')].map((r) => r.textContent),
  posHidden: document.querySelector('.kr-pos')?.classList.contains('replaced'),
  speedoShown: getComputedStyle(document.querySelector('.kr-speed')).display !== 'none',
  lapScale: getComputedStyle(document.querySelector('.kr-lap')).transform,
  touch: window.__ctx.input.touch,
}));
console.log(JSON.stringify(state, null, 2));

await browser.close();
server.stop();
relay.kill('SIGKILL');

async function open(br, target, viewport, label) {
  const page = await br.newPage();
  await page.setViewport(viewport);
  page.on('pageerror', (e) => console.error(`[${label}] ${e.message}`));
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });
  return page;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
