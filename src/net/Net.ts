/**
 * ============================================================================
 *  MULTIPLAYER SESSION — the whole of the netcode, both ends
 * ============================================================================
 *  One `System`, ticked after `Race`, that is either the AUTHORITY or a
 *  WATCHER depending on how the player entered the race.
 *
 *  HOST      runs the game exactly as single-player does, except that some
 *            seats are steered by controls that arrived over the wire instead
 *            of by the AI. After each frame it publishes the world.
 *
 *  CLIENT    simulates ONE kart — its own, so that steering is instant — and
 *            poses the other seven from the host's snapshots, two frames in
 *            the past, sliding between them. It counts no laps, rolls no items
 *            and picks no winner: all of that is read off the wire.
 *
 *  Why this shape and not lockstep, and why the relay is deliberately stupid,
 *  is argued in `docs/multiplayer/DESIGN.md`. The one-line version: the
 *  chassis is not deterministic across devices, so state has to be shipped
 *  rather than re-derived, and the authority has to be a machine that is
 *  already running the game — porting the physics to run headless in Node is
 *  the single most expensive thing available and it buys nothing.
 *
 *  Everything on the wire is defined in `Protocol.ts` and nowhere else.
 * ============================================================================
 */
import { io, type Socket } from 'socket.io-client';
import { ItemKind, RaceState, type Ctx, type System } from '../types';
import type { Kart } from '../kart/Kart';
import type { Race, RemoteCmd } from '../game/Race';
import type { Items } from '../game/Items';
import {
  INPUT_HZ,
  INTERP_DELAY_MS,
  KartFlag,
  NetEvent,
  PROTOCOL_VERSION,
  REJOIN_GRACE_MS,
  SNAPSHOT_HZ,
  cleanRoomCode,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  type JoinAck,
  type LobbyMessage,
  type LobbyPlayer,
  type NetInput,
  type NetKart,
  type Role,
  type RosterEntry,
  type Snapshot,
  type ToHostMessage,
} from './Protocol';

export type NetPhase =
  | 'off'          // single player; nothing here is running
  | 'connecting'
  | 'lobby'
  | 'racing'
  | 'error';

/** Kept out of the race: a seat waiting for a dropped player to come back. */
interface Reserved { seat: number; until: number }

/** Host-side record of one connected player. */
interface RemotePlayer {
  uid: string;
  socketId: string;
  name: string;
  seat: number;
  ready: boolean;
  lastSeq: number;
  /** running total of item presses the client has ever sent */
  presses: number;
  /** how many of those we have already fired */
  firedPresses: number;
  cmd: RemoteCmd;
  lastHeard: number;
}

const IDLE_CMD: RemoteCmd = {
  steer: 0, accel: 0, accelAuto: false, brake: 0, drift: false, itemUses: 0, back: false,
};

/**
 * How hard the local kart is pulled toward the host's version of it, per frame.
 *
 * Low on purpose. This is the one correction the player can feel — it is their
 * own kart moving without them — and on a LAN the error being corrected is
 * centimetres. 12% a frame closes a gap in about five frames, which is under
 * the threshold where a steady drift reads as the kart being dragged.
 */
const SELF_BLEND = 0.12;

export class Net implements System {
  // ---------------------------------------------------------------- public

  phase: NetPhase = 'off';
  role: Role = 'player';
  room = '';
  error = '';
  /** the lobby as the host publishes it; the UI renders straight off this */
  players: LobbyPlayer[] = [];
  /** which kart this machine drives, or -1 before a seat has been handed out */
  mySeat = -1;
  myName = '';

  /**
   * Subscribe to "anything about who is in this race has changed".
   *
   * A list rather than a single slot: the lobby screen wants it to redraw its
   * roster, and the HUD wants it to keep the in-race name board honest. The
   * single-callback version silently gave the whole feature to whichever of
   * them was constructed second.
   */
  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private listeners: (() => void)[] = [];

  get active(): boolean { return this.phase !== 'off' && this.phase !== 'error'; }
  get isHost(): boolean { return this.role === 'host'; }

  /** Round-trip to the relay in milliseconds, or -1 before the first reply. */
  ping = -1;

