#!/usr/bin/env node
/**
 * ============================================================================
 *  touch-feel.mjs — are the on-screen controls any GOOD?
 * ============================================================================
 *  `touch-test.mjs` answers "do they mount, and does a drag steer". That is a
 *  liveness check, and a control scheme can pass it while being unusable: a
 *  stick with three reachable values, a drift button that eats the steering
 *  thumb, a LOOK button smaller than a fingertip, and a frame of lag nobody can
 *  point at all pass "does a drag steer". This file asks the harder question.
 *
 *  A precondition and five measurements, each aimed at a specific way on-screen
 *  controls go wrong:
 *
 *   0b. LIVENESS    — does a touch at DRIFT's centre register AT ALL, in a real
 *                     race? Everything in §3 and §4 is a test of nothing if it
 *                     does not, and on the shipped build it does not. See the
 *                     comment at that check.
 *
 *   1. LATENCY      — dispatch a REAL pointer event through the CDP Input
 *                     domain and time it until the kart's own steering rack
 *                     moves. Reported in ms and in frames, against BOTH clocks
 *                     (see "two zeros" below).
 *   2. PRECISION    — sweep a thumb across the whole stick one pixel at a time
 *                     and histogram what comes out. A control stuck at the
 *                     rails is bimodal at the extremes; a good one is smooth.
 *   3. MULTI-TOUCH  — steer + drift + item as three live points, released out
 *                     of order, plus a stray fourth. This is THE classic
 *                     failure and it is tested explicitly.
 *   4. REACHABILITY — every control's size and position against the 44 px
 *                     touch-target floor, the safe-area insets of six real
 *                     devices, and a thumb arc measured in millimetres.
 *   5. GESTURE      — nothing here may trigger back-swipe, pull-to-refresh,
 *                     pinch/double-tap zoom, text selection or the long-press
 *                     callout.
 *
 *  ---------------------------------------------------------------------------
 *  WHY THE TRICKY PARTS ARE THE WAY THEY ARE
 *
 *  **The events in §1-§4 are real; the ones in §5 are not, and the difference
 *  is stated at the gate.** `element.dispatchEvent(new PointerEvent(...))`
 *  skips the browser's own hit-testing and dispatch, which is a large part of
 *  what the player is waiting for, and it also cannot be wrong about which
 *  element gets the event — so it would validate the pad's state machine while
 *  proving nothing about latency. Sections 1-4 therefore go through
 *  `Input.dispatchTouchEvent` only, and `assertTrusted` fails the run if what
 *  arrived was not a trusted `pointerType: 'touch'` event.
 *
 *  Section 5 cannot: **this browser cannot zoom at all.** A control experiment
 *  — two-finger spread and double tap driven through the CDP Input domain with
 *  `touch-action` forced back to `auto`, the viewport meta rewritten without
 *  `user-scalable=no`, and the page's own cancelling handlers swallowed —
 *  leaves `visualViewport.scale` at exactly 1. In a browser that will not zoom
 *  even when invited to, "it did not zoom" is not evidence about the page. So
 *  the zoom/callout/selection checks dispatch synthetic events and observe
 *  whether the page's handler CANCELS them: that is a handler-presence check,
 *  it is named as one, and it must not be read as behavioural proof.
 *
 *  **Two zeros, and the difference between them is most of the journey.** The
 *  capture listener's `performance.now()` is the earliest the page can observe
 *  an event — but the event was generated long before that. Measured here:
 *  node -> `e.timeStamp` is 0.8 ms (CDP transport is nothing), while
 *  `e.timeStamp` -> capture-listener entry is 50-80 ms of browser-to-renderer
 *  delivery. A single "input latency: 5.7 ms" headline computed from the
 *  handler zero is therefore the page-side leg ONLY, and understates what a
 *  thumb waits for by an order of magnitude. Both are reported, both are
 *  labelled, and only the page-side leg is gated — the delivery leg is real
 *  latency in kind but its MAGNITUDE under headless CDP injection cannot be
 *  attributed to the game, and this repo does not gate on numbers it cannot
 *  attribute.
 *
 *  **CDP's touchEnd is ambiguous about WHICH point it releases.** Puppeteer's
 *  own `TouchHandle.end()` passes the point being released; `touch-test.mjs`
 *  passes an empty list and releases everything. Those two conventions cannot
 *  both be "the listed points are the ones going up". Rather than guess — and
 *  a wrong guess here silently turns the multi-touch section into a test of
 *  nothing — the convention is PROBED at startup against two live points, and
 *  the harness aborts if neither reading is self-consistent. See `probeRelease`.
 *
 *  **Two in-page listeners, deliberately in different phases.** The CAPTURE
 *  listener records `performance.now()` before the game has seen the event —
 *  that is the earliest the page could possibly have observed it, and it is the
 *  zero of the latency measurement. The BUBBLE listener is registered after
 *  `TouchControls` mounted its own window listener, so by the time it runs the
 *  pad has already folded the event into `pad.state`; that is what makes a
 *  250-sample sweep cost 250 events instead of 250 round trips.
 *
 *  **The rAF probe re-registers itself at the END of its callback**, so within
 *  any frame it runs after `main.ts`'s `frame()` (which re-registers at the
 *  TOP of its own callback and therefore always queues first). The probe is
 *  reading the state the game has already computed for that frame, not racing
 *  it. An event that lands after `Input.update` in frame N is genuinely not
 *  visible until frame N+1, and it is counted that way — which is why the trial
 *  phase is randomised against vsync rather than fixed.
 *
 *  **Latency is measured with the race in RaceState.Racing.** `Kart.step` only
 *  runs the steering rack while racing, so a probe run in the menu can measure
 *  the input path and nothing else — it would report a beautiful number for
 *  half the journey. The player kart is driven by `input` only when
 *  `autoDrive` is false and it has not been dropped in, so both are checked per
 *  trial and contaminated trials are DROPPED rather than averaged in.
 *
 *  **Milliseconds from a software rasteriser are fiction** (see fps-bench's
 *  header, and CLAUDE.md). `--use-gl=angle` is passed and
 *  `--enable-unsafe-swiftshader` deliberately is not. If the game still ended
 *  up on a software device, the FRAME counts remain meaningful — they are
 *  counts, not durations — so those stay as gates and every millisecond figure
 *  is marked unattributable and dropped from the pass/fail decision. Pass
 *  `--require-gpu` to abort instead.
 *
 *  **Millimetres come from a tabulated ppi, never from anything measured at
 *  runtime.** Chrome cannot emulate `env(safe-area-inset-*)` and reports 0 for
 *  all four however the viewport is emulated, so the insets are tabulated too.
 *  That means a measured rect is the ZERO-INSET layout — the answer to "where
 *  would this sit if the browser reported no inset". A control inside a real
 *  device's inset band is therefore only a violation if the CSS does not carry
 *  an `env()` term for that side, and the env() term is read out of the CSSOM
 *  (which keeps the specified value) rather than from `getComputedStyle`
 *  (which has already resolved it to 0px and would report success always).
 *
 *  **The 44 px floor is scored on the HIT TARGET, not the drawn box, and the
 *  hit target is measured rather than assumed.** `TouchControls.measure()`
 *  gives every `.tc-btn` a circular hit radius of `width / 2 + 16`, so LOOK is
 *  drawn at 41 px and tappable across 73 — and an earlier revision of this file
 *  failed the build on three profiles for a control that is comfortably over
 *  the floor. The padding is not copied from `TouchControls.ts` either (a
 *  constant duplicated into a harness is a constant that will silently go
 *  stale): `probePadding` walks a real touch outward from each control's centre
 *  until it stops registering. The chips are probed too, because whether they
 *  carry the same padding is exactly what decides whether a 20 px PAUSE chip is
 *  a finding or a false alarm. It is a finding: they carry none.
 *
 *  ---------------------------------------------------------------------------
 *  WHAT HAS BEEN SHOWN ABOUT THIS INSTRUMENT, BY EXPERIMENT
 *
 *  Per CLAUDE.md — validate the instrument before trusting the reading. Each of
 *  these was run against a scratch build, not reasoned about:
 *
 *   - LATENCY IS REAL. `setTimeout(..., 100)` around the steer write in
 *     `TouchControls.onMove` moved the page-side median from 2.20 ms to
 *     118.60 ms and "frames to input.state" from 1 to 8. The extra ~16 ms over
 *     the injected 100 is the rAF quantisation the probe is built on, which is
 *     the right answer, not a bias.
 *   - THE EVENTS ARE THE BROWSER'S. Replacing `Input.dispatchTouchEvent` with
 *     an in-page `element.dispatchEvent` of the same PointerEvents made the
 *     provenance guard fire and the run abort ("isTrusted false"). The 44 ms
 *     browser-delivery leg §1 reports collapses to nothing under dispatchEvent,
 *     which is exactly the cost a JS dispatch skips.
 *   - PRECISION DISCRIMINATES. Snapping the steer curve to -1/0/+1 collapsed
 *     the histogram to 7 samples at zero and 117 at full lock: distinct usable
 *     levels 117 -> 0, mid-band 64.5% -> 0.0%, worst bin 8.9% -> 94.4%, largest
 *     1 px step 0.021 -> 1.000. Five precision gates fail; none of them is
 *     decoration.
 *   - THE MULTI-TOUCH STEAL TEST BITES. Deleting the `b.pointer >= 0` guard in
 *     `TouchControls.hitButton` flipped exactly one gate — "a second finger on
 *     a held DRIFT does not take it over" — and left the other ten in §3
 *     passing. The four points arrive as four distinct browser pointerIds, and
 *     that is gated rather than assumed.
 *   - NOISE FLOOR, over three unchanged runs on an M5: identical gate verdicts
 *     (3 of 43 failing), identical precision to four decimals (117 distinct
 *     usable levels, 0.0206 largest 1 px step, 64.5% mid-band), identical hit
 *     padding (+15.7 px), identical reachability counts, and 1.00 frames to
 *     `input.state` every time. The only figure that moves is the page-side
 *     latency median: 2.20 / 2.30 / 2.40 ms, i.e. +-0.1 ms — an eighth of a
 *     frame, and well inside the 1.5-frame budget its gate allows.
 *     Before the fixes below there was no noise floor to quote: two unchanged
 *     runs returned exit 1 with 7 failed gates and exit 2 with an instrument
 *     abort, because §3's fuzz could randomly hit the AUTO chip and revive the
 *     dead buttons before §4 measured them.
 *
 *  Usage:  node tools/touch-feel.mjs [--port 5440] [--trials 40] [--require-gpu]
 *  Exits 0 on pass, 1 on a measured failure, 2 on an instrument failure.
 *  An instrument failure still prints the gates that did run and still writes
 *  shots/touch/touch-feel.json, flagged `"complete": false`.
 * ============================================================================
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance as nodePerf } from 'node:perf_hooks';
import puppeteer from 'puppeteer';
import { startVite } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('--port', 5440));
const TRIALS = Number(argOf('--trials', 40));
const REQUIRE_GPU = argv.includes('--require-gpu');

/** The reference device for the latency / precision / multi-touch sections. */
const W = 844, H = 390; // iPhone 14, landscape

// ---------------------------------------------------------------------------
//  Device table
// ---------------------------------------------------------------------------
/**
 * `mmPerPx` is derived from the panel's advertised ppi and its device pixel
 * ratio — `25.4 / ppi * dpr` — and NEVER from anything the page reports, for
 * the same reason the insets are tabulated: an emulated viewport has no
 * physical size, and a number computed from one is a number about nothing.
 *
 * `inset` is the landscape `env(safe-area-inset-*)` a real Safari reports.
 * Both sides are given the notch inset rather than only the side the notch is
 * physically on: which side that is depends on which way the player rotated,
 * so the conservative reading is the only one that holds for both.
 */
const PROFILES = [
  { name: 'iPhone SE (2022)',  w: 667,  h: 375, ppi: 326, dpr: 2,     inset: { t: 0, r: 0,  b: 0,  l: 0  } },
  { name: 'iPhone 13 mini',    w: 812,  h: 375, ppi: 476, dpr: 3,     inset: { t: 0, r: 50, b: 21, l: 50 } },
  { name: 'iPhone 14 / 15',    w: 844,  h: 390, ppi: 460, dpr: 3,     inset: { t: 0, r: 47, b: 21, l: 47 } },
  { name: 'iPhone 15 Pro Max', w: 932,  h: 430, ppi: 460, dpr: 3,     inset: { t: 0, r: 59, b: 21, l: 59 } },
  { name: 'Pixel 7',           w: 915,  h: 412, ppi: 416, dpr: 2.625, inset: { t: 0, r: 0,  b: 0,  l: 0  } },
  // The mini 6 is 2266x1488 physical at @2x, i.e. 1133x744 CSS px in landscape.
  // 1024 is the OLD iPad's width and was simply wrong. It only moves the "edge
  // clear l" column: every cluster control is anchored to the RIGHT edge, so
  // the thumb-arc distances the gate actually reads are identical either way.
  { name: 'iPad mini 6',       w: 1133, h: 744, ppi: 326, dpr: 2,     inset: { t: 0, r: 0,  b: 20, l: 0  } },
].map((p) => ({ ...p, mmPerPx: 25.4 / p.ppi * p.dpr }));

