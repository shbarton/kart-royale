/**
 * ============================================================================
 *  Does a network race actually work?
 * ============================================================================
 *  Runs a real one. Starts the relay, opens two browsers, has one host a room
 *  and the other join it, starts the race, holds the throttle down on the
 *  CLIENT, and then asks four questions that a screenshot cannot answer:
 *
 *   1. Do the karts a client does not own MOVE? (snapshots arrive, are decoded,
 *      and reach `Kart.netPose`)
 *   2. Are they moving along the path the HOST drove, and how far behind?
 *      (interpolation is showing the authority's world, not a plausible-looking
 *      simulation of its own)
 *   3. Did holding the throttle on the client make the HOST's copy of that kart
 *      accelerate? (the input path, which is the half a snapshot test cannot
 *      reach)
 *   4. Do both machines agree on the lap and the running order? (the race has
 *      one truth, which was the entire point of doing it this way)
 *
 *  Question 2 is the one worth explaining. Two pages cannot be sampled at the
 *  same instant, and by design the client is rendering ~90 ms in the past
 *  (`INTERP_DELAY_MS`), so comparing positions taken "at the same time" would
 *  fail on a perfectly working build — a kart at 25 m/s covers 2.3 m in that
 *  window. So the host records its own trajectory as it drives, and each of the
 *  client's karts is measured against the nearest point on that recorded path.
 *  A client showing the host's world sits ON the line and slightly behind; a
 *  client running its own simulation wanders OFF it. The test is the distance
 *  to the line, not the distance to a timestamp.
 *
 *  Run:  node tools/net-race.mjs
 *        node tools/net-race.mjs --headful     (watch it happen)
 * ============================================================================
 */
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { startVite, portOpen } from './vite-server.mjs';

const root = new URL('..', import.meta.url).pathname;
const VITE_PORT = 5179;
const RELAY_PORT = 8099;
const ROOM = 'TEST';
/**
 * The lights take 4.4 s. Anything under about eight seconds is measuring a
 * standing start — the first run of this harness "failed" with every kart
 * having travelled 3-35 m, which is simply what a grid looks like 1.6 s after
 * GO. Give it a real stretch of racing to measure.
 */
const RACE_MS = 13000;
const HEADFUL = process.argv.includes('--headful');

/** Tolerances. Generous on purpose — this is a correctness test, not a benchmark. */
const LIMITS = {
  /** a remote kart that moves less than this over the run is not being posed */
  minRemoteTravel: 25,
  /** how far off the host's own path a client kart may sit */
  maxPathError: 2.5,
  /** the client is meant to be behind; this much is a bug, not a delay */
  maxLagMs: 400,
  /** the throttle was held for seconds; the host must show it moved */
  minClientKartTravel: 25,
  /**
   * Above this median frame time the client page is not running well enough for
   * the lag gate to mean anything — 50 ms is three missed vsyncs, i.e. a page
   * that is being starved rather than one that is behind on packets.
   */
  starvedFrameMs: 50,
};

let starved = false;

const cleanups = [];
async function cleanup(code) {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* teardown */ } }
  process.exit(code);
}
process.on('SIGINT', () => cleanup(130));