  /**
   * Harness hook (`tools/net-race.mjs`): what the host has actually heard from
   * each remote player. `lastSeq` moving is the only direct evidence that the
   * input half of the loop is alive — a kart that fails to move could equally
   * be a kart nobody is pressing anything on.
   */
  debugRemotes(): { seat: number; name: string; lastSeq: number; accel: number }[] {
    return [...this.remotes.values()].map((p) => ({
      seat: p.seat, name: p.name, lastSeq: p.lastSeq, accel: p.cmd.accel,
    }));
  }

  /**
   * Harness hook: running totals for the things that are otherwise invisible.
   *
   * `itemsReplayed` in particular — a client that never replays an item-use
   * event looks completely healthy from the outside. The karts are in the right
   * places and the standings are right, because all of that comes from
   * positions. What is missing is every shell in the race, and the first person
   * to notice is a child asking why nothing happens when their brother throws
   * something.
   */
  readonly stats = { snapshotsIn: 0, snapshotsOut: 0, eventsIn: 0, itemsReplayed: 0 };

  // --------------------------------------------------------------- internals

  private ctx!: Ctx;
  private race!: Race;
  private items!: Items;
  private socket: Socket | null = null;
  private readonly uid = stableUid();

  // --- host ---
  private remotes = new Map<string, RemotePlayer>();     // by uid
  private bySocket = new Map<string, string>();          // socket.id -> uid
  private byKart = new Map<number, RemotePlayer>();      // seat -> player
  private reserved = new Map<string, Reserved>();
  private snapAccum = 0;
  private snapSeq = 0;
  private pendingEvents: { type: number; a: number; b: number; c: number }[] = [];

  // --- client ---
  private buffer: { at: number; snap: Snapshot }[] = [];
  private lastAppliedSeq = -1;
  private inputAccum = 0;
  private inputSeq = 0;
  private presses = 0;
  private itemEdge = false;
  private readonly inputBuf = new Float32Array(8);
  /**
   * When this client last fired something itself.
   *
   * Firing is optimistic — the shell leaves your kart the instant you press,
   * before the host has been told. For the next fraction of a second the host
   * is still reporting the item as HELD, and copying that back would put the
   * icon you just spent back on the HUD until the truth caught up. So the
   * held-item sync stands down briefly after a local fire.
   */
  private localFireAt = 0;
  /** a countdown scheduled by the host's `start`, in seconds; <=0 is idle */
  private startIn = 0;
  private pendingStartSeat = -1;

  // --- both ---
  private wakeLock: { release(): Promise<void> } | null = null;
  private readonly onVisibility = () => this.handleVisibility();

  // ------------------------------------------------------------------ system

  init(ctx: Ctx) {
    this.ctx = ctx;
    this.race = ctx.race as Race;
    this.items = ctx.items as Items;
    document.addEventListener('visibilitychange', this.onVisibility);

    // Everything the host has to tell its clients about that is not position:
    // an item leaving a kart, a hit landing, a lap falling. These are collected
    // as they happen and ride along with the next snapshot, because a client
    // that only received positions would show shells appearing from nowhere and
    // karts spinning for no reason.
    ctx.bus.on((e) => {
      if (!this.isHost || this.phase !== 'racing') return;
      switch (e.type) {
        case 'item-use': this.pushEvent(NetEvent.ItemUse, e.kart.id, e.kind, 0); break;
        case 'hit':      this.pushEvent(NetEvent.Hit, e.kart.id, e.kind, 0); break;
        case 'lap':      this.pushEvent(NetEvent.Lap, e.kart.id, e.lap, 0); break;
        case 'finish':   this.pushEvent(NetEvent.Finish, e.kart.id, e.place, 0); break;
        case 'boost':    this.pushEvent(NetEvent.Boost, e.kart.id, e.tier, 0); break;
        default: break;
      }
    });
  }

  update(ctx: Ctx, dt: number) {
    if (!this.active) return;

    // A scheduled start. Both ends run this identically, which is what keeps
    // four separate countdowns on four separate devices in step.
    if (this.startIn > 0) {
      this.startIn -= dt;
      if (this.startIn <= 0) this.beginRace();
    }

    if (this.isHost) this.hostUpdate(ctx, dt);
    else this.clientUpdate(ctx, dt);
  }

  dispose() {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.leave();
  }

  // ------------------------------------------------------------- connection