/** Apple's floor, and the one every platform guideline has converged on. */
const TARGET_FLOOR_PX = 44;
/** A thumb rooted at the bottom corner comfortably sweeps about this far. */
const ARC_PHONE_MM = 45;
const ARC_TABLET_MM = 58;

// ---------------------------------------------------------------------------
//  Small helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => {
  if (!a.length) return NaN;
  const s = sorted(a); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a, p) => {
  if (!a.length) return NaN;
  const s = sorted(a);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))];
};
const f = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');

const fails = [];
const notes = [];
/** Every gate this run evaluated, so the report can show what was checked. */
const gates = [];
function gate(name, ok, detail, { advisory = false } = {}) {
  gates.push({ name, ok, detail, advisory });
  if (!ok && !advisory) fails.push(`${name} — ${detail}`);
  return ok;
}

function abort(msg, code = 2) {
  console.error(`\nABORT (instrument): ${msg}`);
  return code;
}

// ---------------------------------------------------------------------------
//  Boot
// ---------------------------------------------------------------------------
const srv = await startVite(PORT);

const browser = await puppeteer.launch({
  headless: 'shell',
  args: [
    '--no-sandbox',
    // Required. Without it headless Chrome silently takes the software path and
    // every millisecond below is fiction. `--enable-unsafe-swiftshader` is
    // deliberately absent so that fall-back is detectable rather than silent.
    '--use-gl=angle',
    '--enable-gpu',
    `--window-size=${W},${H}`,
  ],
  timeout: 120000,
  protocolTimeout: 240000,
});

/**
 * The report, filled in section by section rather than assembled at the end,
 * and declared out here so the abort handler can still emit it.
 *
 * It used to be built in one literal after §5, which meant an instrument abort
 * anywhere earlier threw away everything the run HAD measured — and printed no
 * gate table at all, so the reader saw "ABORT (instrument)" and nothing else.
 * That is not academic. A scratch build with 100 ms of latency deliberately
 * injected into the touch path was measured correctly by §1 (page side 2.2 ->
 * 118.6 ms, 1 -> 8 frames) and then exited 2 out of §4, discarding the whole
 * finding: the run reported an instrument failure instead of a control that
 * was seven frames late. A run that measured something must say what it
 * measured, finished or not.
 */
const report = {
  when: new Date().toISOString(),
  viewport: `${W}x${H}`,
  complete: false,
  renderer: null, msAttributable: null, staleHitboxes: null,
  latency: null, hitPadding: null, precision: null, reachability: null,
  gates: [], notes: [],
};
let reported = false;
function emitReport(cutShort) {
  if (reported) return;
  reported = true;
  report.complete = !cutShort;
  report.gates = gates.map((g) => ({ name: g.name, ok: g.ok, advisory: g.advisory, detail: g.detail }));
  report.notes = notes;
  mkdirSync(join(root, 'shots/touch'), { recursive: true });
  writeFileSync(join(root, 'shots/touch/touch-feel.json'), JSON.stringify(report, null, 2));
  if (gates.length) {
    console.log(`\n=== gates ${cutShort ? '(RUN CUT SHORT — only the gates that ran) ' : ''}===`);
    for (const g of gates) {
      console.log(`  ${g.ok ? 'PASS' : g.advisory ? 'ADVI' : 'FAIL'}  ${g.name}\n        ${g.detail}`);
    }
  }
  for (const nt of notes) console.log(`\nNOTE: ${nt}`);
  console.log(`\nwrote shots/touch/touch-feel.json${cutShort ? '  (partial)' : ''}`);
}

let exitCode = 0;
/**
 * Main-frame navigations after the initial `goto`. Declared out here because
 * the abort handler below is outside the try block and has to be able to name
 * the cause. See where it is wired up.
 */
