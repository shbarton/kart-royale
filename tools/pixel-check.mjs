/**
 * How many pixels is the game ACTUALLY drawing, against what the panel can
 * show? Reports the drawing buffer on a desktop frame and on a landscape
 * phone, so a resolution regression is a number rather than a squint.
 */
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const PORT = 5193;
const server = await startVite(PORT);
const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
const out = {};
for (const [mode, vp, q] of [
  ['desktop 1080p', { width: 1920, height: 1080 }, 'high'],
  ['phone landscape (medium)', { width: 844, height: 295, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, 'medium'],
  ['phone landscape (low)', { width: 844, height: 295, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, 'low'],
]) {
  const page = await browser.newPage();
  await page.setViewport(vp);
  await page.goto(`http://127.0.0.1:${PORT}/?scaler=off&quality=${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });
  out[mode] = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const cssPx = innerWidth * innerHeight;
    const drawn = c.width * c.height;
    return {
      css: `${innerWidth}x${innerHeight}`,
      dpr: devicePixelRatio,
      buffer: `${c.width}x${c.height}`,
      drawnMpx: +(drawn / 1e6).toFixed(2),
      panelMpx: +(cssPx * devicePixelRatio * devicePixelRatio / 1e6).toFixed(2),
      percentOfPanel: Math.round(100 * drawn / (cssPx * devicePixelRatio * devicePixelRatio)),
      maxPixelRatio: +window.__ctx.settings.maxPixelRatio.toFixed(2),
    };
  });
  await page.close();
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.stop();