  /**
   * Open a race. `host` runs the simulation; everyone else watches it.
   *
   * The room code is the only thing a player needs to type, so it is also the
   * only thing that can be typed wrong — `cleanRoomCode` folds case and drops
   * punctuation before it is ever compared.
   */
  connect(role: Role, room: string, name: string) {
    this.leave();
    this.role = role;
    this.room = cleanRoomCode(room);
    this.myName = (name || 'Racer').trim().slice(0, 12) || 'Racer';
    this.phase = 'connecting';
    this.error = '';
    this.mySeat = role === 'host' ? 0 : -1;

    const socket = io(relayUrl(), {
      transports: ['websocket', 'polling'],
      // socket.io's own reconnect is the reason it was chosen over bare `ws`:
      // iOS Safari drops the socket the moment the tab backgrounds, and a child
      // glancing at a notification mid-race must come back to the race rather
      // than to a dead screen. See DESIGN.md §5.1.
      reconnection: true,
      reconnectionDelay: 400,
      reconnectionDelayMax: 2000,
      timeout: 8000,
    });
    this.socket = socket;

    socket.on('connect', () => this.sendJoin());
    socket.on('connect_error', (err: Error) => this.fail(`Cannot reach the relay — ${err.message}`));
    socket.on('roster', (r: { host: boolean; players: RosterEntry[] }) => this.onRoster(r));
    socket.on('input', (p: { from: string; d: ArrayBufferLike }) => this.onInput(p));
    socket.on('snapshot', (d: ArrayBufferLike) => this.onSnapshot(d));
    socket.on('lobby', (m: LobbyMessage) => this.onLobby(m));
    socket.on('to-host', (p: { from: string; uid?: string } & ToHostMessage) => this.onToHost(p));
    socket.on('host-gone', () => this.onHostGone());
    socket.on('disconnect', () => { if (this.phase !== 'off') this.changed(); });
  }

  private sendJoin() {
    const socket = this.socket;
    if (!socket) return;
    socket.emit(
      'join',
      { room: this.room, name: this.myName, role: this.role, uid: this.uid, v: PROTOCOL_VERSION },
      (ack: JoinAck) => {
        if (!ack?.ok) { this.fail(ack?.error || 'The relay refused the room'); return; }
        this.phase = this.phase === 'racing' ? 'racing' : 'lobby';
        if (ack.roster) this.onRoster(ack.roster);
        // Rejoining mid-race: ask the host to resend the lobby so we learn our
        // seat again. The host may have held it for us — see REJOIN_GRACE_MS.
        if (!this.isHost) this.toHost({ t: 'resync' });
        this.measurePing();
        this.changed();
      },
    );
  }

  leave() {
    this.socket?.close();
    this.socket = null;
    this.phase = 'off';
    this.players = [];
    this.remotes.clear();
    this.bySocket.clear();
    this.byKart.clear();
    this.reserved.clear();
    this.buffer.length = 0;
    this.lastAppliedSeq = -1;
    this.startIn = 0;
    this.race.netMode = false;
    this.race.netClient = false;
    this.race.netCommandFor = null;
    this.items.netDisplayOnly = false;
    this.releaseWakeLock();
  }

  private fail(msg: string) {
    this.error = msg;
    this.phase = 'error';
    this.changed();
  }

  private changed() { for (const fn of this.listeners) fn(); }

  /**
   * Who the humans in this race are, as kart index -> display name.
   *
   * The HUD uses this to put real names on the in-race board. Empty in a
   * single-player race, which is how the HUD knows to show the old position
   * plate instead — one row reading "1st  DAD" is not a leaderboard.
   */
  racerNames(): Map<number, string> {
    const out = new Map<number, string>();
    if (!this.active) return out;
    for (const p of this.players) {
      // Connected only. A dropped player's seat is HELD for a while (see
      // REJOIN_GRACE_MS) and the lobby shows that as a "…" row so the room can
      // see somebody is missing — but the kart is being driven by the AI in the
      // meantime, so putting it on the in-race board labels a computer with a
      // child's name, or worse with an ellipsis. It comes back when they do.
      if (p.seat >= 0 && p.connected) out.set(p.seat, p.name);
    }
    return out;
  }

  private measurePing() {
    const t0 = performance.now();
    this.socket?.emit('ping-probe', () => {
      this.ping = Math.round(performance.now() - t0);
      this.changed();
    });
  }

  // ------------------------------------------------------------- lobby (host)

