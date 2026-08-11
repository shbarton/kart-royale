/**
 * ============================================================================
 *  "Prove the pipe" — Phase 1 verification
 * ============================================================================
 *  The question this answers: does an input travel player -> relay -> host, and
 *  does a snapshot travel host -> relay -> player? That round-trip IS phase 1 of
 *  the multiplayer plan (docs/multiplayer/DESIGN.md §4). If this passes, the
 *  networking spine is real and everything else builds on it.
 *
 *  It boots the real relay in-process, connects a fake HOST and a fake PLAYER
 *  with socket.io-client, and asserts both directions actually arrive.
 *
 *  Run:  node server/test-pipe.mjs      (exit 0 = pass, non-zero = fail)
 * ============================================================================
 */
import { io as connect } from 'socket.io-client';

process.env.PORT = process.env.PORT || '8091';       // avoid clashing with a real relay
const { httpServer } = await import('./relay.mjs');
const URL = `http://localhost:${process.env.PORT}`;
const ROOM = 'TEST';

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout waiting for ${what}`)), ms))]);
const joined = (sock, role, name) =>
  new Promise((res) => sock.emit('join', { room: ROOM, role, name }, res));

let host, player;
try {
  // 1. Connect the authoritative host and one player into the same room.
  host = connect(URL, { transports: ['websocket'] });
  player = connect(URL, { transports: ['websocket'] });
  await withTimeout(new Promise((r) => host.on('connect', r)), 3000, 'host connect');
  await withTimeout(new Promise((r) => player.on('connect', r)), 3000, 'player connect');

  const hostJoin = await withTimeout(joined(host, 'host'), 3000, 'host join ack');
  if (!hostJoin?.ok || hostJoin.youAre !== 'host') fail(`host join bad ack: ${JSON.stringify(hostJoin)}`);

  const playerJoin = await withTimeout(joined(player, 'player', 'Pip'), 3000, 'player join ack');
  if (!playerJoin?.ok || playerJoin.youAre !== 'player') fail(`player join bad ack: ${JSON.stringify(playerJoin)}`);
  console.log('✓ host + player joined room', ROOM);

  // 2. Host should have learned about the player via a roster update.
  const seenRoster = await withTimeout(
    new Promise((res) => {
      const check = (r) => { if (r.players?.some((p) => p.name === 'Pip')) res(r); };
      host.on('roster', check);
    }), 3000, 'host roster with player');
  console.log('✓ host sees player in roster:', seenRoster.players.map((p) => p.name).join(', '));

  // 3. PLAYER -> HOST : an input frame arrives at the host, tagged with sender.
  const gotInput = withTimeout(new Promise((res) => host.on('input', res)), 3000, 'input at host');
  player.emit('input', { seq: 1, steer: 0.5, throttle: 1, drift: false });
  const inp = await gotInput;
  if (inp.steer !== 0.5 || inp.throttle !== 1 || !inp.from) fail(`input arrived wrong: ${JSON.stringify(inp)}`);
  console.log('✓ player input reached host:', JSON.stringify({ steer: inp.steer, from: inp.from.slice(0, 6) }));

  // 4. HOST -> PLAYER : a snapshot broadcast reaches the player.
  const gotSnap = withTimeout(new Promise((res) => player.on('snapshot', res)), 3000, 'snapshot at player');
  host.emit('snapshot', { t: 123, karts: [{ id: 0, x: 1, z: 2, yaw: 0.1 }] });
  const snap = await gotSnap;
  if (snap.t !== 123 || snap.karts?.[0]?.x !== 1) fail(`snapshot arrived wrong: ${JSON.stringify(snap)}`);
  console.log('✓ host snapshot reached player:', JSON.stringify(snap.karts[0]));

  // 5. Non-host must NOT be able to broadcast snapshots (host arbitration).
  let leaked = false;
  host.on('snapshot', () => { leaked = true; });
  player.emit('snapshot', { t: 999, karts: [] });
  await new Promise((r) => setTimeout(r, 300));
  if (leaked) fail('a non-host snapshot leaked to the host — arbitration is broken');
  console.log('✓ non-host snapshot correctly ignored');

  console.log('\nPIPE OK — player→host inputs and host→player snapshots both flow. Phase 1 spine works.');
  process.exit(0);
} catch (e) {
  fail(e.message || String(e));
} finally {
  host?.close(); player?.close(); httpServer?.close();
}