let reloads = -1;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await page.createCDPSession();
  // Mouse-derived touch would give us a second, differently-timed source of the
  // same events; there is exactly one input path under test here.
  await cdp.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e)));
  /**
   * Vite's HMR client full-reloads the page when a module it cannot hot-swap
   * changes, and this harness takes ~95 s against a working tree that other
   * agents are editing. A reload mid-run destroys the execution context, all
   * the in-page instrumentation with it, and puppeteer reports it as
   * "Execution context was destroyed, most likely because of a navigation" —
   * which sends the reader looking for a navigation this file never performs.
   * Count them, and name the real cause at the abort.
   */
  page.on('framenavigated', (fr) => { if (fr === page.mainFrame()) reloads++; });

  const t0boot = Date.now();
  await page.goto(`http://127.0.0.1:${PORT}/?quality=medium`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__gameReady === true', { timeout: 180000 });
  console.log(`booted in ${((Date.now() - t0boot) / 1000).toFixed(1)}s on port ${PORT}  (${W}x${H})`);


  // -------------------------------------------------------------------------
  //  0. Instrument validation
  // -------------------------------------------------------------------------
  console.log('\n=== 0. instrument ===');

  const gpu = await page.evaluate(() => {
    const gl = window.__ctx?.renderer?.getContext?.() ?? null;
    if (!gl) return { ok: false, why: 'the game has no WebGL context' };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      ok: true,
      masked: !dbg,
      renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    };
  });
  const SOFTWARE = /swiftshader|llvmpipe|software|softwarerasterizer|basic render/i;
  const realGpu = gpu.ok && !gpu.masked && !SOFTWARE.test(gpu.renderer);
  report.renderer = gpu.ok ? gpu.renderer : null;
  report.msAttributable = realGpu;
  console.log(`renderer          : ${gpu.ok ? gpu.renderer : gpu.why}${gpu.masked ? '  (masked by policy)' : ''}`);
  if (!realGpu) {
    const why = !gpu.ok ? gpu.why
      : gpu.masked ? 'WEBGL_debug_renderer_info is unavailable, so the software check could not fire'
        : 'this is a software rasteriser';
    if (REQUIRE_GPU) { exitCode = abort(`${why}; --require-gpu was passed.`); throw new Error('gpu'); }
    notes.push(`millisecond figures are UNATTRIBUTABLE: ${why}. ` +
      'Frame counts are still gates; every ms gate below is advisory only.');
    console.log('millisecond gates : ADVISORY ONLY (see the note at the foot of this report)');
  } else {
    console.log('millisecond gates : live');
  }

  const padOk = await page.evaluate(() => {
    const i = window.__ctx?.input;
    return !!(i && i.touch && i.pad && i.pad.state && document.querySelector('.tc-root'));
  });
  if (!padOk) { exitCode = abort('the on-screen pad did not mount, or `input.pad.state` is not reachable.'); throw new Error('pad'); }
  console.log('pad               : mounted, state reachable');

  // --- in-page instrument ---------------------------------------------------
  await page.evaluate(() => {
    const w = window;
    const ctx = w.__ctx;
    const input = ctx.input;
    const pad = input.pad;          // `private` is a TypeScript fiction at runtime
    const race = ctx.race;

    const TF = {
      rec: false,
      events: [],   // capture-phase pointermove: the earliest observable receipt
      moves: [],    // bubble-phase, AFTER the pad handled it
      frames: [],   // one row per rAF, read after the game's own update
      downs: [], ups: [], cancels: [],
      prevented: [],
      timeOrigin: performance.timeOrigin,
    };
    w.__tf = TF;

    /**
     * `stamp` is `e.timeStamp` — when the event was GENERATED, in the same time
     * base as `performance.now()`. `t` is when this listener ran, which is the
     * earliest the page could act on it. The gap between them is the browser's
     * delivery of the event to the renderer and it is 50-80 ms here; a latency
     * figure that starts at `t` has already skipped it. Both are kept.
     *
     * `trusted`/`ptype` are recorded so `assertTrusted` can prove these came
     * from the browser's own input pipeline rather than from a `dispatchEvent`
     * that would skip hit-testing, coalescing and delivery — i.e. most of what
     * is being measured.
     */
    addEventListener('pointermove', (e) => {
      if (TF.rec) {
        TF.events.push({
          t: performance.now(), stamp: e.timeStamp, x: e.clientX, y: e.clientY,
          id: e.pointerId, trusted: e.isTrusted, ptype: e.pointerType,
        });
      }
    }, { capture: true });
    addEventListener('pointerdown', (e) => {
      TF.downs.push({
        t: performance.now(), stamp: e.timeStamp, x: e.clientX, y: e.clientY,
        id: e.pointerId, trusted: e.isTrusted, ptype: e.pointerType,
      });
    }, { capture: true });
    addEventListener('pointerup', (e) => {
      TF.ups.push({ t: performance.now(), x: e.clientX, y: e.clientY, id: e.pointerId });
    }, { capture: true });
    addEventListener('pointercancel', (e) => {
      TF.cancels.push({ t: performance.now(), x: e.clientX, y: e.clientY, id: e.pointerId });
    }, { capture: true });

    // Bubble phase on window, registered after TouchControls' own listener, so
    // `pad.state` here is already the post-event value.
    addEventListener('pointermove', (e) => {
      if (TF.rec) TF.moves.push({ x: e.clientX, y: e.clientY, steer: pad.state.steer });
    });
    addEventListener('pointerdown', (e) => {
      TF.prevented.push({ x: e.clientX, y: e.clientY, prevented: e.defaultPrevented });
    });

    const playerIdx = race.karts.indexOf(race.player);

    // Re-registers at the END, so it always runs after main.ts's frame().
    const tick = () => {
      if (TF.rec) {
        const p = race.player;
        const prog = race.prog ? race.prog[playerIdx] : null;
        TF.frames.push({
          now: performance.now(),
          steer: input.state.steer,
          kart: p ? p.steerInput : null,
          drift: input.state.drift,
          /**
           * Was the kart taking its steering from `input` on THIS frame?
           *
           * Four ways it is not, and every one of them would otherwise be
           * charged to the touch layer as latency it did not cause:
           *   - not Racing, or handed to the AI, or already finished;
           *   - `respawnT > 0`: Race holds the controls after a drop-in;
           *   - `stunTime > 0`: **Kart.step sets `steer = 0` outright while
           *     stunned**. A kart driving itself at full throttle for a 40-trial
           *     run WILL find a wall, and a stunned trial reads as a flawless
           *     input path followed by a 150 ms hole. That is a game rule, not a
           *     control-latency finding, and it is dropped rather than averaged.
           */
          drivable: race.state === 2 && !race.autoDrive && !!p && !p.finished &&
            !(p.stunTime > 0) && !(prog && prog.respawnT > 0),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    w.__tfArm = () => { TF.events.length = 0; TF.moves.length = 0; TF.frames.length = 0; TF.rec = true; };
    w.__tfRead = () => { TF.rec = false; return { events: TF.events, moves: TF.moves, frames: TF.frames }; };
  });

  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({
      x: Math.round(p.x), y: Math.round(p.y), id: p.id ?? i,
      radiusX: p.radiusX ?? 12, radiusY: p.radiusY ?? 12, force: 1,
    })),
  });
  /**
   * Chrome refuses a touchEnd/touchMove/touchCancel when it is not tracking any
   * active point ("Must send a TouchStart first to start a new touch"). That is
   * not a failure when the call is a belt-and-braces "make sure nothing is
   * down" — it is the confirmation that nothing is. Every other protocol error
   * is re-thrown, so a genuine mistake still surfaces.
   */
  const touchSafe = async (type, points) => {
    try { await touch(type, points); return true; } catch (e) {
      if (/Must send a TouchStart/i.test(String(e.message))) return false;
      throw e;
    }
  };
  /**
   * Wait n frames — and, because every section funnels through here, the one
   * place that notices the page has been reloaded out from under the run. A
   * reload wipes `window.__tf`, and without this check the next section fails
   * with "window.__tfRead is not a function", which reads as a harness bug
   * rather than as the concurrent edit it actually is.
   */
  const frames = (n = 4) => {
    if (reloads > 0) throw new Error('TF_RELOADED');
    return page.evaluate((k) => new Promise((res) => {
      let i = 0; const t = () => (++i < k ? requestAnimationFrame(t) : res());
      requestAnimationFrame(t);
    }), n);
  };
  const readState = () => page.evaluate(() => {
    const i = window.__ctx.input;
    const p = i.pad.state;
    return {
      in: {
        steer: +i.state.steer.toFixed(4), accel: i.state.accel, brake: i.state.brake,
        drift: i.state.drift, itemPressed: i.state.itemPressed, look: i.state.lookBack,
      },
      pad: {
        steer: +p.steer.toFixed(4), steering: p.steering, active: p.active,
        drift: p.drift, item: p.item, brake: p.brake, look: p.look,
      },
      down: [...document.querySelectorAll('.tc-btn')].filter((e) => e.classList.contains('down'))
        .map((e) => e.getAttribute('data-btn')),
    };
  });

  // --- probe the CDP release convention ------------------------------------
  /**
   * Two points go down at known, far-apart x. One `touchEnd` is then dispatched
   * naming only the FIRST. Whichever x comes back on the pointerup tells us
   * whether the list means "these are going up" or "these are what is left".
   *
   * Points are placed high in the left half, clear of every button, so this
   * probe cannot be confused by the pad claiming something.
   */
  async function probeRelease() {
    const A = { x: 90, y: 46, id: 91 };
    const B = { x: 240, y: 46, id: 92 };
    await touchSafe('touchCancel', []);
    await page.evaluate(() => { window.__tf.ups.length = 0; window.__tf.downs.length = 0; });
    await touch('touchStart', [A]);
    await touch('touchStart', [A, B]);
    await frames(2);
    const downs = await page.evaluate(() => window.__tf.downs.map((d) => Math.round(d.x)));
    await touch('touchEnd', [A]);
    await frames(3);
    const ups = await page.evaluate(() => window.__tf.ups.map((u) => Math.round(u.x)));
    // Is the sequence still alive, and if so which point is still in it? A
    // touchMove naming only the survivor is accepted iff one is still tracked.
    const survivorA = await touchSafe('touchMove', [{ ...A, y: A.y + 3 }]);
    const survivorB = survivorA ? true : await touchSafe('touchMove', [{ ...B, y: B.y + 3 }]);
    await touchSafe('touchCancel', []);
    await touchSafe('touchEnd', []);
    await frames(3);

    const diag = `downs@x=[${downs}] ups@x=[${ups}] moveA=${survivorA} moveB=${survivorB}`;
    if (downs.length !== 2) return { conv: null, diag: `only ${downs.length} pointerdowns arrived — ${diag}` };
    if (ups.length === 1 && Math.abs(ups[0] - A.x) < 6) return { conv: 'listed-are-released', diag };
    if (ups.length === 1 && Math.abs(ups[0] - B.x) < 6) return { conv: 'listed-are-remaining', diag };
    if (ups.length === 2) return { conv: 'releases-everything', diag };
    return { conv: null, diag };
  }
  const probe = await probeRelease();
  console.log(`touchEnd probe    : ${probe.diag}`);
  if (!probe.conv || probe.conv === 'releases-everything') {
    exitCode = abort(
      `CDP touchEnd ${probe.conv === 'releases-everything'
        ? 'releases every active point, so a single point cannot be lifted out of order'
        : 'could not be characterised'}.\n` +
      `  ${probe.diag}\n` +
      'Every multi-touch result below would be a test of the harness, not of the game.');
    throw new Error('release-convention');
  }
  const RELEASE = probe.conv;
  console.log(`touchEnd semantics: ${RELEASE}  (probed, not assumed)`);

  // --- are these the browser's own events, or somebody's dispatchEvent? -----
  /**
   * The whole of §1-§4 rests on the events being REAL. A synthetic
   * `dispatchEvent` would land in the same listeners, drive the same state
   * machine and produce the same tidy numbers while skipping hit-testing,
   * coalescing and delivery — which is most of what §1 claims to measure. The
   * two pointerdowns `probeRelease` just produced are checked rather than
   * assumed: trusted, and `pointerType: 'touch'` rather than a mouse the
   * emulation layer turned into a touch.
   */
  const trust = await page.evaluate(() => {
    const d = window.__tf.downs;
    return {
      n: d.length,
      trusted: d.every((x) => x.trusted === true),
      types: [...new Set(d.map((x) => x.ptype))],
      ids: [...new Set(d.map((x) => x.id))].length,
    };
  });
  console.log(`event provenance  : ${trust.n} pointerdowns, isTrusted ${trust.trusted}, ` +
    `pointerType [${trust.types}], ${trust.ids} distinct pointerIds`);
  if (!trust.trusted || trust.types.join() !== 'touch') {
    exitCode = abort(
      `the events reaching the page are not trusted touch events ` +
      `(isTrusted ${trust.trusted}, pointerType [${trust.types}]).\n` +
      'Every latency and multi-touch figure below would be measuring a JS dispatch, not the browser.');
    throw new Error('provenance');
  }

  /** Release exactly `going` (array of points) while `staying` remain down. */
  const release = (going, staying) =>
    touch('touchEnd', RELEASE === 'listed-are-released' ? going : staying);
  const releaseAll = () => touchSafe('touchEnd', []);

  // --- clock alignment ------------------------------------------------------
  /**
   * Node and the renderer both hang `performance.now()` off the same wall
   * clock, so `timeOrigin + now()` is an epoch millisecond in either process
   * and the two are directly comparable. This is only used to report the CDP
   * transport cost; every gate below is computed from page-side timestamps
   * alone, so a skewed clock cannot manufacture a pass.
   */
  const pageOrigin = await page.evaluate(() => performance.timeOrigin);
  const nodeEpoch = () => nodePerf.timeOrigin + nodePerf.now();
  /**
   * ...and it is checked rather than assumed. A skewed clock would show up as a
   * plausible-looking transport figure that is pure offset, which is precisely
   * the kind of confident fiction this repo has been burned by. The tightest
   * round-trip of several bounds the skew: the page's timestamp must lie inside
   * the window the round-trip brackets.
   */
  let skew = { best: Infinity, offset: 0 };
  for (let i = 0; i < 9; i++) {
    const a = nodeEpoch();
    const p = await page.evaluate(() => performance.timeOrigin + performance.now());
    const b = nodeEpoch();
    if (b - a < skew.best) skew = { best: b - a, offset: p - (a + b) / 2 };
  }
  /**
   * ...with a granularity floor, because without one this check fires on a
   * healthy clock. The round-trip here is 0.13-0.16 ms and both ends quantise
   * `performance.now()` (and `timeOrigin`) to ~0.1 ms, so the offset estimate
   * has roughly a tenth of a millisecond of irreducible noise and lands
   * outside a 0.13 ms bound about half the time. Two consecutive unchanged runs
   * of this harness reported "offset -0.16 ms, bounded by 0.13 ms -> SKEWED"
   * and "offset 0.03 ms, bounded by 0.16 ms -> agree" — same machine, same
   * build, opposite verdicts, and the first printed an alarming NOTE about a
   * clock that was fine. A real skew is milliseconds at least; 0.5 ms of slack
   * cannot hide one and stops the check crying wolf on every other run.
   */
  const CLOCK_GRAIN_MS = 0.5;
  const clockOk = Math.abs(skew.offset) <= skew.best + CLOCK_GRAIN_MS;
  console.log(`clock alignment   : offset ${f(skew.offset)} ms, bounded by a ${f(skew.best)} ms round-trip ` +
    `+ ${f(CLOCK_GRAIN_MS, 1)} ms of clock granularity -> ${clockOk ? 'node and page agree' : 'SKEWED'}`);
  if (!clockOk) {
    notes.push(`node/page clock skew is ${f(skew.offset)} ms against a ${f(skew.best)} ms round-trip; ` +
      'the "CDP dispatch -> applied" column is reported but must not be believed. Every gate is ' +
      'computed from page-side timestamps only, so no gate is affected.');
  }

  // -------------------------------------------------------------------------
  //  Get into a real race
  // -------------------------------------------------------------------------
  /** Racing, player under player control, not stunned, not mid-respawn, not finished. */
  const raceOk = () => page.evaluate(() => {
    const r = window.__ctx.race;
    const i = r.karts.indexOf(r.player);
    const prog = r.prog?.[i];
    return r.state === 2 && !r.autoDrive && !r.player.finished &&
      !(r.player.stunTime > 0) && !(prog && prog.respawnT > 0);
  });
  /** Wait out a stun or a drop-in rather than burning a trial on it. */
  async function settle(maxMs = 3000) {
    const t = Date.now();
    while (Date.now() - t < maxMs) {
      if (await raceOk()) return true;
      await sleep(120);
    }
    return false;
  }
  async function toRacing() {
    await page.evaluate(() => { const r = window.__ctx.race; r.autoDrive = false; r.reset(); });
    const t = Date.now();
    while (Date.now() - t < 30000) {
      await sleep(150);
      if (await page.evaluate(() => window.__ctx.race.state === 2)) return true;
    }
    return false;
  }
  if (!await toRacing()) { exitCode = abort('the race never reached RaceState.Racing.'); throw new Error('race'); }
  console.log('race              : Racing, player under player control');

  // -------------------------------------------------------------------------
  //  0b. Do the action buttons respond to a touch AT ALL?
  // -------------------------------------------------------------------------
  /**
   * The precondition §3 and §4 both rest on, and it is not free.
   *
   * `TouchControls` caches a circular hit test per button and recomputes it
   * only when `dirty` is set — on mount, on resize, and on an AUTO toggle. The
   * FIRST `pointerdown` after mount is what triggers the first `measure()`,
   * and at boot that touch lands while `html[data-menu]` has `.tc-cluster` at
   * `display: none`. Every rect is then 0x0, `measure()` stores `r2 = 0` for
   * all five buttons, `dirty` goes false, and nothing sets it again when the
   * menu closes — so DRIFT, ITEM, BRAKE, LOOK and GAS are dead for the rest of
   * the session. A player taps through the title screen, so a player hits this.
   *
   * Without this check the symptom arrives as five unrelated-looking §3
   * failures ("DRIFT registers without disturbing the steering thumb — drift
   * false", and so on) and then a §4 instrument abort, with nothing naming the
   * cause. Worse, it is not even deterministic: §3's 200-event fuzz sprays the
   * whole viewport, and if one of those points happens to land on the AUTO chip
   * it calls `setAuto` -> `dirty = true` -> the buttons come back to life
   * before §4 measures. Two unchanged runs of this file disagreed exactly that
   * way: one reported the hit padding as +14.6 px and the next aborted with
   * "the padded hit circle is not a constant: drift +-43.9, item +-32.2".
   *
   * So: press DRIFT once, for real, in a real race. Report a live gate either
   * way. If it is dead, prove WHY by reading the cached radii back, then force
   * the re-measure the game does not do, so that §3 and §4 still measure the
   * thing they claim to measure instead of re-reporting this one bug five more
   * times. Everything after the force is labelled.
   */
  const pressDrift = async (id) => {
    const c = await page.evaluate(() => {
      const r = document.querySelector('.tc-drift')?.getBoundingClientRect();
      return r && r.width > 0
        ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    });
    if (!c) return { c: null, down: null };
    await touch('touchStart', [{ ...c, id }]);
    await frames(3);
    const down = await page.evaluate(() =>
      document.querySelector('.tc-btn.down')?.getAttribute('data-btn') ?? null);
    await releaseAll();
    await frames(3);
    return { c, down };
  };
  const hitboxState = () => page.evaluate(() => {
    const p = window.__ctx.input.pad;
    return {
      dirty: p.dirty,
      cached: p.buttons.map((b) => `${b.id} r=${b.r2 > 0 ? Math.sqrt(b.r2).toFixed(1) : '0'}`).join(' '),
      live: [...document.querySelectorAll('.tc-btn')]
        .map((e) => `${e.getAttribute('data-btn')} w=${e.getBoundingClientRect().width.toFixed(0)}`).join(' '),
      menu: document.documentElement.getAttribute('data-menu'),
    };
  });

  const live0 = await pressDrift(61);
  let STALE_HITBOX = false;
  if (live0.c && live0.down === 'drift') {
    console.log(`buttons           : DRIFT registers at (${live0.c.x},${live0.c.y})`);
  } else {
    const before = await hitboxState();
    // Force the re-measure the game never does, and see whether that alone
    // brings them back. If it does, the cache is the cause and nothing else is.
    await page.evaluate(() => { window.__ctx.input.pad.dirty = true; });
    const live1 = await pressDrift(62);
    const after = await hitboxState();
    STALE_HITBOX = live1.down === 'drift';
    console.log(`buttons           : DEAD — a touch at DRIFT's centre registers ${live0.down}`);
    console.log(`  cached hit radii: ${before.cached}   (dirty ${before.dirty})`);
    console.log(`  live drawn boxes: ${before.live}`);
    console.log(`  after forcing measure(): ${after.cached} -> DRIFT registers ${live1.down}`);
    if (!STALE_HITBOX) {
      exitCode = abort(
        'the on-screen action buttons do not respond to a touch at their own centre, and forcing\n' +
        `  TouchControls.measure() did not fix it (${live1.down}). The cause is something this\n` +
        '  harness has not characterised; §3 and §4 below would both be tests of nothing.');
      throw new Error('buttons-dead');
    }
  }
  gate('controls: the action buttons respond to a touch in a real race',
    !STALE_HITBOX,
    STALE_HITBOX
      ? 'DEAD until something dirties the cache. TouchControls.measure() runs on the FIRST pointerdown ' +
        'after mount, which at boot lands while html[data-menu] hides .tc-cluster, so every button gets ' +
        'r2 = 0 and nothing sets `dirty` again when the menu closes. Fix in TouchControls.ts (dirty the ' +
        'cache when the cluster becomes visible), not here.'
      : 'a touch at DRIFT\'s centre registers DRIFT');
  report.staleHitboxes = STALE_HITBOX;
  if (STALE_HITBOX) {
    notes.push('§3 and §4 below were measured AFTER this harness forced TouchControls to re-measure its ' +
      'hit circles. The shipped build does not do that, so on the shipped build every button gate below ' +
      'is unreachable — the buttons are dead. Read them as "what the pad does once its cache is right".');
  }

  // =========================================================================
  //  1. LATENCY
  // =========================================================================
  console.log('\n=== 1. input latency ===');
  console.log(`dispatching ${TRIALS} real CDP pointer events at randomised vsync phase`);

  /**
   * `handlerTo*` start at the capture listener (the page-side leg — everything
   * the touch layer, `Input` and `Kart` are responsible for). `stampTo*` start
   * at `e.timeStamp`, i.e. when the event was generated, and are therefore the
   * whole page-observable wait. `deliver` is the difference: the browser
   * getting the event to the renderer. `transport` is node -> `e.timeStamp`,
   * the harness's own overhead, which is the only leg that is definitely not
   * the player's problem.
   */
  const lat = {
    handlerToState: [], handlerToKart: [], stampToState: [],
    deliver: [], transport: [], framesState: [], framesKart: [], frameTimes: [],
  };
  const dropReason = Object.create(null);
  const drop = (why) => { dropReason[why] = (dropReason[why] | 0) + 1; };
  let dropped = 0, resets = 0;

  const ORIGIN = { x: 150, y: 250 };
  const THROW = 46;                    // px of travel: well past the dead zone, well short of lock
  /**
   * How many frames to keep watching after the move.
   *
   * This is the ceiling on any latency this section can report, and it was 10
   * — but the browser spends ~45 ms (~2.7 frames) delivering the event before
   * the page can see it, so the observable window was only ~7 frames, ~120 ms.
   * A build slower than that does not read as "slow"; every trial drops and the
   * section reports "0 usable trials", which reads as a broken harness. 16
   * frames leaves ~13 usable, ~220 ms, comfortably past anything a human would
   * still call a control.
   */
  const LAT_WINDOW = 16;

  for (let i = 0; i < TRIALS; i++) {
    if (!await raceOk() && !await settle()) {
      resets++;
      if (!await toRacing()) break;
    }
    // Randomised phase against vsync, so the measurement is a distribution over
    // where in the frame the event lands rather than one lucky alignment.
    await sleep(Math.random() * 17);

    const dir = i % 2 ? -1 : 1;
    const start = { ...ORIGIN, id: 1 };
    await touch('touchStart', [start]);
    await frames(3);

    const before = await page.evaluate(() => {
      const i2 = window.__ctx.input;
      return { steer: i2.state.steer, kart: window.__ctx.race.player.steerInput };
    });
    await page.evaluate(() => window.__tfArm());
    await sleep(Math.random() * 17);

    const tSend = nodeEpoch();
    await touch('touchMove', [{ ...start, x: start.x + dir * THROW }]);
    await frames(LAT_WINDOW);
    const rec = await page.evaluate(() => window.__tfRead());
    // The race has to have stayed drivable for the WHOLE trial. A kart that was
    // dropped back in, finished, or left Racing mid-trial has `Kart.step` taking
    // its command from somewhere other than `input`, and averaging that in would
    // charge the touch layer for latency it did not cause. Contaminated trials
    // are dropped, and the count is reported rather than buried.
    const stillOk = await raceOk();
    await releaseAll();
    await frames(3);

    if (!stillOk) { dropped++; drop('race left player control by the end of the trial'); continue; }
    if (!rec.events.length || !rec.frames.length) { dropped++; drop('no event or no frames recorded'); continue; }
    const ev = rec.events[rec.events.length - 1];
    const tEvent = ev.t;                          // page perf.now at capture-phase receipt

    // The value we are waiting for. Anything that has moved decisively off the
    // pre-event value counts — the exact figure is the curve's business.
    const seen = rec.frames.filter((fr) => fr.now > tEvent);
    if (seen.some((fr) => !fr.drivable)) {
      dropped++; drop('kart stunned / respawning / off player control inside the window'); continue;
    }
    const iState = seen.findIndex((fr) => Math.abs(fr.steer - before.steer) > 0.05);
    const iKart = seen.findIndex((fr) => fr.kart !== null && Math.abs(fr.kart - before.kart) > 0.002);
    /**
     * Split, because the two mean completely different things. "input.state
     * never moved" is the touch layer failing to deliver — or an input path
     * slower than `LAT_WINDOW`, which is a finding and not a drop, so say so.
     * "input moved but the kart did not" is a Race/Kart problem and points
     * somewhere else entirely.
     */
    if (iState < 0) {
      dropped++;
      drop(`input.state.steer never moved within ${LAT_WINDOW} frames ` +
        `(~${(LAT_WINDOW * 16.7).toFixed(0)} ms) — the pad did not see the event, ` +
        'or the input path is slower than the window');
      continue;
    }
    if (iKart < 0) {
      dropped++;
      drop(`input.state.steer moved but kart.steerInput did not within ${LAT_WINDOW} frames`);
      continue;
    }

    lat.framesState.push(iState + 1);
    lat.framesKart.push(iKart + 1);
    lat.handlerToState.push(seen[iState].now - tEvent);
    lat.handlerToKart.push(seen[iKart].now - tEvent);
    lat.stampToState.push(seen[iState].now - ev.stamp);
    lat.deliver.push(tEvent - ev.stamp);
    lat.transport.push((pageOrigin + ev.stamp) - tSend);
    for (let k = 1; k < rec.frames.length; k++) lat.frameTimes.push(rec.frames[k].now - rec.frames[k - 1].now);
  }

  const frameMs = median(lat.frameTimes);
  const n = lat.framesState.length;
  console.log(`trials usable     : ${n}/${TRIALS}   (dropped ${dropped}, race resets ${resets})`);
  for (const [why, count] of Object.entries(dropReason)) console.log(`  dropped x${count}   : ${why}`);
  console.log(`median frame time : ${f(frameMs)} ms`);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  if (n) {
    console.log('');
    console.log('                                    median      p95       max');
    const row = (label, a, unit) =>
      console.log(`  ${label.padEnd(32)}${f(median(a)).padStart(6)}${f(pct(a, 95)).padStart(10)}` +
        `${f(Math.max(...a)).padStart(10)}  ${unit}`);
    console.log('  -- what a thumb waits for -----');
    row('generated -> input.state.steer', lat.stampToState, 'ms  [gate: none, see NOTE]');
    row('  of which: browser delivery', lat.deliver, 'ms  browser -> renderer');
    row('  of which: page side', lat.handlerToState, 'ms  [gated]');
    console.log('  -- harness overhead, excluded --');
    row('node send -> e.timeStamp', lat.transport, 'ms  CDP transport');
    console.log('  -- frames ---------------------');
    row('frames to input.state', lat.framesState, 'frames');
    row('frames to kart.steerInput', lat.framesKart, 'frames');
    /**
     * `kart.steerInput` cannot resolve on a LATER frame than `input.state`:
     * `Input` is the 2nd system in main.ts's update list and `Race` the 7th, so
     * both move inside one frame, and the rAF probe samples them from the same
     * row. Equality is arithmetic, not corroboration — it is reported as a
     * check that the command reached the kart at all, and nothing more.
     */
    if (lat.framesKart.every((v, i2) => v === lat.framesState[i2])) {
      console.log('  (kart == input on every trial, as it must: both resolve inside one frame)');
    }
  }

  if (n) {
    report.latency = {
      trials: n, droppedTrials: dropped, dropReasons: { ...dropReason },
      windowFrames: LAT_WINDOW, medianFrameMs: +f(frameMs, 3),
      // The full page-observable wait, and its two legs. Never quote
      // pageSideMs on its own as "input latency" — see the NOTE in the report.
      generatedToStateMs: { median: +f(median(lat.stampToState), 3), p95: +f(pct(lat.stampToState, 95), 3) },
      browserDeliveryMs: { median: +f(median(lat.deliver), 3), p95: +f(pct(lat.deliver, 95), 3) },
      pageSideMs: { median: +f(median(lat.handlerToState), 3), p95: +f(pct(lat.handlerToState, 95), 3) },
      cdpTransportMs: { median: +f(median(lat.transport), 3), p95: +f(pct(lat.transport, 95), 3) },
      framesToState: { median: median(lat.framesState), p95: pct(lat.framesState, 95), max: Math.max(...lat.framesState) },
      framesToKart: { median: median(lat.framesKart), p95: pct(lat.framesKart, 95), max: Math.max(...lat.framesKart) },
    };
  }
  gate('latency: usable trials', n >= Math.max(8, TRIALS * 0.6),
    `${n}/${TRIALS} trials produced a reading`);
  if (n) {
    gate('latency: median frames to input.state.steer <= 1',
      median(lat.framesState) <= 1.0,
      `median ${f(median(lat.framesState), 1)} frames`);
    gate('latency: no trial takes more than 2 frames to reach input.state',
      Math.max(...lat.framesState) <= 2,
      `worst ${Math.max(...lat.framesState)} frames`);
    gate('latency: kart.steerInput responds within 2 frames in >= 95% of trials',
      lat.framesKart.filter((v) => v <= 2).length / n >= 0.95,
      `${(lat.framesKart.filter((v) => v <= 2).length / n * 100).toFixed(0)}% within 2 frames, ` +
      `p95 ${pct(lat.framesKart, 95)}`);
    gate('latency: mean PAGE-SIDE (handler -> applied) <= 1.5x median frame time',
      mean(lat.handlerToState) <= frameMs * 1.5,
      `mean ${f(mean(lat.handlerToState))} ms vs ${f(frameMs * 1.5)} ms budget`,
      { advisory: !realGpu });
    /**
     * Reported, never gated. It is real latency in kind — the event existed for
     * this long before the page could touch it — but its magnitude under
     * headless CDP injection belongs to the browser's delivery path, not to
     * anything in `src/`. Gating on it would fail the build for a number no
     * change to the game could move. It is loud in the report so that nobody
     * quotes the page-side figure as "input latency".
     */
    notes.push(
      `input latency has TWO zeros. Page side (what src/ controls) is ${f(median(lat.handlerToState))} ms ` +
      `median; the browser spent a further ${f(median(lat.deliver))} ms median delivering the event before ` +
      `the page could see it, for ${f(median(lat.stampToState))} ms end to end. CDP transport is only ` +
      `${f(median(lat.transport))} ms, so the delivery leg is the browser's, not the harness's — but its ` +
      'size under headless injection is not attributable to the game, so only the page-side leg is gated. ' +
      'Do not quote the page-side number on its own as "input latency".');
  }

  // =========================================================================
  //  2. STEERING PRECISION
  // =========================================================================
  console.log('\n=== 2. steering precision ===');

  const geom = await page.evaluate(() => {
    const p = window.__ctx.input.pad;
    return { radius: p.radius, innerW: innerWidth, innerH: innerHeight };
  });
  const R = Math.round(geom.radius);
  console.log(`stick radius      : ${R} px (full lock travel), viewport ${geom.innerW}x${geom.innerH}`);

  await releaseAll();
  await frames(3);

  /**
   * A thumb does not sweep in a straight line, so the sweep arcs: y follows a
   * shallow bow across the travel. Only dx feeds the steer curve, so an arc
   * that changed the answer would itself be the finding.
   */
  const SWEEP_Y_BOW = 26;
  const sx = 190, sy = 250;
  await page.evaluate(() => window.__tfArm());
  await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
  await frames(2);
  // Go to full left lock first WITHOUT overshooting (overshoot drags the base).
  await touch('touchMove', [{ x: sx - R, y: sy, id: 1 }]);
  await frames(2);
  for (let d = -R; d <= R; d++) {
    const t = (d + R) / (2 * R);
    const y = sy - Math.round(Math.sin(Math.PI * t) * SWEEP_Y_BOW);
    await touch('touchMove', [{ x: sx + d, y, id: 1 }]);
  }
  const sweepRec = await page.evaluate(() => window.__tfRead());
  await releaseAll();
  await frames(4);

  // Keep only the monotone right-going leg (the first sample is the jump to
  // full left lock and is not part of the sweep).
  const sweep = [];
  for (const m of sweepRec.moves) {
    const d = m.x - sx;
    if (d < -R || d > R) continue;
    if (sweep.length && d <= sweep[sweep.length - 1].d) continue;
    sweep.push({ d, steer: m.steer });
  }

  if (sweep.length < R) {
    exitCode = abort(`the sweep only produced ${sweep.length} samples for ${2 * R + 1} dispatched ` +
      'moves — the pad is not seeing the events, so nothing below would mean anything.');
    throw new Error('sweep');
  }

  const vals = sweep.map((s) => s.steer);
  const key = (v) => v.toFixed(3);
  const distinctAll = new Set(vals.map(key)).size;
  const distinctUsable = new Set(vals.filter((v) => Math.abs(v) > 1e-9 && Math.abs(v) < 0.999).map(key)).size;

  // 20 bins over |steer|
  const BINS = 20;
  const hist = new Array(BINS).fill(0);
  for (const v of vals) hist[Math.min(BINS - 1, Math.floor(Math.abs(v) * BINS))]++;
  const total = vals.length;
  const midband = vals.filter((v) => Math.abs(v) >= 0.15 && Math.abs(v) <= 0.85).length / total;
  const rails = (hist[0] + hist[BINS - 1]) / total;
  const worstBin = Math.max(...hist) / total;

  // Monotonicity and step size along the right-going leg.
  let maxStep = 0, monoBreaks = 0;
  for (let i = 1; i < sweep.length; i++) {
    const dv = sweep[i].steer - sweep[i - 1].steer;
    if (dv < -1e-9) monoBreaks++;
    maxStep = Math.max(maxStep, Math.abs(dv));
  }
  const firstLive = sweep.find((s) => s.d >= 0 && Math.abs(s.steer) > 0);
  const dzPx = firstLive ? firstLive.d : NaN;
  /**
   * The last sample is NOT necessarily the last move dispatched: Chrome
   * coalesces pointermoves that arrive inside one frame, so a 125-step sweep
   * routinely lands 124 samples. Reporting the final value as "steer at the
   * stick radius" therefore quietly reads a value from one pixel short of the
   * radius — which is how an earlier revision of this file failed the build for
   * "not reaching full lock" when the shipped curve reaches it exactly. Carry
   * the travel the sample was actually taken at, and track coverage separately.
   */
  const edge = sweep[sweep.length - 1];
  const steerAtEdge = edge.steer;
  const coverage = sweep.length / (2 * R + 1); // the sweep runs d = -R .. +R

  console.log(`samples           : ${total} over ${2 * R + 1} px of travel`);
  console.log(`distinct values   : ${distinctAll} total, ${distinctUsable} strictly between 0 and full lock`);
  console.log(`dead zone edge    : first non-zero at ${f(dzPx, 0)} px from centre`);
  console.log(`at +${edge.d} px travel  : steer ${f(steerAtEdge, 4)}  ` +
    `(sweep coverage ${(coverage * 100).toFixed(1)}% — the rest was coalesced by the browser)`);
  console.log(`largest 1px step  : ${f(maxStep, 4)} of lock`);
  console.log(`monotonicity      : ${monoBreaks} reversals along a monotone drag`);
  console.log(`in 0.15..0.85     : ${(midband * 100).toFixed(1)}% of samples`);
  console.log(`at the rails      : ${(rails * 100).toFixed(1)}% of samples (|steer| < .05 or > .95)`);
  console.log('\n|steer| histogram (20 bins, both directions folded):');
  for (let b = 0; b < BINS; b++) {
    const lo = (b / BINS).toFixed(2), hi = ((b + 1) / BINS).toFixed(2);
    const share = hist[b] / total;
    console.log(`  ${lo}-${hi}  ${String(hist[b]).padStart(4)}  ${'#'.repeat(Math.round(share * 120))}`);
  }

  // Cross-check: the value the pad reported is the value the game actually got.
  const xcheck = [];
  for (const frac of [0.2, 0.45, 0.7, 0.95]) {
    await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
    await frames(2);
    await touch('touchMove', [{ x: Math.round(sx + R * frac), y: sy, id: 1 }]);
    await frames(4);
    const st = await readState();
    xcheck.push({ frac, pad: st.pad.steer, game: st.in.steer, d: Math.abs(st.pad.steer - st.in.steer) });
    await releaseAll();
    await frames(3);
  }
  const worstX = Math.max(...xcheck.map((c) => c.d));
  console.log(`\npad -> game       : ${xcheck.map((c) => `${c.frac}r ${c.pad}/${c.game}`).join('  ')}`);

  gate('precision: pad.state.steer is what InputState receives', worstX <= 0.001,
    `worst divergence ${f(worstX, 4)}`);
  /**
   * The input contract says `steer > 0` means the player wants to go RIGHT, and
   * the handedness correction lives ONCE, in `Kart.ts` (CLAUDE.md, "Steering
   * handedness"). A touch layer that emitted the chassis sign instead would be
   * a second negation and would invert steering for every phone player, which
   * is the single most expensive bug this repo has shipped. Both the sweep and
   * the cross-check above dragged RIGHTWARD, so the sign is already measured —
   * assert it rather than leaving it in a printout nobody reads.
   */
  gate('precision: a rightward drag emits steer > 0 (the documented input contract)',
    xcheck.every((c) => c.pad > 0 && c.game > 0) && steerAtEdge > 0,
    `rightward cross-check ${xcheck.map((c) => f(c.pad, 3)).join(', ')}; sweep edge ${f(steerAtEdge, 3)}`);
  gate('precision: >= 40 distinct usable levels', distinctUsable >= 40,
    `${distinctUsable} distinct values between 0 and full lock`);
  gate('precision: >= 30% of the sweep lands in 0.15..0.85', midband >= 0.30,
    `${(midband * 100).toFixed(1)}%`);
  gate('precision: no single bin holds > 25% of samples', worstBin <= 0.25,
    `worst bin ${(worstBin * 100).toFixed(1)}%`);
  gate('precision: monotone across a monotone drag', monoBreaks === 0,
    `${monoBreaks} reversals`);
  gate('precision: no 1px step larger than 0.03 of lock', maxStep <= 0.03,
    `largest step ${f(maxStep, 4)}`);
  gate('precision: dead zone under 8 px', Number.isFinite(dzPx) && dzPx <= 8,
    `first non-zero at ${f(dzPx, 0)} px`);

  /**
   * Full lock, and the hard-over shelf.
   *
   * The sweep above stops at `round(radius)` px, which is a hair inside the
   * real (fractional) radius, so it can only ever ASYMPTOTE to 1 — an earlier
   * version of this file gated on "the sweep reaches 0.999" and reported a
   * failure that was entirely its own rounding. Full lock is therefore tested
   * by driving deliberately past the radius, which is also the only way to
   * exercise the trailing base: past the ring `TouchControls` moves the origin
   * to follow the thumb, so a pull back toward centre must respond AT ONCE
   * rather than crossing a dead band first. That "saturates and then feels
   * dead" failure is the reason the floating base exists.
   */
  const OVER = Math.ceil(geom.radius) + 30;
  await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
  await frames(2);
  await touch('touchMove', [{ x: sx + OVER, y: sy, id: 1 }]);
  await frames(4);
  const atLock = (await readState()).pad.steer;
  await touch('touchMove', [{ x: sx + OVER - 8, y: sy, id: 1 }]);
  await frames(4);
  const pulled8 = (await readState()).pad.steer;
  await touch('touchMove', [{ x: sx + OVER - 1, y: sy, id: 1 }]);
  await frames(4);
  const pulled1 = (await readState()).pad.steer;
  await releaseAll();
  await frames(4);
  console.log(`hard-over shelf   : full lock ${f(atLock, 4)}, ` +
    `-1px ${f(pulled1, 4)}, -8px ${f(pulled8, 4)}`);

  gate('precision: full lock is exactly 1.0 past the stick radius', atLock === 1,
    `steer at radius+30px is ${f(atLock, 4)}`);
  gate('precision: pulling back off full lock responds immediately (trailing base)',
    pulled8 < 0.995 && pulled8 > 0.5 && pulled1 < 1,
    `-1px -> ${f(pulled1, 4)}, -8px -> ${f(pulled8, 4)}`);
  gate('precision: the sweep is at the top of its travel by the stick radius',
    steerAtEdge >= 0.95, `steer at +${edge.d}px of a ${R}px radius is ${f(steerAtEdge, 4)}`);
  report.precision = {
    radiusPx: R, samples: total, distinct: distinctAll, distinctUsable,
    deadzonePx: dzPx, sweepCoverage: +coverage.toFixed(3),
    lastSampleTravelPx: edge.d, steerAtLastSample: +f(steerAtEdge, 4),
    fullLock: atLock, pullBack1px: pulled1, pullBack8px: pulled8,
    maxStep: +f(maxStep, 4),
    midbandPct: +(midband * 100).toFixed(1), railsPct: +(rails * 100).toFixed(1),
    worstBinPct: +(worstBin * 100).toFixed(1), histogram: hist,
  };
  gate('precision: the page saw at least 95% of the dispatched moves',
    coverage >= 0.95,
    `${sweep.length} samples of ${2 * R + 1} dispatched (${(coverage * 100).toFixed(1)}%) — ` +
    'below this the histogram is under-sampled and its shape is the browser\'s, not the pad\'s');

  // =========================================================================
  //  3. MULTI-TOUCH
  // =========================================================================
  console.log('\n=== 3. multi-touch ===');

  if (!await raceOk()) await toRacing();
  const centres = await page.evaluate(() => {
    const c = (sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null;
    };
    return { drift: c('.tc-drift'), item: c('.tc-item'), brake: c('.tc-brake') };
  });
  if (!centres.drift || !centres.item) {
    exitCode = abort('DRIFT or ITEM has no box — the cluster is not laid out.');
    throw new Error('cluster');
  }

  const mt = {};
  const A = { x: 150, y: 250, id: 1 };
  const Amoved = { ...A, x: A.x + 40 };
  const B = { ...centres.drift, id: 2 };
  const C = { ...centres.item, id: 3 };
  const D = { x: 90, y: 90, id: 4 };   // a stray fourth, in the steering half

  await releaseAll();
  await frames(4);
  // Chrome assigns its own pointerIds; the CDP `id` field is a touch-point id,
  // not a pointerId, and nothing guarantees the mapping is one-to-one. If four
  // CDP points ever collapsed onto one pointerId this entire section would
  // quietly become a single-finger test that still passed, so the ids the page
  // actually saw are collected and gated below.
  await page.evaluate(() => { window.__tf.downs.length = 0; });

  await touch('touchStart', [A]);
  await frames(2);
  await touch('touchMove', [Amoved]);
  await frames(3);
  mt.aOnly = await readState();
  const S0 = mt.aOnly.pad.steer;

  await touch('touchStart', [Amoved, B]);
  await frames(3);
  mt.plusDrift = await readState();

  await touch('touchStart', [Amoved, B, C]);
  await frames(3);
  mt.plusItem = await readState();

  // A stray fourth point in the steering half while the stick is already live:
  // it must not spawn a second stick nor move the first.
  await touch('touchStart', [Amoved, B, C, D]);
  await frames(3);
  mt.plusStray = await readState();

  // The steering thumb keeps tracking with three other points down.
  await touch('touchMove', [{ ...Amoved, x: Amoved.x + 12 }, B, C, D]);
  await frames(3);
  mt.trackUnderLoad = await readState();
  await touch('touchMove', [Amoved, B, C, D]);
  await frames(3);
  mt.backToS0 = await readState();

  // --- release OUT OF ORDER: the middle one first, then the first, then the last
  await release([D], [Amoved, B, C]);
  await frames(3);
  await release([B], [Amoved, C]);
  await frames(14);                      // past Input's 0.1s drift minimum hold
  mt.driftReleased = await readState();

  await release([Amoved], [C]);
  await frames(4);
  mt.stickReleased = await readState();

  await release([C], []);
  await frames(14);
  mt.allReleased = await readState();

  const mtIds = await page.evaluate(() => window.__tf.downs.map((d) => d.id));

  const show = (k) => {
    const s = mt[k];
    console.log(`  ${k.padEnd(16)} steer ${String(s.pad.steer).padStart(7)}  ` +
      `steering ${String(s.pad.steering).padStart(5)}  drift ${String(s.pad.drift).padStart(5)}  ` +
      `item ${String(s.pad.item).padStart(5)}  active ${String(s.pad.active).padStart(5)}  ` +
      `down[${s.down.join(',')}]`);
  };
  for (const k of Object.keys(mt)) show(k);
  console.log(`  pointerIds the page saw: [${mtIds}]`);

  gate('multi-touch: the four points arrived as four distinct pointerIds',
    new Set(mtIds).size === 4,
    `${new Set(mtIds).size} distinct of ${mtIds.length} pointerdowns [${mtIds}] — ` +
    'anything less and every gate in this section is a one-finger test');
  gate('multi-touch: the stick alone gives a live, mid-range steer',
    Math.abs(S0) > 0.2 && Math.abs(S0) < 1 && mt.aOnly.pad.steering === true,
    `steer ${S0}`);
  gate('multi-touch: DRIFT registers without disturbing the steering thumb',
    mt.plusDrift.pad.drift === true && Math.abs(mt.plusDrift.pad.steer - S0) <= 0.005,
    `drift ${mt.plusDrift.pad.drift}, steer ${mt.plusDrift.pad.steer} vs ${S0}`);
  gate('multi-touch: ITEM registers with steer+drift already held',
    mt.plusItem.pad.item === true && mt.plusItem.pad.drift === true &&
    Math.abs(mt.plusItem.pad.steer - S0) <= 0.005,
    `item ${mt.plusItem.pad.item}, drift ${mt.plusItem.pad.drift}, steer ${mt.plusItem.pad.steer}`);
  gate('multi-touch: a stray 4th point does not steal or move the stick',
    Math.abs(mt.plusStray.pad.steer - S0) <= 0.001 && mt.plusStray.pad.steering === true,
    `steer ${mt.plusStray.pad.steer} vs ${S0}`);
  gate('multi-touch: the stick keeps tracking with three other points down',
    Math.abs(mt.trackUnderLoad.pad.steer - S0) > 0.02 &&
    Math.abs(mt.backToS0.pad.steer - S0) <= 0.005,
    `moved to ${mt.trackUnderLoad.pad.steer}, returned to ${mt.backToS0.pad.steer} (S0 ${S0})`);
  gate('multi-touch: releasing DRIFT out of order drops only DRIFT',
    mt.driftReleased.pad.drift === false && mt.driftReleased.pad.item === true &&
    Math.abs(mt.driftReleased.pad.steer - S0) <= 0.005,
    `drift ${mt.driftReleased.pad.drift}, item ${mt.driftReleased.pad.item}, steer ${mt.driftReleased.pad.steer}`);
  gate('multi-touch: releasing the stick leaves ITEM held',
    mt.stickReleased.pad.steer === 0 && mt.stickReleased.pad.steering === false &&
    mt.stickReleased.pad.item === true,
    `steer ${mt.stickReleased.pad.steer}, steering ${mt.stickReleased.pad.steering}, item ${mt.stickReleased.pad.item}`);
  gate('multi-touch: nothing is stuck after the last release',
    mt.allReleased.pad.steer === 0 && mt.allReleased.pad.steering === false &&
    mt.allReleased.pad.drift === false && mt.allReleased.pad.item === false &&
    mt.allReleased.pad.brake === 0 && mt.allReleased.pad.active === false &&
    mt.allReleased.down.length === 0,
    JSON.stringify(mt.allReleased.pad) + ` down[${mt.allReleased.down.join(',')}]`);

  // --- TWO fingers on ONE control ------------------------------------------
  /**
   * The section above never puts two points on the same control, and that is
   * the one arrangement where "a second pointer steals the first" actually
   * bites: a thumb holding DRIFT through a corner, brushed by a second finger,
   * and then the BRUSH lifts. If the button's ownership follows the newest
   * pointer instead of staying with the one that claimed it, the brush's
   * release drops the drift — mid-corner, with the thumb still on the glass,
   * which costs the mini-turbo and reads as the button randomly letting go.
   * Dropping the `pointer >= 0` guard in `TouchControls.hitButton` reproduces
   * it exactly, and every other gate in this section still passes.
   */
  await releaseAll();
  await frames(4);
  const E = { ...centres.drift, id: 5 };
  const F = { x: centres.drift.x + 10, y: centres.drift.y + 6, id: 6 };
  await touch('touchStart', [E]);
  await frames(3);
  mt.thumbOnDrift = await readState();
  await touch('touchStart', [E, F]);
  await frames(3);
  mt.brushed = await readState();
  await release([F], [E]);
  await frames(14);                      // past Input's 0.1s drift minimum hold
  mt.brushLifted = await readState();
  await release([E], []);
  await frames(14);
  mt.thumbLifted = await readState();
  for (const k of ['thumbOnDrift', 'brushed', 'brushLifted', 'thumbLifted']) show(k);

  gate('multi-touch: a second finger on a held DRIFT does not take it over',
    mt.thumbOnDrift.pad.drift === true && mt.brushed.pad.drift === true &&
    mt.brushLifted.pad.drift === true,
    `held ${mt.thumbOnDrift.pad.drift}, brushed ${mt.brushed.pad.drift}, ` +
    `after the BRUSH lifted (thumb still down) ${mt.brushLifted.pad.drift}`);
  gate('multi-touch: DRIFT releases when the finger that claimed it lifts',
    mt.thumbLifted.pad.drift === false && mt.thumbLifted.down.length === 0,
    `drift ${mt.thumbLifted.pad.drift}, down[${mt.thumbLifted.down.join(',')}]`);

  // --- a 200-event fuzz, then release everything ---------------------------
  /**
   * The sprayer must stay OFF THE CHIPS, and this is not fastidiousness.
   *
   * AUTO and PAUSE bypass everything this section tests — they have their own
   * element listeners and an early return in `TouchControls.onDown` — and both
   * have side effects that outlive the fuzz. PAUSE opens a menu, which hides
   * `.tc-cluster` and makes every measurement after it garbage (CLAUDE.md
   * already records a pause menu permanently ending a race). AUTO changes the
   * control mode AND, through `setAuto`, sets `dirty` — which silently
   * re-measures the hit boxes that §4's padding probe is about to read.
   *
   * That second one actually happened. Two unchanged runs of this file: in the
   * first a fuzz point landed on AUTO, the buttons woke up, and §4 reported
   * "hit padding: buttons +14.6px"; in the second it did not, and §4 aborted
   * with "the padded hit circle is not a constant: drift +-43.9, item +-32.2,
   * brake +-28.3". Same machine, same build, and the difference was a coin
   * toss inside the fuzz. A random test may not mutate global state that a
   * later section measures.
   */
  const chipZone = await page.evaluate(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of document.querySelectorAll('.tc-chip')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    }
    return Number.isFinite(x0) ? { x0: x0 - 28, y0: y0 - 28, x1: x1 + 28, y1: y1 + 28 } : null;
  });
  const onChip = (x, y) => !!chipZone &&
    x >= chipZone.x0 && x <= chipZone.x1 && y >= chipZone.y0 && y <= chipZone.y1;
  console.log(`  fuzz keep-out    : ${chipZone
    ? `chips at ${chipZone.x0.toFixed(0)},${chipZone.y0.toFixed(0)}..${chipZone.x1.toFixed(0)},${chipZone.y1.toFixed(0)}`
    : 'none found (chips not laid out)'}`);

  const fuzzBefore = await page.evaluate(() => ({
    auto: window.__ctx.input.pad.auto, menu: document.documentElement.getAttribute('data-menu'),
  }));
  const fuzzIds = [11, 12, 13, 14, 15];
  const live = new Map();
  const rnd = (a, b) => a + Math.random() * (b - a);
  /** A point anywhere in the frame that is not on a chip. */
  const fuzzPoint = (id) => {
    for (let k = 0; k < 64; k++) {
      const x = Math.round(rnd(4, W - 4)), y = Math.round(rnd(4, H - 4));
      if (!onChip(x, y)) return { x, y, id };
    }
    return { x: Math.round(W * 0.5), y: Math.round(H * 0.8), id };
  };
  /** Nudge a live point, rejecting a step that would walk it onto a chip. */
  const fuzzNudge = (p) => {
    for (let k = 0; k < 64; k++) {
      const x = Math.round(Math.min(W - 4, Math.max(4, p.x + rnd(-90, 90))));
      const y = Math.round(Math.min(H - 4, Math.max(4, p.y + rnd(-60, 60))));
      if (!onChip(x, y)) { p.x = x; p.y = y; return; }
    }
  };
  for (let i = 0; i < 200; i++) {
    const id = fuzzIds[(Math.random() * fuzzIds.length) | 0];
    const roll = Math.random();
    if (!live.has(id) || roll < 0.3) {
      const p = fuzzPoint(id);
      live.set(id, p);
      await touchSafe('touchStart', [...live.values()]);
    } else if (roll < 0.75) {
      fuzzNudge(live.get(id));
      await touchSafe('touchMove', [...live.values()]);
    } else {
      const p = live.get(id);
      live.delete(id);
      await touchSafe('touchEnd', RELEASE === 'listed-are-released' ? [p] : [...live.values()]);
    }
  }
  await touchSafe('touchCancel', []);
  await releaseAll();
  await frames(20);
  const afterFuzz = await readState();
  console.log(`  ${'afterFuzz'.padEnd(16)} ${JSON.stringify(afterFuzz.pad)}  down[${afterFuzz.down.join(',')}]`);
  /**
   * Did the keep-out hold? If a fuzz point still reached a chip, the AUTO mode
   * or the menu state has changed under §4, and §4's numbers are about a layout
   * this run never characterised. Gate it rather than discovering it as an
   * inexplicable disagreement between two runs.
   */
  const fuzzAfter = await page.evaluate(() => ({
    auto: window.__ctx.input.pad.auto, menu: document.documentElement.getAttribute('data-menu'),
    race: window.__ctx.race.state,
  }));
  gate('multi-touch: the fuzz did not trip a chip or open a menu',
    fuzzAfter.auto === fuzzBefore.auto && fuzzAfter.menu === fuzzBefore.menu,
    `AUTO ${fuzzBefore.auto} -> ${fuzzAfter.auto}, menu ${fuzzBefore.menu} -> ${fuzzAfter.menu} ` +
    `(race state ${fuzzAfter.race}) — a chip hit here silently re-measures the hit boxes §4 reads`);
  gate('multi-touch: a 200-event fuzz leaves no stuck state',
    afterFuzz.pad.steer === 0 && afterFuzz.pad.steering === false && afterFuzz.pad.drift === false &&
    afterFuzz.pad.item === false && afterFuzz.pad.brake === 0 && afterFuzz.pad.active === false &&
    afterFuzz.down.length === 0,
    JSON.stringify(afterFuzz.pad) + ` down[${afterFuzz.down.join(',')}]`);

  // =========================================================================
  //  4. REACHABILITY
  // =========================================================================
  console.log('\n=== 4. reachability ===');
  console.log('(Chrome reports env(safe-area-inset-*) as 0 however the viewport is emulated, so');
  console.log(' these are ZERO-INSET layouts scored against each device\'s real inset band. A box');
  console.log(' inside the band is only a violation when the CSS carries no env() term for that side.)');

  /**
   * Read the SPECIFIED value of the inset-bearing properties out of the CSSOM.
   * `getComputedStyle` has already resolved `env()` to 0px and would report
   * every rule as safe — the failure mode this is looking for is not a wrong
   * number, it is no number at all.
   */
  const envTerms = await page.evaluate(() => {
    const want = ['.tc-cluster', '.tc-top', '.tc-stick-zone'];
    const out = {};
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of rules) {
        if (!rule.selectorText) continue;
        for (const sel of want) {
          if (!rule.selectorText.split(',').some((s) => s.trim().endsWith(sel))) continue;
          const e = out[sel] ??= { top: false, right: false, bottom: false, left: false };
          for (const side of ['top', 'right', 'bottom', 'left']) {
            const v = rule.style.getPropertyValue(side);
            if (v && v.includes(`env(safe-area-inset-${side}`)) e[side] = true;
          }
        }
      }
    }
    return out;
  });
  console.log(`env() terms       : ${Object.entries(envTerms)
    .map(([k, v]) => `${k}{${Object.entries(v).filter(([, on]) => on).map(([s]) => s).join('+') || 'NONE'}}`)
    .join('  ')}`);

  // --- how big is the hit target, really? ----------------------------------
  /**
   * Walk a REAL touch outward from a control's centre until it stops
   * registering, and return the last distance that did. Probing runs LEFTWARD
   * because the cluster's other controls are up and to the left of DRIFT but
   * never level with it at the radii involved, and the whole point is to find
   * this control's own edge rather than the first neighbour that outranks it in
   * `hitButton`'s list order — so the probe also stops the moment a DIFFERENT
   * control lights up, and says which.
   */
  async function probeReachLeft(check, cx, cy, w, extra) {
    let last = -1, stolenBy = null;
    const from = Math.max(0, Math.floor(w / 2) - 3);
    /**
     * ONE pixel per step, not two. The reported padding is "the last offset
     * that still registered", so a 2 px stride biases it low by up to 2 px on
     * every control — and the abort below only tolerates a 3 px spread, so the
     * bias hid inside the tolerance while shifting every `hitSide` in §4 by the
     * same ~2 px. This probe is the only thing standing between the report and
     * a constant copied out of TouchControls.ts; it should be exact.
     *
     * `touchEnd [p]` was also dispatched with the point named, which only means
     * "release p" under one of the two conventions `probeRelease` distinguishes
     * — it happened not to matter because `releaseAll` follows, but a file whose
     * thesis is "the convention is probed, not assumed" should not assume it
     * three hundred lines later. Just release everything.
     */
    for (let d = from; d <= Math.floor(w / 2) + extra; d += 1) {
      const p = { x: Math.round(cx - d), y: Math.round(cy), id: 41 };
      await touch('touchStart', [p]);
      await frames(2);
      const who = await check();
      await releaseAll();
      await frames(2);
      if (who === true) { last = d; continue; }
      if (typeof who === 'string') stolenBy = who;
      break;
    }
    return { last, stolenBy };
  }

  /**
   * Pin AUTO before probing. §3's fuzz used to be able to toggle it, and the
   * chip's own width changes with its label ("AUTO" 47.7 px vs "MANUAL" 64.8
   * px) — so the chip padding was being computed against whichever label the
   * fuzz happened to leave behind. It is pinned to the shipped default here and
   * §4's own loop sets it explicitly per profile afterwards.
   */
  await page.evaluate(() => { const p = window.__ctx.input.pad; if (!p.auto) p.setAuto(true); });
  await frames(4);

  const padProbe = [];
  for (const id of ['drift', 'item', 'brake', 'look']) {
    const box = await page.evaluate((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width } : null;
    }, `.tc-${id}`);
    if (!box) continue;
    const { last, stolenBy } = await probeReachLeft(
      () => page.evaluate((want) => {
        const d = document.querySelector('.tc-btn.down');
        if (!d) return false;
        const got = d.getAttribute('data-btn');
        return got === want ? true : got;      // a string names the thief
      }, id),
      box.cx, box.cy, box.w, 40);
    padProbe.push({ id, w: box.w, reach: last, pad: last - box.w / 2, stolenBy });
  }
  // The AUTO chip. It is the only chip that can be probed — pressing PAUSE
  // opens the pause menu and ends the run — and it is probed by watching its
  // own label flip, then restored. PAUSE shares the class, the stylesheet and
  // the early-return in `TouchControls.onDown`, so it is taken to match.
  //
  // COVERAGE LOST, DELIBERATELY, AND SAID OUT LOUD.
  //
  // The AUTO chip was removed from the game: auto-accelerate is permanent on
  // touch, so there is nothing left to toggle (see `TouchControls.setAuto`).
  // It was the only chip this probe could press — PAUSE opens the pause menu
  // and ends the run — so with it gone, CHIP hit padding is no longer
  // measurable at all. PAUSE still ships, still uses `.tc-chip`, and its
  // padding is now UNVERIFIED.
  //
  // This is reported rather than quietly skipped, and the button padding
  // (measured from four real controls) is used in its place so the size
  // verdicts below still have a number to work from.
  const chipBox = await page.evaluate(() => {
    const r = document.querySelector('.tc-auto')?.getBoundingClientRect();
    if (!r) return null;
    window.__tfChip0 = document.querySelector('.tc-auto').textContent;
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width };
  });
  const chipProbe = chipBox ? await probeReachLeft(
    () => page.evaluate(() => {
      const t = document.querySelector('.tc-auto').textContent;
      const flipped = t !== window.__tfChip0;
      window.__tfChip0 = t;
      return flipped;
    }),
    chipBox.cx, chipBox.cy, chipBox.w, 30) : null;
  await frames(3);

  /**
   * A reading that stopped because a NEIGHBOUR claimed the touch is a lower
   * bound, not a measurement — the probe found the edge of the neighbour's hit
   * circle, which is nearer than this control's own. DRIFT is the worst case:
   * it is the biggest button, parked in the corner, and ITEM outranks it in
   * `hitButton`'s list order about 2 px inside its true reach, so DRIFT alone
   * reported +14.1 px against a true +16. Folding those into the median drags
   * the constant down for every control on every profile. Keep only the clean
   * readings; report the bounded ones as bounds.
   */
  const cleanProbe = padProbe.filter((p) => !p.stolenBy && p.reach >= 0);
  const pads = cleanProbe.map((p) => p.pad);
  const BTN_PAD = pads.length ? median(pads) : NaN;
  const CHIP_PAD = chipProbe && chipBox
    ? Math.max(0, chipProbe.last - chipBox.w / 2)
    : BTN_PAD;
  for (const p of padProbe) {
    console.log(`hit probe .tc-${p.id.padEnd(6)}: drawn ${f(p.w, 1)}px wide, registers out to ${p.reach}px ` +
      `from centre -> +${f(p.pad, 1)}px of padding` + (p.stolenBy ? `  (stopped: ${p.stolenBy} claimed it)` : ''));
  }
  if (chipBox && chipProbe) {
    console.log(`hit probe .tc-auto  : drawn ${f(chipBox.w, 1)}px wide, registers out to ${chipProbe.last}px ` +
      `-> +${f(CHIP_PAD, 1)}px of padding`);
  } else {
    console.warn('hit probe .tc-chip  : NOT MEASURED — the AUTO chip is gone (auto-accelerate is now ' +
      'permanent) and PAUSE cannot be probed without ending the run. PAUSE\'s hit padding is ' +
      `unverified; the button padding (+${f(BTN_PAD, 1)}px) is assumed for it below.`);
  }
  console.log(`hit padding         : buttons +${f(BTN_PAD, 1)}px (median of ${cleanProbe.length} clean ` +
    `reading${cleanProbe.length === 1 ? '' : 's'}: ${cleanProbe.map((p) => p.id).join(', ') || 'none'}), ` +
    `chips +${f(CHIP_PAD, 1)}px  (measured, not read off the CSS)`);

  /**
   * The padding is a constant added to a radius, so it does not change with the
   * viewport and one measurement at the reference size is reused for all six
   * profiles. If the four buttons disagree it is not a constant, the model is
   * wrong, and every size verdict below would be built on it.
   */
  if (!(pads.length >= 2) || Math.max(...pads) - Math.min(...pads) > 2) {
    exitCode = abort(`the padded hit circle is not a constant: ${padProbe
      .map((p) => `${p.id} ${p.stolenBy ? '>=' : '+'}${f(p.pad, 1)}${p.stolenBy ? ` (bounded by ${p.stolenBy})` : ''}`)
      .join(', ')}.\n` +
      `  ${cleanProbe.length} unbounded reading(s); at least 2 within 2px of each other are needed.\n` +
      '  Every touch-target verdict below assumes a single constant; fix the model before trusting them.\n' +
      '  If every reading is -1 the buttons are not registering at all — see the `controls:` gate above.');
    throw new Error('padding');
  }

  report.hitPadding = {
    buttonsPx: +f(BTN_PAD, 2), chipsPx: +f(CHIP_PAD, 2),
    cleanReadings: cleanProbe.map((p) => p.id), probe: padProbe,
  };

  const reach = [];
  for (const prof of PROFILES) {
    await page.setViewport({
      width: prof.w, height: prof.h, isMobile: true, hasTouch: true,
      deviceScaleFactor: Math.min(3, prof.dpr),
    });
    await frames(6);

    for (const auto of [true, false]) {
      await page.evaluate((on) => {
        const pad = window.__ctx.input.pad;
        if (pad.auto !== on) pad.setAuto(on);
      }, auto);
      await frames(3);

      const rects = await page.evaluate(([btnPad, chipPad]) => {
        const out = [];
        for (const el of document.querySelectorAll('.tc-btn, .tc-chip')) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width === 0 || r.height === 0 || cs.display === 'none' || cs.visibility === 'hidden') continue;
          const isBtn = el.classList.contains('tc-btn');
          out.push({
            id: el.getAttribute('data-btn') || (el.classList.contains('tc-auto') ? 'auto' : el.className),
            x: r.left, y: r.top, w: r.width, h: r.height,
            // MEASURED above by walking a real touch outward, not read off the
            // CSS and not copied from TouchControls.ts.
            grow: isBtn ? btnPad : chipPad,
            circle: isBtn ? r.width / 2 + btnPad : 0,
          });
        }
        return out;
      }, [BTN_PAD, CHIP_PAD]);

      for (const r of rects) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const minSide = Math.min(r.w, r.h);
        const clear = {
          t: r.y, l: r.x, r: prof.w - (r.x + r.w), b: prof.h - (r.y + r.h),
        };
        // Which hand's pivot governs this control: the cluster and the chips
        // right of centre use the right thumb, everything else the left.
        const rightHand = cx > prof.w * 0.5;
        const pivot = rightHand ? { x: prof.w + 8, y: prof.h + 10 } : { x: -8, y: prof.h + 10 };
        const reachMm = Math.hypot(cx - pivot.x, cy - pivot.y) * prof.mmPerPx;
        const inBand = [];
        for (const [side, key] of [['t', 't'], ['r', 'r'], ['b', 'b'], ['l', 'l']]) {
          if (prof.inset[key] > 0 && clear[side] < prof.inset[key]) inBand.push(key);
        }
        // Which CSS rule positions this control, and does it carry an env() term?
        const owner = r.id === 'auto' || r.id === 'pause' ? '.tc-top' : '.tc-cluster';
        const covered = inBand.filter((side) => {
          const e = envTerms[owner];
          // .tc-cluster is anchored right+bottom, .tc-top top+left: an inset on
          // a side the rule does not anchor to cannot be compensated at all.
          return e && e[{ t: 'top', r: 'right', b: 'bottom', l: 'left' }[side]];
        });
        const uncovered = inBand.filter((s) => !covered.includes(s));
        /**
         * How far the pad's generous hit circle runs off the frame.
         * REPORTED, NOT GATED: the off-screen part of a hit circle is simply
         * unreachable, it steals nothing from anything, and a control parked in
         * the corner has no choice about it. What WOULD be a defect is a hit
         * circle overlapping a NEIGHBOUR's drawn face, and that is
         * `touch-ergo.mjs`'s question, not this file's.
         */
        const hitOverhang = r.circle === 0 ? 0 : Math.max(0,
          r.circle - cx, r.circle - cy, cx + r.circle - prof.w, cy + r.circle - prof.h);
        /**
         * The 44 px floor is a TAPPABLE-AREA floor, so it is scored on the
         * measured hit target — the drawn box grown by the padding probed
         * above. LOOK is drawn at 41 px and tappable across 73; scoring the
         * drawn box failed the build on three profiles for a control that is
         * not too small. The drawn size is still carried, and still printed,
         * because a control too small to AIM at is a different complaint and
         * one this file only has an opinion about, not a measurement.
         */
        const hitSide = minSide + 2 * r.grow;

        reach.push({
          prof: prof.name, auto, id: r.id,
          w: r.w, h: r.h, minSide, hitSide, cx, cy, clear, reachMm,
          mm: minSide * prof.mmPerPx, hitMm: hitSide * prof.mmPerPx,
          inBand, covered, uncovered, hitOverhang,
          tooSmall: hitSide < TARGET_FLOOR_PX,
          drawnSmall: minSide < TARGET_FLOOR_PX,
          tooFar: reachMm > (Math.min(prof.w, prof.h) < 500 ? ARC_PHONE_MM : ARC_TABLET_MM),
          chip: r.circle === 0,
        });
      }
    }
    // leave AUTO in its shipped default
    await page.evaluate(() => { const p = window.__ctx.input.pad; if (!p.auto) p.setAuto(true); });
  }
  await page.setViewport({ width: W, height: H, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await frames(6);

  const byProfile = new Map();
  for (const r of reach) {
    const k = `${r.prof}|${r.auto ? 'AUTO' : 'MANUAL'}`;
    (byProfile.get(k) ?? byProfile.set(k, []).get(k)).push(r);
  }
  for (const [k, rows] of byProfile) {
    console.log(`\n  ${k}`);
    console.log('    control    drawn px   hit px  hit mm  thumb mm   edge clear t/r/b/l    flags');
    for (const r of rows) {
      const flags = [
        r.tooSmall ? `SMALL(hit <${TARGET_FLOOR_PX}px)` : '',
        !r.tooSmall && r.drawnSmall ? 'drawn-small(hit ok)' : '',
        r.uncovered.length ? `UNDER-INSET(${r.uncovered.join('')})` : '',
        r.covered.length ? `env-ok(${r.covered.join('')})` : '',
        r.hitOverhang > 0 ? `hit-overhang ${r.hitOverhang.toFixed(0)}px` : '',
        r.tooFar && !r.chip ? 'OUT-OF-ARC' : '',
      ].filter(Boolean).join(' ');
      console.log(`    ${String(r.id).padEnd(9)}` +
        `${(r.w.toFixed(0) + 'x' + r.h.toFixed(0)).padStart(9)}` +
        `${f(r.hitSide, 0).padStart(9)}` +
        `${f(r.hitMm, 1).padStart(8)}` +
        `${f(r.reachMm, 1).padStart(10)}   ` +
        `${[r.clear.t, r.clear.r, r.clear.b, r.clear.l].map((v) => f(v, 0).padStart(5)).join('')}   ` +
        `${flags}`);
    }
  }

  const small = reach.filter((r) => r.tooSmall);
  const drawnOnly = reach.filter((r) => r.drawnSmall && !r.tooSmall);
  const underInset = reach.filter((r) => r.uncovered.length);
  const overhang = reach.filter((r) => r.hitOverhang > 0);
  const outOfArc = reach.filter((r) => r.tooFar && !r.chip);
  const idRange = (rs, key) =>
    `${f(Math.min(...rs.map((r) => r[key])), 1)}–${f(Math.max(...rs.map((r) => r[key])), 1)}px, ` +
    `${new Set(rs.map((r) => r.prof)).size} profiles`;

  console.log(`\n  summary: ${small.length} with a HIT TARGET under the ${TARGET_FLOOR_PX}px floor, ` +
    `${drawnOnly.length} drawn small but tappable, ` +
    `${underInset.length} inside an inset band with no env() cover, ` +
    `${outOfArc.length} outside the thumb arc, ` +
    `${overhang.length} with hit circle running off-frame (informational) ` +
    `(of ${reach.length} control/viewport/AUTO combinations)`);
  if (small.length) {
    console.log(`  under the floor : ${[...new Set(small.map((r) => r.id))].map((id) =>
      `${id} (${idRange(small.filter((r) => r.id === id), 'hitSide')})`).join(', ')}`);
  }
  if (drawnOnly.length) {
    console.log(`  drawn small     : ${[...new Set(drawnOnly.map((r) => r.id))].map((id) => {
      const rs = drawnOnly.filter((r) => r.id === id);
      return `${id} (drawn ${idRange(rs, 'minSide')}; hit ${idRange(rs, 'hitSide')})`;
    }).join(', ')}  — reported, not gated: the padded circle carries them`);
  }
  if (outOfArc.length) {
    console.log(`  outside the arc : ${[...new Set(outOfArc.map((r) => `${r.id}@${r.prof}`))].join(', ')}`);
  }

  report.reachability = {
    combinations: reach.length,
    underFloor: small.length, drawnSmallButTappable: drawnOnly.length,
    underInset: underInset.length,
    hitCircleOverhang: overhang.length, outOfArc: outOfArc.length,
    offenders: [...new Set(small.map((r) => r.id))],
  };
  gate(`reachability: every control's MEASURED hit target meets the ${TARGET_FLOOR_PX}px floor`,
    small.length === 0,
    `${small.length} combinations under the floor` +
    (small.length ? `, smallest ${f(Math.min(...small.map((r) => r.hitSide)), 1)}px hit target ` +
      `(${[...new Set(small.map((r) => r.id))].join(', ')} carry no padding at all)` : ''));
  gate('reachability: no control sits inside a safe-area inset without an env() term',
    underInset.length === 0,
    `${underInset.length} combinations` +
    (underInset.length ? `: ${[...new Set(underInset.map((r) => `${r.id}@${r.prof}(${r.uncovered.join('')})`))].slice(0, 6).join(', ')}` : ''));
  gate('reachability: every cluster control is inside the thumb arc', outOfArc.length === 0,
    `${outOfArc.length} combinations` +
    (outOfArc.length ? `, furthest ${f(Math.max(...outOfArc.map((r) => r.reachMm)), 1)}mm` : ''));

  // =========================================================================
  //  5. GESTURE CONFLICT
  // =========================================================================
  console.log('\n=== 5. gesture conflict ===');

  const gest = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      return el ? getComputedStyle(el).getPropertyValue(prop).trim() : '(missing)';
    };
    /**
     * `touch-action` does NOT inherit — but its EFFECT does. The browser
     * intersects the declared value of the hit element with every ancestor's,
     * so `html { touch-action: none }` already forbids panning and zooming
     * inside a descendant whose own computed value is the initial `auto`.
     * Reading `getComputedStyle(.tc-drift).touchAction` and asserting 'none'
     * therefore fails a page that is completely correct, which is what the
     * first version of this harness did. Walk the chain instead.
     */
    const effectiveTouchAction = (sel) => {
      const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
      if (!el) return { effective: '(missing)', chain: [] };
      const chain = [];
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        chain.push(`${n.tagName.toLowerCase()}${n.className ? '.' + String(n.className).split(' ')[0] : ''}` +
          `=${getComputedStyle(n).touchAction}`);
      }
      const none = chain.some((c) => c.endsWith('=none'));
      return { effective: none ? 'none' : chain[0].split('=')[1], chain };
    };

    const out = {
      htmlTouchAction: cs(document.documentElement, 'touch-action'),
      bodyTouchAction: cs(document.body, 'touch-action'),
      canvasTouchAction: effectiveTouchAction('canvas').effective,
      rootTouchAction: effectiveTouchAction('.tc-root').effective,
      btnTouchAction: effectiveTouchAction('.tc-drift').effective,
      btnTouchActionChain: effectiveTouchAction('.tc-drift').chain.join(' < '),
      htmlOverscroll: cs(document.documentElement, 'overscroll-behavior'),
      bodyOverscroll: cs(document.body, 'overscroll-behavior'),
      bodyUserSelect: cs(document.body, 'user-select') || cs(document.body, '-webkit-user-select'),
      rootUserSelect: cs('.tc-root', 'user-select') || cs('.tc-root', '-webkit-user-select'),
      btnUserSelect: cs('.tc-drift', 'user-select') || cs('.tc-drift', '-webkit-user-select'),
      /**
       * `-webkit-touch-callout` is WebKit-only and the long-press callout it
       * suppresses only exists on iOS — which is exactly the platform this
       * harness cannot run on. Chrome does not implement the property, and
       * (unlike a merely unsupported VALUE) it DISCARDS the whole declaration
       * at parse time, so `getComputedStyle` returns '' and the CSSOM has no
       * such property either. Both of those read as "the stylesheet is wrong"
       * on a stylesheet that is right; earlier revisions of this file failed
       * the page for both in turn.
       *
       * The declaration's presence is therefore checked in the stylesheet
       * SOURCE, which is the only place Chrome has not thrown it away, and it
       * is labelled as the text check it is. The behavioural half of the same
       * question — does a long press raise a menu — is `contextmenuPrevented`,
       * and that one is genuinely observable here.
       */
      calloutDeclared: (() => {
        const sheets = [...document.querySelectorAll('style')];
        const i = sheets.findIndex((s) => /-webkit-touch-callout\s*:\s*none/.test(s.textContent || ''));
        return i >= 0 ? `<style> block #${i} (source text)` : '';
      })(),
      tapHighlight: cs(document.body, '-webkit-tap-highlight-color'),
      viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? '(none)',
      scrollY: scrollY, scrollX: scrollX,
      /**
       * Can this document scroll AT ALL? "the page never scrolled" is worth
       * nothing on a document that has no overflow to scroll — it would pass on
       * a page with every gesture guard deleted. The gate below says so.
       */
      scrollable: document.documentElement.scrollHeight > innerHeight + 1 ||
        document.documentElement.scrollWidth > innerWidth + 1,
    };

    // A long press on a control must not raise the OS callout / context menu.
    out.contextmenuPrevented = !document.querySelector('.tc-drift')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

    // Safari's proprietary pinch events, which `user-scalable=no` does not stop.
    out.gesturePrevented = ['gesturestart', 'gesturechange', 'gestureend']
      .every((t) => !dispatchEvent(new Event(t, { cancelable: true })));

    // Double-tap-to-zoom: the SECOND touchend inside the window must be cancelled.
    try {
      const te = () => new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [], targetTouches: [] });
      dispatchEvent(te());
      out.doubleTapPrevented = !dispatchEvent(te());
    } catch (e) { out.doubleTapPrevented = `unavailable: ${e.message}`; }

    // Two-finger pan/pinch anywhere that is not a control.
    try {
      const mk = (id, x) => new Touch({ identifier: id, target: document.body, clientX: x, clientY: 200 });
      const tm = new TouchEvent('touchmove', {
        bubbles: true, cancelable: true,
        touches: [mk(1, 100), mk(2, 300)], changedTouches: [mk(1, 100)], targetTouches: [],
      });
      out.pinchPrevented = !document.body.dispatchEvent(tm);
    } catch (e) { out.pinchPrevented = `unavailable: ${e.message}`; }

    // A selection attempt on a control label.
    out.selectstartPrevented = (() => {
      const sel = getSelection();
      sel?.removeAllRanges();
      const el = document.querySelector('.tc-drift span') || document.querySelector('.tc-drift');
      const r = document.createRange();
      r.selectNodeContents(el);
      sel?.addRange(r);
      const txt = String(sel);
      sel?.removeAllRanges();
      // user-select:none makes the range collapse to nothing selectable.
      return getComputedStyle(el).getPropertyValue('user-select') === 'none' || txt === '';
    })();
    return out;
  });

  // Did the pad's own pointerdown handler cancel the default action? That is
  // what stops the browser starting a scroll / selection gesture from the press.
  await touch('touchStart', [{ x: centres.drift.x, y: centres.drift.y, id: 7 }]);
  await frames(3);
  await releaseAll();
  await touch('touchStart', [{ x: 150, y: 250, id: 7 }]);
  await frames(3);
  await releaseAll();
  await frames(3);
  const prevented = await page.evaluate(() => window.__tf.prevented.slice(-2));
  gest.buttonDownPrevented = prevented[0]?.prevented === true;
  gest.stickDownPrevented = prevented[1]?.prevented === true;

  const scrolled = await page.evaluate(() => ({ x: scrollX, y: scrollY }));

  for (const [k, v] of Object.entries(gest)) console.log(`  ${k.padEnd(24)} ${v}`);
  console.log(`  ${'scroll after drags'.padEnd(24)} ${scrolled.x},${scrolled.y}`);

  const noneish = (v) => v === 'none';
  gate('gesture: effective touch-action is none on the page and every control',
    noneish(gest.htmlTouchAction) && noneish(gest.bodyTouchAction) &&
    noneish(gest.canvasTouchAction) && noneish(gest.rootTouchAction) && noneish(gest.btnTouchAction),
    `html ${gest.htmlTouchAction}, body ${gest.bodyTouchAction}, canvas ${gest.canvasTouchAction}, ` +
    `.tc-root ${gest.rootTouchAction}, .tc-drift ${gest.btnTouchAction} (${gest.btnTouchActionChain})`);
  gate('gesture: no pull-to-refresh / back-swipe (overscroll-behavior none)',
    noneish(gest.htmlOverscroll) && noneish(gest.bodyOverscroll),
    `html ${gest.htmlOverscroll}, body ${gest.bodyOverscroll}`);
  gate('gesture: no text selection on controls',
    noneish(gest.bodyUserSelect) && noneish(gest.rootUserSelect) && noneish(gest.btnUserSelect) &&
    gest.selectstartPrevented === true,
    `body ${gest.bodyUserSelect}, .tc-root ${gest.rootUserSelect}, .tc-drift ${gest.btnUserSelect}`);
  /**
   * The four gates below dispatch SYNTHETIC events and check that the page's
   * own handler cancels them. They are handler-presence checks and their names
   * say so, because this browser cannot be made to zoom: with `touch-action`
   * forced to `auto`, the viewport meta rewritten and the page's cancellers
   * swallowed, a CDP two-finger spread and a CDP double tap both leave
   * `visualViewport.scale` at exactly 1. In a browser that will not zoom when
   * invited to, "it did not zoom" says nothing about the page, so the real
   * pipeline cannot answer this question at all and a check that pretended it
   * could would be decoration. What CAN be shown is that the handler which
   * would cancel the gesture is installed and does cancel — that is what these
   * measure, and the behavioural half needs a real iOS device.
   */
  gate('gesture: the long-press callout handler cancels contextmenu (synthetic; behaviour needs iOS)',
    gest.contextmenuPrevented === true && gest.calloutDeclared !== '',
    `contextmenu prevented ${gest.contextmenuPrevented}, ` +
    `-webkit-touch-callout:none declared on ${gest.calloutDeclared || 'NOTHING'}`);
  gate('gesture: the pinch handlers cancel Safari gesture* and multi-finger touchmove (synthetic)',
    gest.gesturePrevented === true && gest.pinchPrevented === true,
    `gesture* ${gest.gesturePrevented}, two-finger touchmove ${gest.pinchPrevented}`);
  gate('gesture: the double-tap handler cancels the second touchend (synthetic)',
    gest.doubleTapPrevented === true, `second touchend prevented: ${gest.doubleTapPrevented}`);
  gate('gesture: the page never scrolls under a drag',
    scrolled.x === 0 && scrolled.y === 0,
    `scroll ${scrolled.x},${scrolled.y}` +
    (gest.scrollable ? '' : ' — but the document has no overflow, so this gate cannot fail here'),
    { advisory: !gest.scrollable && scrolled.x === 0 && scrolled.y === 0 });
  gate('gesture: control and stick presses cancel the default action',
    gest.buttonDownPrevented === true && gest.stickDownPrevented === true,
    `button ${gest.buttonDownPrevented}, stick ${gest.stickDownPrevented}`);
  gate('gesture: viewport meta carries viewport-fit=cover',
    /viewport-fit\s*=\s*cover/.test(gest.viewport), gest.viewport);

  if (pageErrors.length) {
    gate('no uncaught page errors', false, pageErrors.slice(0, 3).join(' | '));
  }

  // =========================================================================
  //  Report
  // =========================================================================
  emitReport(false);

  if (fails.length) {
    console.log(`\nFAIL — ${fails.length} of ${gates.length} gates failed:`);
    for (const x of fails) console.log(`  - ${x}`);
    exitCode = 1;
  } else {
    console.log(`\nPASS — all ${gates.length} gates hold`);
  }
} catch (e) {
  if (!exitCode) {
    /**
     * Puppeteer's wording for this is "Execution context was destroyed, most
     * likely because of a navigation", which sends the reader looking for a
     * navigation this file never performs. The navigation is vite's: an edit to
     * the working tree during the run triggers an HMR full reload. Say so, and
     * exit 2 — this is an instrument failure, not a verdict on the controls.
     */
    if (reloads > 0 || /TF_RELOADED|Execution context was destroyed|Target closed|Session closed/i
      .test(String(e?.message))) {
      console.error(`\nABORT (instrument): the page was reloaded ${Math.max(reloads, 1)} time(s) mid-run.\n` +
        '  Almost certainly vite HMR: something edited the working tree while the harness was\n' +
        '  measuring, and the reload destroyed the in-page instrument. Nothing above this line is\n' +
        '  wrong, but the run is incomplete. Re-run against a tree nobody else is editing.\n' +
        `  ${e.message}`);
    } else {
      console.error(e);
    }
    exitCode = 2;
  }
  // Whatever went wrong, say what the run had already established. See the
  // comment on `emitReport`: this used to be discarded wholesale.
  try { emitReport(true); } catch { /* the failure was before the report existed */ }
} finally {
  await browser.close();
  srv.stop();
}
process.exit(exitCode);