  /**
   * Seats are handed out here and nowhere else, and they are keyed on `uid` —
   * a value the browser keeps — rather than on `socket.id`, which is reissued
   * on every reconnect. That is the entire reason a phone that locks itself
   * mid-race comes back into its own kart instead of a new one.
   */
  private onRoster(r: { host: boolean; players: RosterEntry[] }) {
    if (!this.isHost) return;
    const now = performance.now();
    const seen = new Set<string>();

    for (const entry of r.players) {
      const uid = entry.uid || entry.id;
      seen.add(uid);
      let p = this.remotes.get(uid);
      if (!p) {
        const held = this.reserved.get(uid);
        const seat = held ? held.seat : this.freeSeat();
        this.reserved.delete(uid);
        if (seat < 0) continue;                       // race is full; they spectate
        p = {
          uid, socketId: entry.id, name: entry.name, seat,
          ready: false, lastSeq: -1, presses: 0, firedPresses: 0,
          cmd: { ...IDLE_CMD }, lastHeard: now,
        };
        this.remotes.set(uid, p);
        this.byKart.set(seat, p);
      }
      p.socketId = entry.id;
      p.name = entry.name;
      this.bySocket.set(entry.id, uid);
    }

    // Gone. The seat is HELD, not freed — a dropped child gets their kart back
    // if they are quick, and the kart keeps racing under AI in the meantime so
    // the field never goes a racer short mid-lap.
    for (const [uid, p] of [...this.remotes]) {
      if (seen.has(uid)) continue;
      this.remotes.delete(uid);
      this.byKart.delete(p.seat);
      this.reserved.set(uid, { seat: p.seat, until: now + REJOIN_GRACE_MS });
    }
    for (const [uid, res] of [...this.reserved]) {
      if (res.until < now) this.reserved.delete(uid);
    }

    this.publishLobby();
  }

  private freeSeat(): number {
    const n = this.race.karts.length;
    const taken = new Set<number>([this.mySeat]);
    for (const p of this.remotes.values()) taken.add(p.seat);
    for (const r of this.reserved.values()) taken.add(r.seat);
    for (let i = 0; i < n; i++) if (!taken.has(i)) return i;
    return -1;
  }

  private lobbySnapshot(): LobbyPlayer[] {
    const out: LobbyPlayer[] = [{
      uid: this.uid, name: this.myName, seat: this.mySeat,
      ready: true, connected: true, host: true,
    }];
    for (const p of this.remotes.values()) {
      out.push({ uid: p.uid, name: p.name, seat: p.seat, ready: p.ready, connected: true, host: false });
    }
    for (const [uid, r] of this.reserved) {
      out.push({ uid, name: '…', seat: r.seat, ready: false, connected: false, host: false });
    }
    out.sort((a, b) => a.seat - b.seat);
    return out;
  }

  private publishLobby() {
    if (!this.isHost) return;
    this.players = this.lobbySnapshot();
    this.send('lobby', { t: 'lobby', players: this.players, laps: this.race.totalLaps });
    this.changed();
  }

  /** Host: everyone goes racing, `startIn` milliseconds from now. */
  startRace(startIn = 400) {
    if (!this.isHost) return;
    this.players = this.lobbySnapshot();
    this.send('lobby', { t: 'start', startIn, players: this.players });
    this.startIn = startIn / 1000;
  }

  /** Host: everyone back to the lobby. */
  returnToLobby() {
    if (!this.isHost) return;
    this.send('lobby', { t: 'lobby-return' });
    this.phase = 'lobby';
    for (const p of this.remotes.values()) p.ready = false;
    this.publishLobby();
  }

  /** Client: tell the host whether this player has tapped Ready. */
  setReady(ready: boolean) {
    if (this.isHost) return;
    this.toHost({ t: 'ready', ready });
  }

  private onLobby(m: LobbyMessage) {
    if (this.isHost) return;
    if (m.t === 'lobby') {
      this.players = m.players;
      this.adoptSeat();
      this.changed();
      return;
    }
    if (m.t === 'start') {
      this.players = m.players;
      this.adoptSeat();
      this.startIn = m.startIn / 1000;
      this.changed();
      return;
    }
    if (m.t === 'lobby-return') {
      this.phase = 'lobby';
      this.buffer.length = 0;
      this.changed();
    }
  }

