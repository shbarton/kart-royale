/**
 * ============================================================================
 *  Does typing your name take the steering wheel away?
 * ============================================================================
 *  It did. This is the regression guard for it.
 *
 *  The multiplayer lobby asks every player for a name. On a phone that raises
 *  the on-screen keyboard, and `Input.onFirstKey` treated the resulting
 *  keydowns as proof of a hardware keyboard — "a real keypress means a real
 *  keyboard, so the on-screen pad is clutter" — and unmounted the touch
 *  controls. Before the race had even started. No stick, no drift, no item
 *  button, and the HUD silently reverted to its desktop layout because
 *  `html[data-touch]` went with it. The player could not steer at all.
 *
 *  Two things are checked, because the same missing guard caused both:
 *
 *    1. TOUCH SURVIVES TYPING. The pad is still mounted afterwards.
 *    2. THE GAME DOES NOT READ THE TYPING. Letters the game binds (W/A/S/D,
 *       Space) must reach the text field and NOT the kart — and Space is in
 *       `SWALLOW`, which called preventDefault on it, so it was not even
 *       possible to put a space in your own name.
 *
 *  This walks the exact path a child takes: open the QR link, tap the screen,
 *  type a name. Nothing is simulated at the API level.
 * ============================================================================
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { startVite, portOpen } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const VITE_PORT = 5188;
const RELAY_PORT = 8096;
const NAME = 'Lia Rose';          // a space, and letters the game drives with

const relay = spawn(process.execPath, ['server/relay.mjs'], {
  cwd: root, env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: 'ignore',
});
for (let i = 0; i < 60 && !(await portOpen(RELAY_PORT)); i++) await wait(100);

const server = await startVite(VITE_PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const page = await browser.newPage();
await page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('page error:', e.message));

// The QR link — the way we tell people to join, and the path that broke.
await page.goto(
  `http://127.0.0.1:${VITE_PORT}/?quality=low&scaler=off&relay=http://127.0.0.1:${RELAY_PORT}&room=TEST`,
  { waitUntil: 'domcontentloaded' },
);
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });

const failures = [];

// A real finger, which is what puts the game in touch mode.
await page.touchscreen.tap(422, 300);
const mounted = await page
  .waitForFunction('window.__ctx.input.touch === true', { timeout: 5000 })
  .then(() => true).catch(() => false);
if (!mounted) failures.push('touch mode never engaged after a tap — the rest of this test is meaningless');

const before = await snapshot(page);

// Type the name, key by key, into the field the lobby put in front of them.
await page.focus('.kr-lobby-join .kr-lobby-input');
await page.keyboard.type(NAME, { delay: 25 });
await wait(250);

const after = await snapshot(page);

if (!after.touch) failures.push('typing a name turned touch mode OFF — the player has no steering');
if (!after.dataTouch) failures.push('typing a name cleared html[data-touch] — the HUD is in desktop layout on a phone');
if (!after.stickVisible) failures.push('the steering stick is gone after typing');
if (after.value !== NAME) {
  failures.push(`the name field holds "${after.value}", not "${NAME}" — the game swallowed a keystroke`);
}
// The kart must not have been driven by the letters in a name. Compared
// against the state BEFORE typing, not against zero: auto-accelerate is on by
// default on touch, so the resting throttle is already 1 and asserting `accel
// === 0` fails on a perfectly healthy build. The question is whether typing
// CHANGED anything, not what the controls happen to read.
if (Math.abs(after.accel - before.accel) > 0.01 || Math.abs(after.steer - before.steer) > 0.01) {
  failures.push(
    `typing moved the controls: steer ${before.steer} -> ${after.steer}, ` +
    `accel ${before.accel} -> ${after.accel}`,
  );
}

console.log(JSON.stringify({ before, after }, null, 2));

await browser.close();
server.stop();
relay.kill('SIGKILL');

if (failures.length) {
  console.error('\nFAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS — you can type your name and still steer.');

async function snapshot(p) {
  return p.evaluate(() => ({
    touch: window.__ctx.input.touch,
    dataTouch: document.documentElement.hasAttribute('data-touch'),
    stickVisible: !!document.querySelector('.tc-stick-zone'),
    clusterVisible: !!document.querySelector('.tc-cluster'),
    value: document.querySelector('.kr-lobby-join .kr-lobby-input')?.value ?? null,
    steer: +window.__ctx.input.state.steer.toFixed(3),
    accel: +window.__ctx.input.state.accel.toFixed(3),
  }));
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
