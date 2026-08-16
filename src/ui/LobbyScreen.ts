/**
 * ============================================================================
 *  THE LOBBY — how four children get into the same race
 * ============================================================================
 *  This screen is the whole multiplayer feature as far as anybody in the room
 *  is concerned. The netcode can be perfect and it is still worthless if
 *  getting in takes an adult.
 *
 *  So it copies Jackbox, which solved this: ONE screen shows a short room code
 *  and a QR that deep-links to the host's own LAN address with the code
 *  already in it. A phone points its camera at the television, taps the
 *  notification, types a name, and is in. There is no account, no discovery, no
 *  pairing.
 *
 *  Three deliberate choices:
 *
 *  1. **The code is on screen at all times while the lobby is up**, in the
 *     largest type in the game, because it will be read across a room by
 *     someone standing up. `makeRoomCode`'s alphabet has no vowels and no
 *     0/O/1/I/5/S for the same reason.
 *  2. **No mDNS, no auto-discovery.** It is flaky across phone OSes in exactly
 *     the mixed-device household this is for. A QR code pointing at a raw IP
 *     always works.
 *  3. **The host can start with empty seats.** Waiting for everyone to tap
 *     Ready is how a race never begins; the AI fills whatever is left, and a
 *     late arrival takes the next seat in the following race.
 *
 *  A sibling overlay, not one of `Menus`' four screens — same relationship
 *  `ControlsMenu` has, and for the same reason: it has to be able to sit over
 *  the title screen and own every tap while it is up.
 * ============================================================================
 */
import qrcode from 'qrcode-generator';
import type { Ctx } from '../types';
import type { Net } from '../net/Net';
import { cleanRoomCode, makeRoomCode } from '../net/Protocol';
import { el, cssColor } from './uiUtil';
import './lobby.css';

type Pane = 'choose' | 'join' | 'room' | 'error';

const NAME_KEY = 'kr.name';

export class LobbyScreen {
  /** True while this screen owns the frame — `Menus` stands down when it is. */
  open = false;

  private root: HTMLDivElement;
  private panes: Record<Pane, HTMLDivElement>;
  private pane: Pane = 'choose';
  private ctx!: Ctx;

  private nameInput!: HTMLInputElement;
  private codeInput!: HTMLInputElement;
  private codeBig!: HTMLDivElement;
  private qrBox!: HTMLDivElement;
  private urlLine!: HTMLDivElement;
  private warnLine!: HTMLDivElement;
  private listEl!: HTMLDivElement;
  private startBtn!: HTMLDivElement;
  private readyBtn!: HTMLDivElement;
  private statusLine!: HTMLDivElement;
  private errorLine!: HTMLDivElement;
  private pingLine!: HTMLDivElement;

  /** The code the QR currently encodes — regenerating it every frame is waste. */
  private qrFor = '';
  private ready = false;

  constructor(parent: HTMLElement, private readonly net: Net) {
    this.root = el('div', 'kr-lobby', parent);
    this.panes = {
      choose: this.buildChoose(),
      join: this.buildJoin(),
      room: this.buildRoom(),
      error: this.buildError(),
    };
    net.onChange = () => this.sync();
  }

  init(ctx: Ctx) {
    this.ctx = ctx;
    // A phone that arrived by QR has the room code in its URL. Skip the menu it
    // does not need and put the cursor where the only remaining decision is.
    const wanted = cleanRoomCode(new URLSearchParams(location.search).get('room') || '');
    if (wanted) {
      this.show();
      this.codeInput.value = wanted;
      this.setPane('join');
    }
  }

  // -------------------------------------------------------------------- show

  show() {
    this.open = true;
    this.root.classList.add('on');
    // Same signal the four `Menus` screens raise: it is what tells the touch
    // layer to take the steering controls off a screen you cannot drive from.
    document.documentElement.dataset.menu = 'lobby';
    this.nameInput.value = savedName();
    this.setPane(this.net.active ? 'room' : 'choose');
    this.sync();
  }

  hide() {
    this.open = false;
    this.root.classList.remove('on');
    delete document.documentElement.dataset.menu;
  }

  private setPane(p: Pane) {
    this.pane = p;
    for (const k of Object.keys(this.panes) as Pane[]) {
      this.panes[k].classList.toggle('on', k === p);
    }
    this.sync();
  }

  // ------------------------------------------------------------------ frame