  private adoptSeat() {
    // `&& !p.host` is load-bearing. When the host and a client are the same
    // browser — which is every development session, and any household where a
    // parent opens a second tab to make up the numbers — both entries can carry
    // the same identity, and the host's is first in the list. Matching on uid
    // alone therefore handed the client the HOST's seat, and two machines drove
    // the same kart.
    const me = this.players.find((p) => p.uid === this.uid && !p.host);
    if (!me || me.seat === this.mySeat) return;
    this.mySeat = me.seat;
    // Applied at the start rather than now: `selectKart` moves which kart is
    // `isPlayer`, and doing that mid-race would hand the camera to a different
    // machine in the middle of a corner.
    this.pendingStartSeat = me.seat;
    if (this.phase !== 'racing') this.race.selectKart(me.seat);
  }

  private onToHost(p: { from: string; uid?: string } & ToHostMessage) {
    if (!this.isHost) return;
    const uid = p.uid || this.bySocket.get(p.from);
    const rp = uid ? this.remotes.get(uid) : undefined;
    if (!rp) return;
    if (p.t === 'ready') { rp.ready = p.ready; this.publishLobby(); }
    else if (p.t === 'name') { rp.name = String(p.name).slice(0, 12); this.publishLobby(); }
    else if (p.t === 'resync') {
      this.publishLobby();
      // Mid-race rejoin: they need to know the race is already running, and
      // with what delay, or they would sit in the lobby until the next race.
      if (this.phase === 'racing') this.send('lobby', { t: 'start', startIn: 0, players: this.players });
    }
  }

  private onHostGone() {
    if (this.isHost) return;
    this.fail('The host left the race.');
  }

  // -------------------------------------------------------------------- race

  private beginRace() {
    this.startIn = 0;
    this.phase = 'racing';
    this.race.netMode = true;
    this.race.netClient = !this.isHost;

    if (this.isHost) {
      this.race.netCommandFor = (kartId) => {
        const p = this.byKart.get(kartId);
        if (!p) return null;
        // Consume the presses we have not fired yet. `presses` is a running
        // total precisely so this subtraction cannot lose one to a dropped
        // packet — see `NetInput.itemPresses`.
        const owed = Math.max(0, Math.min(3, p.presses - p.firedPresses));
        p.firedPresses = p.presses;
        p.cmd.itemUses = owed;
        return p.cmd;
      };
      this.race.selectKart(this.mySeat);
    } else {
      this.items.netDisplayOnly = true;
      if (this.pendingStartSeat >= 0) {
        this.race.selectKart(this.pendingStartSeat);
        this.pendingStartSeat = -1;
      }
    }

    this.race.start();
    this.acquireWakeLock();
    this.changed();
  }

  // -------------------------------------------------------------------- host

  private hostUpdate(_ctx: Ctx, dt: number) {
    if (this.phase !== 'racing') return;
    const now = performance.now();

    // A seat whose player has gone quiet reverts to a coasting kart rather than
    // one stuck at whatever the last packet said — a phone that dies with the
    // throttle down would otherwise drive into the scenery at full speed for
    // the rest of the race.
    for (const p of this.remotes.values()) {
      if (now - p.lastHeard > 1500) { p.cmd.accel = 0; p.cmd.brake = 0; p.cmd.drift = false; }
    }

    this.snapAccum += dt;
    const interval = 1 / SNAPSHOT_HZ;
    if (this.snapAccum < interval) return;
    this.snapAccum = 0;
    this.broadcastSnapshot();
  }

  private onInput(p: { from: string; d: ArrayBufferLike }) {
    if (!this.isHost) return;
    const uid = this.bySocket.get(p.from);
    const rp = uid ? this.remotes.get(uid) : undefined;
    if (!rp) return;
    const i = decodeInput(p.d);
    if (!i) return;
    // Out-of-order arrival is normal on any transport. An older packet is not
    // wrong, it is just stale, and applying it would rewind the steering.
    if (i.seq <= rp.lastSeq) return;
    rp.lastSeq = i.seq;
    rp.lastHeard = performance.now();
    rp.presses = i.itemPresses;
    rp.cmd.steer = i.steer;
    rp.cmd.accel = i.accel;
    rp.cmd.accelAuto = i.accelAuto;
    rp.cmd.brake = i.brake;
    rp.cmd.drift = i.drift;
    rp.cmd.back = i.back;
  }

  private pushEvent(type: number, a: number, b: number, c: number) {
    // A snapshot with a hundred events in it is a snapshot nobody can parse in
    // time. In practice a 40 ms window holds two or three.
    if (this.pendingEvents.length < 24) this.pendingEvents.push({ type, a, b, c });
  }

