/**
 * Photograph the join flow by clicking through it the way a person would.
 *
 * Not a pass/fail harness — `net-race.mjs` is that. This one exists because the
 * lobby is the only screen in the game that sits over a LIT, MOVING scene, and
 * a scrim that looks right in a mockup is unreadable over a sunlit circuit with
 * white kerbs on it. The first draft of `lobby.css` passed every functional
 * check and was illegible on a phone; these shots are how that was found.
 *
 * Writes to `shots/lobby/` (gitignored), same as `controls-shots.mjs`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import { startVite, portOpen } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const OUT = join(root, 'shots/lobby');
mkdirSync(OUT, { recursive: true });
const VITE_PORT = 5181;
const RELAY_PORT = 8098;

const relay = spawn(process.execPath, ['server/relay.mjs'], {
  cwd: root, env: { ...process.env, PORT: String(RELAY_PORT) }, stdio: 'ignore',
});
for (let i = 0; i < 60 && !(await portOpen(RELAY_PORT)); i++) await new Promise(r => setTimeout(r, 100));

const server = await startVite(VITE_PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});

const url = `http://127.0.0.1:${VITE_PORT}/?quality=low&scaler=off&relay=http://127.0.0.1:${RELAY_PORT}`;

// --- 1. desktop host ---------------------------------------------------------
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });
await new Promise(r => setTimeout(r, 1200));

// Click the real button on the title screen.
const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.kr-btn')];
  const mp = btns.find((b) => b.textContent.trim() === 'Multiplayer');
  if (!mp) return false;
  mp.click();
  return true;
});
console.log('multiplayer button found & clicked:', clicked);
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: join(OUT, `lobby-1-choose.png`) });

// Type a name, start a room.
await page.evaluate(() => {
  const input = document.querySelector('.kr-lobby-choose .kr-lobby-input');
  input.value = 'Dad';
  [...document.querySelectorAll('.kr-lobby-choose .kr-btn')]
    .find((b) => b.textContent.trim() === 'Start a room').click();
});
await new Promise(r => setTimeout(r, 1600));
await page.screenshot({ path: join(OUT, `lobby-2-room-host.png`) });

const roomInfo = await page.evaluate(() => ({
  room: window.__net.room,
  phase: window.__net.phase,
  players: window.__net.players.length,
  qrModules: document.querySelectorAll('.kr-lobby-qr i').length,
  code: document.querySelector('.kr-lobby-code')?.textContent,
  url: document.querySelector('.kr-lobby-url')?.textContent,
  warn: document.querySelector('.kr-lobby-warn')?.textContent,
}));
console.log('host room:', JSON.stringify(roomInfo));

// --- 2. a phone joins --------------------------------------------------------
const phone = await browser.newPage();
await phone.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
phone.on('pageerror', (e) => console.error('phone error:', e.message));
await phone.goto(`${url}&room=${roomInfo.room}`, { waitUntil: 'domcontentloaded' });
await phone.waitForFunction('window.__gameReady === true', { timeout: 120000 });
await new Promise(r => setTimeout(r, 1000));
await phone.screenshot({ path: join(OUT, `lobby-3-phone-join.png`) });

const joinPane = await phone.evaluate(() => ({
  pane: document.querySelector('.kr-lobby-pane.on')?.className,
  code: document.querySelector('.kr-lobby-code-in')?.value,
}));
console.log('phone landed on:', JSON.stringify(joinPane));

// Tap Join.
await phone.evaluate(() => {
  const input = document.querySelector('.kr-lobby-choose .kr-lobby-input');
  if (input) input.value = 'Ida';
  [...document.querySelectorAll('.kr-lobby-join .kr-btn')]
    .find((b) => b.textContent.trim() === 'Join').click();
});
await new Promise(r => setTimeout(r, 1800));
await phone.screenshot({ path: join(OUT, `lobby-4-phone-room.png`) });
await page.screenshot({ path: join(OUT, `lobby-5-host-with-player.png`) });

console.log('host sees:', JSON.stringify(await page.evaluate(() => window.__net.players)));
console.log('phone seat:', await phone.evaluate(() => window.__net.mySeat));

await browser.close();
server.stop();
relay.kill('SIGKILL');