  /**
   * Called by `Net` whenever anything on this screen has changed.
   *
   * There is deliberately no per-frame `update`. Every reason this screen has
   * to redraw is an event — somebody joined, somebody tapped Ready, the host
   * pressed Start — and a lobby that rebuilt eight rows sixty times a second to
   * show the same eight rows would be the most expensive thing on the menu.
   */
  private sync() {
    const net = this.net;

    if (net.phase === 'error') {
      this.errorLine.textContent = net.error;
      if (this.pane !== 'error') this.setPane('error');
      return;
    }
    if (net.phase === 'racing') { this.hide(); return; }
    if (this.pane !== 'room') return;

    // --- the code, and the way in -------------------------------------------
    this.codeBig.textContent = net.room;
    const url = joinUrl(net.room);
    this.urlLine.textContent = url.replace(/^https?:\/\//, '');
    if (net.isHost && this.qrFor !== url) {
      this.qrFor = url;
      this.drawQr(url);
    }
    this.qrBox.style.display = net.isHost ? '' : 'none';
    this.urlLine.style.display = net.isHost ? '' : 'none';
    this.warnLine.textContent = net.isHost && isLoopback()
      ? 'Open this page by your computer’s network address, not localhost, or phones cannot reach it.'
      : '';
    this.pingLine.textContent = net.ping >= 0 ? `${net.ping} ms to the relay` : '';

    // --- who is in -----------------------------------------------------------
    this.listEl.textContent = '';
    const karts = this.ctx?.race.karts ?? [];
    for (const p of net.players) {
      const row = el('div', 'kr-lobby-row' + (p.connected ? '' : ' gone'), this.listEl);
      const kart = karts[p.seat];
      if (kart) row.style.setProperty('--c', cssColor(kart.stats.color));
      el('span', 'kr-lobby-dot', row);
      el('span', 'kr-lobby-name', row, p.name);
      el('span', 'kr-lobby-kart', row, kart ? kart.stats.name : `Seat ${p.seat + 1}`);
      const tag = p.host ? 'HOST' : !p.connected ? 'DROPPED' : p.ready ? 'READY' : '';
      el('span', 'kr-lobby-tag', row, tag);
    }
    const empty = Math.max(0, karts.length - net.players.length);
    this.statusLine.textContent = net.isHost
      ? empty > 0
        ? `${net.players.length} racing, ${empty} filled by the computer.`
        : 'Full grid.'
      : this.ready ? 'Ready — waiting for the host to start.' : 'Tap Ready when you are.';

    this.startBtn.style.display = net.isHost ? '' : 'none';
    this.readyBtn.style.display = net.isHost ? 'none' : '';
    this.readyBtn.classList.toggle('sel', this.ready);
    this.readyBtn.textContent = this.ready ? 'Ready' : 'Tap when ready';
  }

  // ------------------------------------------------------------------ panes

  private buildChoose(): HTMLDivElement {
    const p = this.pane_('kr-lobby-choose');
    el('div', 'kr-lobby-title', p, 'Race your friends');
    el('div', 'kr-lobby-blurb', p,
      'Everyone on the same wifi. One screen runs the race, the others join it.');

    const field = el('label', 'kr-lobby-field', p);
    el('span', undefined, field, 'Your name');
    this.nameInput = el('input', 'kr-lobby-input', field);
    this.nameInput.maxLength = 12;
    this.nameInput.value = savedName();
    this.nameInput.autocomplete = 'off';

    const row = el('div', 'kr-lobby-actions', p);
    const host = el('div', 'kr-btn sel', row, 'Start a room');
    host.onclick = () => {
      rememberName(this.nameInput.value);
      this.net.connect('host', makeRoomCode(), this.nameInput.value);
      this.setPane('room');
    };
    const join = el('div', 'kr-btn', row, 'Join a room');
    join.onclick = () => { rememberName(this.nameInput.value); this.setPane('join'); };

    const back = el('div', 'kr-btn kr-lobby-quiet', p, 'Back');
    back.onclick = () => this.hide();
    return p;
  }

  private buildJoin(): HTMLDivElement {
    const p = this.pane_('kr-lobby-join');
    el('div', 'kr-lobby-title', p, 'Join a room');
    el('div', 'kr-lobby-blurb', p, 'Type the code on the host’s screen.');

    const field = el('label', 'kr-lobby-field', p);
    el('span', undefined, field, 'Room code');
    this.codeInput = el('input', 'kr-lobby-input kr-lobby-code-in', field);
    this.codeInput.maxLength = 8;
    this.codeInput.autocapitalize = 'characters';
    this.codeInput.autocomplete = 'off';
    this.codeInput.spellcheck = false;
    // Fold as they type rather than on submit: a child watching the letters
    // appear in the wrong case assumes it is wrong and starts again.
    this.codeInput.oninput = () => {
      this.codeInput.value = cleanRoomCode(this.codeInput.value);
    };
    this.codeInput.onkeydown = (e) => { if (e.key === 'Enter') this.doJoin(); };

    const row = el('div', 'kr-lobby-actions', p);
    const go = el('div', 'kr-btn sel', row, 'Join');
    go.onclick = () => this.doJoin();
    const back = el('div', 'kr-btn kr-lobby-quiet', row, 'Back');
    back.onclick = () => this.setPane('choose');
    return p;
  }

  private doJoin() {
    const code = cleanRoomCode(this.codeInput.value);
    if (code.length < 3) { this.codeInput.focus(); return; }
    rememberName(this.nameInput.value);
    this.ready = false;
    this.net.connect('player', code, this.nameInput.value);
    this.setPane('room');
  }

  private buildRoom(): HTMLDivElement {
    const p = this.pane_('kr-lobby-room');
    const head = el('div', 'kr-lobby-head', p);
    const codeWrap = el('div', 'kr-lobby-codewrap', head);
    el('div', 'kr-lobby-codelabel', codeWrap, 'Room code');
    this.codeBig = el('div', 'kr-lobby-code', codeWrap);
    const qrWrap = el('div', 'kr-lobby-qrwrap', head);
    this.qrBox = el('div', 'kr-lobby-qr', qrWrap);
    this.urlLine = el('div', 'kr-lobby-url', qrWrap);

    this.warnLine = el('div', 'kr-lobby-warn', p);
    this.listEl = el('div', 'kr-lobby-list', p);
    this.statusLine = el('div', 'kr-lobby-status', p);
    this.pingLine = el('div', 'kr-lobby-ping', p);

    const row = el('div', 'kr-lobby-actions', p);
    this.startBtn = el('div', 'kr-btn sel', row, 'Start race');
    this.startBtn.onclick = () => this.net.startRace();
    this.readyBtn = el('div', 'kr-btn', row, 'Tap when ready');
    this.readyBtn.onclick = () => {
      this.ready = !this.ready;
      this.net.setReady(this.ready);
      this.sync();
    };
    const leave = el('div', 'kr-btn kr-lobby-quiet', row, 'Leave');
    leave.onclick = () => { this.net.leave(); this.hide(); };
    return p;
  }

  private buildError(): HTMLDivElement {
    const p = this.pane_('kr-lobby-error');
    el('div', 'kr-lobby-title', p, 'Race stopped');
    this.errorLine = el('div', 'kr-lobby-blurb', p);
    const back = el('div', 'kr-btn sel', p, 'Back');
    back.onclick = () => { this.net.leave(); this.setPane('choose'); };
    return p;
  }

  private pane_(cls: string): HTMLDivElement {
    return el('div', `kr-lobby-pane ${cls}`, this.root);
  }

  // --------------------------------------------------------------------- QR

  /**
   * Draw the join link as a QR code, in DOM.
   *
   * Divs rather than a canvas or an image: the modules are big black squares on
   * a white field, a phone camera reads them at any pixel ratio without the
   * canvas smoothing that a scaled bitmap gets, and there is nothing to
   * dispose. About 900 elements for a version-3 code, built once per room.
   */
  private drawQr(url: string) {
    const qr = qrcode(0, 'M');       // auto size; M survives a screen photo
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    this.qrBox.textContent = '';
    this.qrBox.style.setProperty('--n', String(n));
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) el('i', undefined, this.qrBox).style.gridArea = `${r + 1}/${c + 1}`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------

/**
 * The address a phone should open.
 *
 * `location.origin` is exactly right when the relay is serving the game, which
 * is how it is meant to be run — that is the whole reason the relay has a
 * static file server bolted to it. During development the game is on vite's
 * :5173 and phones can reach that too, so the origin still works.
 */
function joinUrl(room: string): string {
  return `${location.origin}${location.pathname}?room=${room}`;
}

/** A URL only this machine can open — the one way to hand out a dead QR code. */
function isLoopback(): boolean {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '';
}

function savedName(): string {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

function rememberName(v: string) {
  try { localStorage.setItem(NAME_KEY, (v || 'Racer').trim().slice(0, 12)); } catch { /* private mode */ }
}