  private broadcastSnapshot() {
    const race = this.race;
    const karts: NetKart[] = [];
    for (const k of race.karts) {
      const held = this.items.held(k);
      let flags = 0;
      if (k.finished) flags |= KartFlag.Finished;
      if (k.airborne) flags |= KartFlag.Airborne;
      if (k.driftDir < 0) flags |= KartFlag.DriftLeft;
      if (k.driftDir > 0) flags |= KartFlag.DriftRight;
      if (k.isPlayer || this.byKart.has(k.id)) flags |= KartFlag.IsHuman;
      karts.push({
        id: k.id,
        x: k.position.x, y: k.position.y, z: k.position.z,
        yaw: Math.atan2(k.forward.x, k.forward.z),
        upx: k.up.x, upz: k.up.z,
        vx: k.velocity.x, vy: k.velocity.y, vz: k.velocity.z,
        forwardSpeed: k.forwardSpeed,
        steerAngle: 0,
        t: k.t,
        lap: k.lap,
        place: k.place,
        raceDistance: k.raceDistance,
        flags,
        driftTier: k.driftTier,
        driftCharge: k.driftCharge,
        stunTime: k.stunTime,
        boostTime: k.boostTime,
        starTime: k.starTime,
        itemKind: held.kind,
        itemCount: held.count,
        surface: k.surface,
        tyreSlip: Math.min(0.999, k.tyreSlip),
      });
    }
    const snap: Snapshot = {
      seq: ++this.snapSeq,
      raceTime: race.raceTime,
      state: race.state,
      countdown: race.countdown,
      karts,
      events: this.pendingEvents,
    };
    this.socket?.emit('snapshot', encodeSnapshot(snap));
    this.stats.snapshotsOut++;
    this.pendingEvents = [];
  }

  // ------------------------------------------------------------------ client

  private onSnapshot(d: ArrayBufferLike) {
    if (this.isHost) return;
    const snap = decodeSnapshot(d);
    if (!snap) return;
    // A snapshot older than one we already hold is not useful: it would drag
    // the interpolation backwards for one frame and then be overtaken again.
    const newest = this.buffer.length ? this.buffer[this.buffer.length - 1].snap.seq : -1;
    if (snap.seq <= newest) return;
    this.buffer.push({ at: performance.now(), snap });
    this.stats.snapshotsIn++;
    // Two interpolation windows of history is all anything reads.
    while (this.buffer.length > 3 && this.buffer[0].at < performance.now() - INTERP_DELAY_MS * 3) {
      this.buffer.shift();
    }
    if (this.phase === 'lobby' && snap.state !== RaceState.Menu) {
      // Snapshots are flowing but we never saw the `start` — joined late, or
      // the lobby message was lost. Catch up rather than sit in the lobby.
      this.beginRace();
    }
  }

  private clientUpdate(ctx: Ctx, dt: number) {
    this.sendInput(ctx, dt);
    if (this.phase !== 'racing' || this.buffer.length === 0) return;

    const latest = this.buffer[this.buffer.length - 1].snap;

    // --- authoritative bookkeeping, straight off the newest packet -----------
    this.race.raceTime = latest.raceTime;
    this.race.netSetState(latest.state as RaceState);
    for (const nk of latest.karts) {
      const k = this.race.karts[nk.id];
      if (!k) continue;
      k.lap = nk.lap;
      k.place = nk.place;
      k.finished = (nk.flags & KartFlag.Finished) !== 0;
      k.raceDistance = nk.raceDistance;
      k.stunTime = nk.stunTime;
      k.boostTime = nk.boostTime;
      k.starTime = nk.starTime;
      k.driftTier = nk.driftTier;
      k.driftCharge = nk.driftCharge;
      // Your own item is the one exception: you fired it a moment ago and the
      // host has not caught up. See `localFireAt`.
      const mine = k.isPlayer && performance.now() - this.localFireAt < 300;
      if (!mine) this.items.netHold(k, nk.itemKind as ItemKind, nk.itemCount);
    }

    // --- one-off events (shells thrown, laps, hits) --------------------------
    if (latest.seq > this.lastAppliedSeq) {
      this.lastAppliedSeq = latest.seq;
      this.stats.eventsIn += latest.events.length;
      for (const e of latest.events) this.replayEvent(e);
    }

    // --- poses ---------------------------------------------------------------
    // Everyone else is drawn INTERP_DELAY_MS in the past, between the two
    // snapshots that bracket that moment, so a late packet slides instead of
    // teleporting. Your own kart is not: it is simulated here and only nudged.
    const renderAt = performance.now() - INTERP_DELAY_MS;
    for (const k of this.race.karts) {
      if (k.isPlayer) {
        const nk = findKart(latest, k.id);
        if (nk) k.netCorrect(nk, SELF_BLEND);
        continue;
      }
      const pose = this.interpolate(k.id, renderAt);
      if (pose) {
        k.netPose(pose, dt);
        k.t = pose.t;
      }
    }
  }

