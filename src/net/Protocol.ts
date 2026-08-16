/**
 * ============================================================================
 *  MULTIPLAYER WIRE PROTOCOL
 * ============================================================================
 *  The only file that both ends agree on byte-for-byte. Everything the host
 *  sends and everything a client sends is encoded here and nowhere else, so
 *  there is exactly one place to look when the two disagree.
 *
 *  See `docs/multiplayer/DESIGN.md` for why the architecture is
 *  host-authoritative state sync rather than lockstep. The short version: the
 *  physics is not deterministic across devices, so we ship STATE, not inputs.
 *
 *  Two hot messages are packed into `Float32Array` rather than JSON:
 *
 *    snapshot   host -> everyone, SNAPSHOT_HZ times a second
 *    input      client -> host, INPUT_HZ times a second
 *
 *  A snapshot of eight karts is 8 x 25 + 6 floats — about 830 bytes, versus
 *  ~4 kB of JSON for the same numbers. That is the difference between 20 kB/s
 *  and 100 kB/s per phone, and it costs one `subarray` at each end. Everything
 *  cold (joining, the lobby, ready-up) stays as readable JSON objects, because
 *  those are sent a handful of times per race and legibility is worth more.
 *
 *  RULE: if you add a field, add it at the END of its block and bump
 *  PROTOCOL_VERSION. The join handshake refuses a mismatched version rather
 *  than letting two builds decode each other's floats into the wrong slots —
 *  which does not error, it just puts a kart's lap counter into its Y position.
 * ============================================================================
 */

export const PROTOCOL_VERSION = 1;

/** Host broadcast rate. Interpolation hides the gap; see INTERP_DELAY_MS. */
export const SNAPSHOT_HZ = 25;
/** Client input rate. Tiny packets — this is latency, so it is not stingy. */
export const INPUT_HZ = 60;

/**
 * How far in the past remote karts are rendered, milliseconds.
 *
 * Entity interpolation: we draw other karts BETWEEN two snapshots we already
 * hold rather than at the newest one, so a late packet slides instead of
 * teleporting. The delay has to exceed one snapshot interval (40 ms at 25 Hz)
 * or the buffer runs dry between packets and the karts stutter — 90 ms leaves
 * two full intervals of slack, which on a LAN is never consumed.
 *
 * This costs nothing on your OWN kart: that one is simulated locally from your
 * own input and only *corrected* by the host, so steering stays instant.
 */
export const INTERP_DELAY_MS = 90;

/** A dropped player's seat is held this long before it reverts to AI. */
export const REJOIN_GRACE_MS = 45_000;

// ---------------------------------------------------------------------------
//  Room codes
// ---------------------------------------------------------------------------

/**
 * No vowels (cannot spell anything), and no 0/O/1/I/5/S — the six characters
 * a child reading a TV across a room gets wrong. Four of these is 20 bits,
 * which is ample for one house.
 */
const CODE_ALPHABET = 'BCDFGHJKMNPQRTVWXYZ2346789';

export function makeRoomCode(len = 4): string {
  let s = '';
  const r = new Uint32Array(len);
  crypto.getRandomValues(r);
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[r[i] % CODE_ALPHABET.length];
  return s;
}