// --- relay -------------------------------------------------------------------
if (await portOpen(RELAY_PORT)) {
  console.error(`[net-race] something is already listening on ${RELAY_PORT}; refusing to guess what.`);
  process.exit(1);
}
const relay = spawn(process.execPath, ['server/relay.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(RELAY_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
relay.stderr.on('data', (b) => process.stderr.write(`[relay] ${b}`));
cleanups.push(() => relay.kill('SIGKILL'));
for (let i = 0; i < 60 && !(await portOpen(RELAY_PORT)); i++) await wait(100);
if (!(await portOpen(RELAY_PORT))) { console.error('[net-race] the relay never came up'); await cleanup(1); }

// --- game --------------------------------------------------------------------
const server = await startVite(VITE_PORT);
cleanups.push(() => server.stop());

const browser = await puppeteer.launch({
  headless: HEADFUL ? false : 'shell',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--window-size=900,620'],
});
cleanups.push(() => browser.close());

const url = `http://127.0.0.1:${VITE_PORT}/?quality=low&scaler=off&relay=http://127.0.0.1:${RELAY_PORT}`;
const host = await openGame(browser, url, 'host');
const client = await openGame(browser, url, 'client');

// --- get them into the same room ---------------------------------------------
await host.evaluate((room) => window.__net.connect('host', room, 'Host'), ROOM);
await client.evaluate((room) => window.__net.connect('player', room, 'Kid'), ROOM);

// The host learns about the client through the relay's roster broadcast. If this
// never lands, nothing after it means anything, so it is a hard gate.
await host.waitForFunction('window.__net.players.length >= 2', { timeout: 15000 })
  .catch(async () => { console.error('[net-race] the host never saw the client join'); await cleanup(1); });

const seat = await client.evaluate(() => window.__net.mySeat);
console.log(`[net-race] client took seat ${seat}`);
if (seat < 1) { console.error('[net-race] the client was not given a seat of its own'); await cleanup(1); }

// --- race --------------------------------------------------------------------
await host.evaluate(() => window.__net.startRace(300));
await Promise.all([
  host.waitForFunction('window.__net.phase === "racing"', { timeout: 10000 }),
  client.waitForFunction('window.__net.phase === "racing"', { timeout: 10000 }),
]);

// Nobody is sitting at the host's keyboard, so hand its kart to the AI —
// otherwise kart 0 is a parked car and the one kart the comparison cannot say
// anything about. `autoDrive` is the sanctioned hook for exactly this and
// changes nothing else about the kart.
await host.evaluate(() => { window.__ctx.race.autoDrive = true; });

// Record the host's own trajectory for every kart, in page time, while it runs.
await host.evaluate(() => {
  window.__trace = new Map();
  window.__traceStop = false;
  const tick = () => {
    if (window.__traceStop) return;
    const t = performance.now();
    for (const k of window.__ctx.race.karts) {
      let a = window.__trace.get(k.id);
      if (!a) { a = []; window.__trace.set(k.id, a); }
      a.push([t, k.position.x, k.position.y, k.position.z]);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// Hold the throttle on the CLIENT, with real key events — the point is to
// exercise the whole input stack, not to poke a number into the state object.
// Watch the client's own frame interval, so a starved page can say so.
await client.evaluate(() => {
  let last = performance.now();
  const seen = [];
  const tick = () => {
    const now = performance.now();
    seen.push(now - last);
    last = now;
    if (seen.length > 600) seen.shift();
    window.__frameMs = seen.slice().sort((a, b) => a - b)[seen.length >> 1];
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

await client.bringToFront();
await client.keyboard.down('ArrowUp');

// The lights are 4.4 s. Race past them.
await wait(RACE_MS);

// Sample both ends as close together as the two pages allow, then stop.
// How healthy was the client's own frame loop? The lag gate below compares two
// pages' clocks, so it is only meaningful if the client was actually running.
// One run of this harness failed with every remote kart "2550 ms behind the
// host" and an immediate re-run passed at 87 ms with identical finishing
// orders — the client page had been starved, which CLAUDE.md warns about
// directly ("benchmark runs degrade this machine, so idle between them"). A
// starved page must report itself as starved rather than as a netcode fault.
const clientFrames = await client.evaluate(() => window.__frameMs ?? -1);

const clientState = await client.evaluate(() => ({
  at: performance.now(),
  karts: window.__ctx.race.karts.map((k) => ({
    id: k.id, x: k.position.x, y: k.position.y, z: k.position.z,
    lap: k.lap, place: k.place, isPlayer: k.isPlayer,
  })),
  state: window.__ctx.race.state,
}));
const hostState = await host.evaluate(() => {
  window.__traceStop = true;
  return {
    at: performance.now(),
    remotes: window.__net.debugRemotes(),
    trace: [...window.__trace].map(([id, pts]) => [id, pts]),
    karts: window.__ctx.race.karts.map((k) => ({
      id: k.id, x: k.position.x, y: k.position.y, z: k.position.z,
      lap: k.lap, place: k.place, speed: k.forwardSpeed,
    })),
    state: window.__ctx.race.state,
  };
});
await client.keyboard.up('ArrowUp');

// --- measure -----------------------------------------------------------------
const trace = new Map(hostState.trace);
const failures = [];
const rows = [];

// Q3, directly: did the host hear anything at all from the client? A kart that
// did not move could be a kart nobody pressed a key on, so ask the host what it
// received rather than inferring it from a distance.
const heard = hostState.remotes.find((r) => r.seat === seat);
console.log(`[net-race] host heard from seat ${seat}: ${JSON.stringify(heard)}`);
if (!heard || heard.lastSeq <= 0) {
  failures.push('the host received no input packets from the client at all');
} else if (heard.accel < 0.5) {
  failures.push(`the throttle was held on the client, but the host sees accel=${heard.accel}`);
}

for (const ck of clientState.karts) {
  const pts = trace.get(ck.id) || [];
  if (pts.length < 30) { failures.push(`kart ${ck.id}: the host recorded no path for it`); continue; }

  // Travel, as the host saw it and as the client drew it.
  const first = pts[0];
  const last = pts[pts.length - 1];
  const hostTravel = dist3(first[1], first[2], first[3], last[1], last[2], last[3]);

  // Nearest point on the host's own path, and how far back along it that is.
  let best = Infinity;
  let bestT = 0;
  for (const p of pts) {
    const d = dist3(ck.x, ck.y, ck.z, p[1], p[2], p[3]);
    if (d < best) { best = d; bestT = p[0]; }
  }
  const lagMs = last[0] - bestT;

  rows.push({
    kart: ck.id,
    who: ck.isPlayer ? 'CLIENT' : 'remote',
    hostTravel: +hostTravel.toFixed(1),
    pathError: +best.toFixed(2),
    lagMs: Math.round(lagMs),
    lapHost: hostState.karts[ck.id].lap,
    lapClient: ck.lap,
    placeHost: hostState.karts[ck.id].place,
    placeClient: ck.place,
  });

  if (ck.isPlayer) {
    // Q3: the throttle was held over there; this is the host's copy of that kart.
    if (hostTravel < LIMITS.minClientKartTravel) {
      failures.push(
        `the client's own kart moved only ${hostTravel.toFixed(1)} m on the HOST — ` +
        `its input is not arriving`,
      );
    }
  } else {
    // Q1 + Q2.
    if (hostTravel < LIMITS.minRemoteTravel) {
      failures.push(`kart ${ck.id} barely moved on the host (${hostTravel.toFixed(1)} m) — bad sample`);
    } else if (best > LIMITS.maxPathError) {
      failures.push(
        `kart ${ck.id} is ${best.toFixed(2)} m off the host's path — the client is not ` +
        `showing the host's world`,
      );
    } else if (lagMs > LIMITS.maxLagMs) {
      // Only a fault if the client was keeping up well enough to be judged.
      if (clientFrames > LIMITS.starvedFrameMs) {
        starved = true;
      } else {
        failures.push(`kart ${ck.id} is ${Math.round(lagMs)} ms behind the host — too far`);
      }
    }
  }

  // Q4.
  if (ck.lap !== hostState.karts[ck.id].lap) {
    failures.push(`kart ${ck.id}: lap ${ck.lap} on the client, ${hostState.karts[ck.id].lap} on the host`);
  }
  if (ck.place !== hostState.karts[ck.id].place) {
    failures.push(`kart ${ck.id}: place ${ck.place} on the client, ${hostState.karts[ck.id].place} on the host`);
  }
}

console.table(rows);
console.log(`[net-race] race state — host ${hostState.state}, client ${clientState.state}`);
console.log(`[net-race] client median frame ${clientFrames.toFixed?.(1) ?? clientFrames} ms`);
if (starved) {
  console.warn(
    `[net-race] LAG GATE SKIPPED: the client page was starved (median frame ` +
    `${Math.round(clientFrames)} ms). Positions and standings were still checked. ` +
    `Idle the machine and re-run before believing anything about latency.`,
  );
}

// --- does anything besides position cross the wire? --------------------------
const stats = {
  host: await host.evaluate(() => ({ ...window.__net.stats })),
  client: await client.evaluate(() => ({ ...window.__net.stats })),
};
console.log(`[net-race] traffic — ${JSON.stringify(stats)}`);
if (stats.client.snapshotsIn < 100) {
  failures.push(`the client received only ${stats.client.snapshotsIn} snapshots in ${RACE_MS} ms`);
}
if (stats.client.eventsIn === 0) {
  failures.push('no events reached the client — laps, hits and every thrown shell are missing');
}
if (stats.client.itemsReplayed === 0) {
  // Not fatal on its own: over a short run the field may genuinely not have
  // thrown anything. Say so rather than passing in silence.
  console.warn('[net-race] WARNING: no item was replayed on the client during this run');
}

// --- does the race END, and do both ends agree on it? ------------------------
// A one-lap race, so this takes a minute rather than four. The flag is worth
// testing separately because it is the one transition a client does not compute
// for itself: it stops racing because the HOST said the race is over.
console.log('[net-race] running a one-lap race to the flag…');
await Promise.all([
  host.evaluate(() => { window.__ctx.race.totalLaps = 1; }),
  client.evaluate(() => { window.__ctx.race.totalLaps = 1; }),
]);
await host.evaluate(() => window.__net.startRace(300));
await client.keyboard.down('ArrowUp');
const finished = await host
  .waitForFunction('window.__ctx.race.state >= 3', { timeout: 240000, polling: 500 })
  .then(() => true)
  .catch(() => false);
await client.keyboard.up('ArrowUp');

if (!finished) {
  failures.push('the host never reached the flag in four minutes — could not test the finish');
} else {
  const settled = await client
    .waitForFunction('window.__ctx.race.state >= 3', { timeout: 15000, polling: 200 })
    .then(() => true)
    .catch(() => false);
  const ends = {
    host: await host.evaluate(() => ({
      state: window.__ctx.race.state,
      order: window.__ctx.race.standings.map((k) => k.id),
    })),
    client: await client.evaluate(() => ({
      state: window.__ctx.race.state,
      order: window.__ctx.race.standings.map((k) => k.id),
    })),
  };
  console.log(`[net-race] finish — ${JSON.stringify(ends)}`);
  if (!settled) failures.push('the host finished the race and the client never did');
  if (ends.host.order.join(',') !== ends.client.order.join(',')) {
    failures.push(
      `the two machines disagree about who won: host ${ends.host.order} vs client ${ends.client.order}`,
    );
  }
}

if (failures.length) {
  console.error('\nFAIL');
  for (const f of failures) console.error(`  - ${f}`);
  await cleanup(1);
}
console.log('\nPASS — two machines, one race.');
await cleanup(0);

// -----------------------------------------------------------------------------

async function openGame(br, target, label) {
  const page = await br.newPage();
  await page.setViewport({ width: 900, height: 620 });
  page.on('pageerror', (e) => console.error(`[${label}] page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.error(`[${label}] ${m.text()}`); });
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__gameReady === true', { timeout: 120000 });
  return page;
}

function dist3(ax, ay, az, bx, by, bz) {
  const dx = ax - bx, dy = ay - by, dz = az - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