  /**
   * Where kart `id` was at `at` (a `performance.now()` reading in the recent
   * past), from the two snapshots that bracket it.
   *
   * Falls back to the newest state we hold if the buffer has run dry — which
   * on a LAN means the host has stopped sending, and holding still is a better
   * answer than extrapolating a kart off into the scenery.
   */
  private interpolate(id: number, at: number): (NetKart & { t: number }) | null {
    const buf = this.buffer;
    if (buf.length === 0) return null;
    if (buf.length === 1 || at >= buf[buf.length - 1].at) return findKart(buf[buf.length - 1].snap, id);

    let i = buf.length - 1;
    while (i > 0 && buf[i - 1].at > at) i--;
    // Every snapshot we hold is NEWER than the moment we want to draw — the
    // buffer was just cleared (a tab coming back from the background does
    // exactly this) or we have only just joined. There is nothing to
    // interpolate between, so show the oldest thing we have rather than
    // indexing off the front of the array, which is what this used to do:
    // `buf[-1].at` threw once per frame, killing the whole client render loop
    // for as long as the condition lasted.
    if (i === 0) return findKart(buf[0].snap, id);
    const b = buf[i];
    const a = buf[i - 1];
    const span = b.at - a.at;
    const u = span > 1e-3 ? clamp01((at - a.at) / span) : 1;
    const ka = findKart(a.snap, id);
    const kb = findKart(b.snap, id);
    if (!ka || !kb) return kb || ka;

    return {
      ...kb,
      x: lerp(ka.x, kb.x, u),
      y: lerp(ka.y, kb.y, u),
      z: lerp(ka.z, kb.z, u),
      // Shortest way round the circle. Blending 179 deg to -179 deg the long
      // way spins the kart through a full revolution to cover two degrees.
      yaw: lerpAngle(ka.yaw, kb.yaw, u),
      upx: lerp(ka.upx, kb.upx, u),
      upz: lerp(ka.upz, kb.upz, u),
      vx: lerp(ka.vx, kb.vx, u),
      vy: lerp(ka.vy, kb.vy, u),
      vz: lerp(ka.vz, kb.vz, u),
      forwardSpeed: lerp(ka.forwardSpeed, kb.forwardSpeed, u),
      t: lerpWrapped(ka.t, kb.t, u),
    };
  }

  private replayEvent(e: { type: number; a: number; b: number; c: number }) {
    const kart = this.race.karts[e.a | 0] as Kart | undefined;
    if (!kart) return;
    const bus = this.ctx.bus;
    switch (e.type) {
      case NetEvent.ItemUse:
        // Your own throw already happened locally, optimistically, the moment
        // you pressed the button. Replaying the host's copy of it would fire a
        // second shell off the same kart.
        if (!kart.isPlayer) { this.items.netUse(kart, e.b as ItemKind, false); this.stats.itemsReplayed++; }
        break;
      case NetEvent.Hit:
        bus.emit({ type: 'hit', kart, kind: e.b as ItemKind });
        break;
      case NetEvent.Lap:
        bus.emit({ type: 'lap', kart, lap: e.b | 0 });
        break;
      case NetEvent.Finish:
        bus.emit({ type: 'finish', kart, place: e.b | 0 });
        break;
      case NetEvent.Boost:
        bus.emit({ type: 'boost', kart, tier: e.b | 0 });
        break;
      default: break;
    }
  }