/** Normalise anything a human typed into a comparable room code. */
export function cleanRoomCode(raw: string): string {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

// ---------------------------------------------------------------------------
//  Cold messages (JSON) — join, lobby, and the client's control channel
// ---------------------------------------------------------------------------

export type Role = 'host' | 'player';

export interface JoinRequest {
  room: string;
  name: string;
  role: Role;
  /** Stable across reconnects and reloads — this, not socket.id, owns a seat. */
  uid: string;
  v: number;
}

export interface RosterEntry {
  id: string;
  uid?: string;
  name: string;
  seat: number | null;
}

export interface JoinAck {
  ok: boolean;
  error?: string;
  youAre?: Role;
  room?: string;
  roster?: { host: boolean; players: RosterEntry[] };
}

/** One racer as the lobby screen shows them. Authored by the host. */
export interface LobbyPlayer {
  uid: string;
  name: string;
  /** index into `race.karts` — which machine they are driving */
  seat: number;
  ready: boolean;
  /** false while they are inside the rejoin grace window */
  connected: boolean;
  /** true for the machine running the authoritative simulation */
  host: boolean;
}

export type LobbyMessage =
  /** The whole lobby, re-sent whenever anything in it changes. */
  | { t: 'lobby'; players: LobbyPlayer[]; laps: number }
  /**
   * Go. Everyone — including the host — calls `race.start()` this many
   * milliseconds after RECEIVING this, which is deliberately not a wall-clock
   * timestamp: phones do not agree on the time of day, and asking them to
   * would import a clock-sync problem to solve a LAN-latency one. The spread
   * between two devices is then one LAN hop, ~2-5 ms.
   */
  | { t: 'start'; startIn: number; players: LobbyPlayer[] }
  /** Everyone back to the lobby (host quit the race, or a rematch). */
  | { t: 'lobby-return' };

export type ToHostMessage =
  | { t: 'ready'; ready: boolean }
  | { t: 'name'; name: string }
  /** Client is alive again after a background/reconnect; resend it everything. */
  | { t: 'resync' };

// ---------------------------------------------------------------------------
//  Input (client -> host), packed
// ---------------------------------------------------------------------------

export const INPUT_STRIDE = 8;

export interface NetInput {
  /** Monotonic per client. The host ignores anything older than it has. */
  seq: number;
  steer: number;
  accel: number;
  /**
   * True when `accel` is the auto-accelerate assist holding the throttle rather
   * than the player asking for it — the same distinction `InputState.accelAuto`
   * draws locally, and it has to cross the wire for the same reason. The rocket
   * start reads a held throttle as a decision, and auto-accelerate is ON by
   * default on touch: without this bit the host sees every phone holding full
   * throttle for the whole countdown and burns all of them out on the line.
   */
  accelAuto: boolean;
  brake: number;
  drift: boolean;
  /**
   * A COUNT of item presses, not a boolean.
   *
   * Item use is a rising edge, and an edge cannot survive a lossy sample: at
   * 60 Hz input against a 60 Hz host, a press that lands between two sends is
   * simply gone, and the player's shell never fires. Sending a running total
   * instead makes the host's job "how many more presses than last time", which
   * cannot lose one however the packets arrive.
   */
  itemPresses: number;
  /** held — fires the item backwards, same as brake/look-back locally */
  back: boolean;
}

export function encodeInput(i: NetInput, out = new Float32Array(INPUT_STRIDE)): Float32Array {
  out[0] = i.seq;
  out[1] = i.steer;
  out[2] = i.accel;
  out[3] = i.brake;
  out[4] = i.drift ? 1 : 0;
  out[5] = i.itemPresses;
  out[6] = i.back ? 1 : 0;
  out[7] = i.accelAuto ? 1 : 0;
  return out;
}

export function decodeInput(buf: ArrayBufferLike): NetInput | null {
  const a = toFloats(buf, INPUT_STRIDE);
  if (!a) return null;
  return {
    seq: a[0],
    steer: clamp(a[1], -1, 1),
    accel: clamp(a[2], 0, 1),
    brake: clamp(a[3], 0, 1),
    drift: a[4] > 0.5,
    itemPresses: a[5],
    back: a[6] > 0.5,
    accelAuto: a[7] > 0.5,
  };
}

// ---------------------------------------------------------------------------
//  Snapshot (host -> everyone), packed
// ---------------------------------------------------------------------------

/** [seq, raceTime, state, countdown, kartCount, eventCount] */
export const SNAP_HEADER = 6;
/** floats per kart — see the field order in `writeKart` */
export const KART_STRIDE = 25;
/** floats per event — [type, a, b, c] */
export const EVENT_STRIDE = 4;

export const enum NetEvent {
  ItemUse = 1,
  Hit = 2,
  Lap = 3,
  Finish = 4,
  Pickup = 5,
  Boost = 6,
  Respawn = 7,
}

/** Bit field packed into kart slot 16. */
export const enum KartFlag {
  Finished = 1 << 0,
  Airborne = 1 << 1,
  DriftLeft = 1 << 2,
  DriftRight = 1 << 3,
  IsHuman = 1 << 4,
}

export interface NetKart {
  id: number;
  x: number; y: number; z: number;
  yaw: number;
  /** chassis up, X and Z only — Y is recovered, it is a unit vector */
  upx: number; upz: number;
  vx: number; vy: number; vz: number;
  forwardSpeed: number;
  steerAngle: number;
  t: number;
  lap: number;
  place: number;
  raceDistance: number;
  flags: number;
  driftTier: number;
  driftCharge: number;
  stunTime: number;
  boostTime: number;
  starTime: number;
  itemKind: number;
  itemCount: number;
  surface: number;
  tyreSlip: number;
}

export interface NetEventRec { type: number; a: number; b: number; c: number }

export interface Snapshot {
  seq: number;
  raceTime: number;
  state: number;
  countdown: number;
  karts: NetKart[];
  events: NetEventRec[];
}

export function encodeSnapshot(s: Snapshot): ArrayBuffer {
  const n = s.karts.length;
  const m = s.events.length;
  const a = new Float32Array(SNAP_HEADER + n * KART_STRIDE + m * EVENT_STRIDE);
  a[0] = s.seq;
  a[1] = s.raceTime;
  a[2] = s.state;
  a[3] = s.countdown;
  a[4] = n;
  a[5] = m;
  let o = SNAP_HEADER;
  for (let i = 0; i < n; i++) {
    const k = s.karts[i];
    a[o + 0] = k.id;
    a[o + 1] = k.x; a[o + 2] = k.y; a[o + 3] = k.z;
    a[o + 4] = k.yaw;
    a[o + 5] = k.upx; a[o + 6] = k.upz;
    a[o + 7] = k.vx; a[o + 8] = k.vy; a[o + 9] = k.vz;
    a[o + 10] = k.forwardSpeed;
    a[o + 11] = k.steerAngle;
    a[o + 12] = k.t;
    a[o + 13] = k.lap;
    a[o + 14] = k.place;
    a[o + 15] = k.raceDistance;
    a[o + 16] = k.flags;
    a[o + 17] = k.driftTier;
    a[o + 18] = k.driftCharge;
    a[o + 19] = k.stunTime;
    a[o + 20] = k.boostTime;
    a[o + 21] = k.starTime;
    a[o + 22] = k.itemKind;
    a[o + 23] = k.itemCount;
    a[o + 24] = k.surface * 1000 + k.tyreSlip;   // two small values, one slot
    o += KART_STRIDE;
  }
  for (let i = 0; i < m; i++) {
    const e = s.events[i];
    a[o + 0] = e.type; a[o + 1] = e.a; a[o + 2] = e.b; a[o + 3] = e.c;
    o += EVENT_STRIDE;
  }
  return a.buffer as ArrayBuffer;
}

export function decodeSnapshot(buf: ArrayBufferLike): Snapshot | null {
  const a = toFloats(buf, SNAP_HEADER);
  if (!a) return null;
  const n = a[4] | 0;
  const m = a[5] | 0;
  if (n < 0 || m < 0 || a.length < SNAP_HEADER + n * KART_STRIDE + m * EVENT_STRIDE) return null;
  const karts: NetKart[] = [];
  let o = SNAP_HEADER;
  for (let i = 0; i < n; i++) {
    const packed = a[o + 24];
    karts.push({
      id: a[o + 0] | 0,
      x: a[o + 1], y: a[o + 2], z: a[o + 3],
      yaw: a[o + 4],
      upx: a[o + 5], upz: a[o + 6],
      vx: a[o + 7], vy: a[o + 8], vz: a[o + 9],
      forwardSpeed: a[o + 10],
      steerAngle: a[o + 11],
      t: a[o + 12],
      lap: a[o + 13] | 0,
      place: a[o + 14] | 0,
      raceDistance: a[o + 15],
      flags: a[o + 16] | 0,
      driftTier: a[o + 17] | 0,
      driftCharge: a[o + 18],
      stunTime: a[o + 19],
      boostTime: a[o + 20],
      starTime: a[o + 21],
      itemKind: a[o + 22] | 0,
      itemCount: a[o + 23] | 0,
      surface: Math.floor(packed / 1000),
      tyreSlip: packed - Math.floor(packed / 1000) * 1000,
    });
    o += KART_STRIDE;
  }
  const events: NetEventRec[] = [];
  for (let i = 0; i < m; i++) {
    events.push({ type: a[o] | 0, a: a[o + 1], b: a[o + 2], c: a[o + 3] });
    o += EVENT_STRIDE;
  }
  return { seq: a[0], raceTime: a[1], state: a[2] | 0, countdown: a[3] | 0, karts, events };
}

// ---------------------------------------------------------------------------
//  Shared helpers
// ---------------------------------------------------------------------------

/**
 * socket.io hands binary back as an `ArrayBuffer` in the browser and as a Node
 * `Buffer` on the relay's own test harness. A `Buffer` is a `Uint8Array` view
 * that is very often NOT aligned to 4 bytes and is usually a window onto a much
 * larger pooled allocation — so `new Float32Array(buf.buffer)` either throws or
 * silently decodes the neighbouring packet. Copy the exact byte range instead.
 */
function toFloats(buf: ArrayBufferLike | ArrayBufferView, min: number): Float32Array | null {
  let a: Float32Array;
  try {
    if (ArrayBuffer.isView(buf)) {
      const v = buf as ArrayBufferView;
      a = new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    } else {
      a = new Float32Array(buf as ArrayBuffer);
    }
  } catch {
    return null;
  }
  return a.length >= min ? a : null;
}

function clamp(v: number, lo: number, hi: number) {
  return !Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v;
}

/** Recover the Y component of a unit up-vector sent as (x, z). */
export function upY(x: number, z: number): number {
  const s = 1 - x * x - z * z;
  return s > 0 ? Math.sqrt(s) : 0;
}
