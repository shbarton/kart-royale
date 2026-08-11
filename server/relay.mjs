/**
 * ============================================================================
 *  Kart Royale — LAN multiplayer relay
 * ============================================================================
 *  A DUMB byte-mover. It knows nothing about karts, physics, items or laps.
 *  Its whole job is: keep rooms, and forward two kinds of message.
 *
 *      player  --input-->    relay  --input-->    host
 *      host    --snapshot--> relay  --snapshot--> every player in the room
 *
 *  This is deliberate. The authoritative simulation runs inside ONE client (a
 *  laptop/TV browser tab, or one phone) — see docs/multiplayer/DESIGN.md §3.
 *  Keeping the relay ignorant means we never port the ~60k-line physics engine
 *  to run headless here; the game stays where it already runs.
 *
 *  It also (optionally) serves the built game from ../dist so the whole thing
 *  lives on one LAN URL — the URL the join QR code points at.
 *
 *  Run:   node server/relay.mjs           (PORT env overrides, default 8080)
 *  Check: node server/test-pipe.mjs       (proves input+snapshot round-trip)
 * ============================================================================
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const DIST = path.resolve(__dirname, '..', 'dist');

// --- static file serving (only if a production build exists) ----------------
// Minimal on purpose: no framework, no dependency. Serves ../dist for the LAN
// URL. If there's no build yet, /healthz still answers so you can test the pipe.
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  if (!fs.existsSync(DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('Kart Royale relay is up. No ../dist build yet — run `npm run build`.\n');
  }
  // strip query, prevent path traversal, default to index.html (SPA)
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(DIST, urlPath);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end('forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// --- room registry ----------------------------------------------------------
// One room per race. `hostId` is the socket running the authoritative sim.
// `players` maps socket.id -> { name, seat }. Seat assignment is the host's job
// later; for now we just track who is present.
/** @type {Map<string, { hostId: string|null, players: Map<string, {name:string, seat:number|null}> }>} */
const rooms = new Map();

function roster(code) {
  const r = rooms.get(code);
  if (!r) return { host: false, players: [] };
  return {
    host: !!r.hostId,
    players: [...r.players.entries()].map(([id, p]) => ({ id, name: p.name, seat: p.seat })),
  };
}

function emitRoster(io, code) {
  io.to(code).emit('roster', roster(code));
}

// --- server -----------------------------------------------------------------
const httpServer = http.createServer(serveStatic);
const io = new Server(httpServer, {
  // Same-origin on the LAN in production, but allow any origin so a dev client
  // on a different port (vite :5173) can connect while we build.
  cors: { origin: true },
});

io.on('connection', (socket) => {
  // Each socket belongs to exactly one room, remembered on socket.data.
  socket.on('join', ({ room, name, role } = {}, ack) => {
    if (!room || typeof room !== 'string') { ack?.({ ok: false, error: 'no room' }); return; }
    room = room.toUpperCase().slice(0, 8);
    let r = rooms.get(room);
    if (!r) { r = { hostId: null, players: new Map() }; rooms.set(room, r); }

    socket.join(room);
    socket.data.room = room;
    socket.data.role = role === 'host' ? 'host' : 'player';

    if (socket.data.role === 'host') {
      r.hostId = socket.id;
    } else {
      r.players.set(socket.id, { name: String(name || 'RACER').slice(0, 16), seat: null });
    }

    ack?.({ ok: true, youAre: socket.data.role, room, roster: roster(room) });
    emitRoster(io, room);
    // Tell the host explicitly when it (re)appears or a player joins.
    if (r.hostId) io.to(r.hostId).emit('roster', roster(room));
  });

  // player -> host : one input frame. Tiny; forwarded verbatim plus who sent it.
  socket.on('input', (payload) => {
    const code = socket.data.room;
    const r = code && rooms.get(code);
    if (!r || !r.hostId) return;                    // no host to receive it yet
    io.to(r.hostId).emit('input', { from: socket.id, ...payload });
  });

  // host -> everyone-else : a world snapshot. Only the host may broadcast these.
  socket.on('snapshot', (payload) => {
    const code = socket.data.room;
    const r = code && rooms.get(code);
    if (!r || r.hostId !== socket.id) return;       // ignore snapshots from non-hosts
    socket.to(code).emit('snapshot', payload);      // to everyone in room except sender
  });

  // Lobby control (ready-up, countdown start) is host-authored; just relay it.
  socket.on('lobby', (payload) => {
    const code = socket.data.room;
    const r = code && rooms.get(code);
    if (!r || r.hostId !== socket.id) return;
    socket.to(code).emit('lobby', payload);
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    const r = code && rooms.get(code);
    if (!r) return;
    if (socket.data.role === 'host' && r.hostId === socket.id) {
      r.hostId = null;
      io.to(code).emit('host-gone');                // clients pause / show "host left"
    } else {
      r.players.delete(socket.id);
    }
    if (!r.hostId && r.players.size === 0) rooms.delete(code);
    else emitRoster(io, code);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[relay] listening on http://0.0.0.0:${PORT}  (serving ${fs.existsSync(DIST) ? DIST : 'no dist yet'})`);
});

export { io, httpServer, rooms };