  private sendInput(ctx: Ctx, dt: number) {
    const s = ctx.input.state;
    // Count the edge every frame, send the total on the wire's schedule: a
    // press that happens between two sends must not be lost, and at 60 Hz input
    // against a 60 Hz frame it otherwise would be, about half the time.
    if (s.itemPressed && !this.itemEdge) {
      this.presses++;
      this.localFireAt = performance.now();
    }
    this.itemEdge = s.itemPressed;

    if (this.phase !== 'racing') return;
    this.inputAccum += dt;
    if (this.inputAccum < 1 / INPUT_HZ) return;
    this.inputAccum = 0;

    const packet: NetInput = {
      seq: ++this.inputSeq,
      steer: s.steer,
      accel: s.accel,
      accelAuto: s.accelAuto,
      brake: s.brake,
      drift: s.drift,
      itemPresses: this.presses,
      back: s.brake > 0.5 || s.lookBack,
    };
    this.socket?.emit('input', { d: encodeInput(packet, this.inputBuf) });
  }

  // ------------------------------------------------------------------- plumbing

  private send(channel: 'lobby', payload: LobbyMessage) {
    this.socket?.emit(channel, payload);
  }

  private toHost(m: ToHostMessage) {
    this.socket?.emit('to-host', { uid: this.uid, ...m });
  }

  // ------------------------------------------------- screen sleep / background

  /**
   * Stop the phone locking itself mid-race.
   *
   * Two things worth knowing, both of which have bitten other people:
   * locks are released automatically when the tab backgrounds, so this has to
   * be re-acquired on the way back rather than acquired once; and the API only
   * exists in a SECURE context, which a plain `http://192.168.x.x` LAN address
   * is not. That is the real argument for putting the relay somewhere with a
   * certificate — over plain http the request below simply refuses, quietly.
   */
  private async acquireWakeLock() {
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<any> } };
    if (!nav.wakeLock) return;
    try {
      this.wakeLock = await nav.wakeLock.request('screen');
    } catch {
      this.wakeLock = null;      // denied, or not a secure context — not fatal
    }
  }

  private releaseWakeLock() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  private handleVisibility() {
    if (!this.active) return;
    if (document.hidden) {
      this.releaseWakeLock();
      return;
    }
    // Back from the background. Anything we buffered while away describes a
    // race that has moved on — throw it out and interpolate from what arrives
    // next, rather than replaying a stale second of the race at speed.
    this.buffer.length = 0;
    if (this.phase === 'racing') this.acquireWakeLock();
    if (!this.isHost) this.toHost({ t: 'resync' });
  }
}

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------

function findKart(s: Snapshot, id: number): (NetKart & { t: number }) | null {
  for (const k of s.karts) if (k.id === id) return k;
  return null;
}

function lerp(a: number, b: number, u: number) { return a + (b - a) * u; }
function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function lerpAngle(a: number, b: number, u: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * u;
}

/** Track progress is normalised 0..1 and wraps at the start line. */
function lerpWrapped(a: number, b: number, u: number) {
  let d = b - a;
  if (d > 0.5) d -= 1;
  else if (d < -0.5) d += 1;
  const v = a + d * u;
  return ((v % 1) + 1) % 1;
}

/**
 * The identity that owns a seat.
 *
 * `sessionStorage`, deliberately, and it is the only storage decision here that
 * is not obvious. It has to survive a RELOAD and a reconnect, because that is
 * what lets a phone which locked itself mid-race come back into its own kart
 * rather than a new one — and sessionStorage does survive both; it is cleared
 * when the tab closes, not when the page navigates.
 *
 * What it must NOT do is survive across tabs, which `localStorage` would. Two
 * tabs sharing one identity means two racers the host cannot tell apart: they
 * are dealt one seat between them and the second to join silently steals the
 * first one's kart. That is not a hypothetical — a host and a client opened
 * side by side on one machine is every test run, and it is also the parent who
 * opens a second tab to make up the numbers.
 */
function stableUid(): string {
  const KEY = 'kr.uid';
  try {
    const found = sessionStorage.getItem(KEY);
    if (found) return found;
    const made = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    sessionStorage.setItem(KEY, made);
    return made;
  } catch {
    // Private mode, or storage disabled. A per-load identity still works for
    // everything except surviving a reload.
    return Math.random().toString(36).slice(2, 12);
  }
}

/**
 * Where the relay lives.
 *
 * In production the relay serves the game itself, so it is simply this origin
 * — which is what makes the join QR code a single URL. During development the
 * game runs on vite's :5173 and the relay on :8080, so we point at the same
 * host on the relay's port. `?relay=` overrides both.
 */
function relayUrl(): string {
  const forced = new URLSearchParams(location.search).get('relay');
  if (forced) return forced;
  if (location.port === '5173' || location.port === '4173') {
    return `${location.protocol}//${location.hostname}:8080`;
  }
  return location.origin;
}
