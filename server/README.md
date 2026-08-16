# Kart Royale — multiplayer relay

A dumb byte-mover with rooms. It forwards player **inputs** up to the authoritative host and
**snapshots** back down to the players, and serves the built game from `../dist` so everything
lives on one URL — the URL the join QR code points at. It knows nothing about karts, physics
or laps: that all stays in the game, running on one client (the host).

Full design: [`../docs/multiplayer/DESIGN.md`](../docs/multiplayer/DESIGN.md).

## Run a race at home

```bash
npm run build          # in the repo root — the relay serves ../dist
cd server && npm install && npm start
```

Then, **on the machine that will run the race** (a laptop or a TV browser — see "who hosts"
below), open the relay's address and press **Multiplayer → Start a room**.

> **Open it by the machine's own network address, not `localhost`.**
> `http://192.168.1.23:8080`, not `http://localhost:8080`. The join QR code is built from the
> address in your own address bar, so a QR generated on `localhost` points every phone at
> itself. The lobby screen says so in orange if you get this wrong.
>
> Find the address with `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).

Everyone else scans the QR, or opens the same address and types the four-letter room code.

## Who hosts

One machine runs the actual simulation and everyone else watches it. That machine should be
the **biggest, most stationary screen in the house** — a laptop or a TV browser. It never
wanders off mid-race, it has no latency advantage over the players, and it can show the lobby
and the QR while the race runs. A phone *can* host; it is just the worst candidate for the
job.

## The wake-lock problem, and the case for putting this on a VPS

Phones sleep. The Screen Wake Lock API stops them, and the game asks for it at the start of
every race — but it **only exists in a secure context**, and a plain `http://192.168.x.x` LAN
address is not one. Over LAN http the request is refused, quietly, and phones will dim
mid-race.

Two ways out, in order of how well they work:

1. **Put the relay behind HTTPS on a box that already has a certificate** (Sam's droplet has
   Caddy in front of it). The relay is only a byte-mover, so hosting it off-LAN costs one
   extra hop each way — on a home connection to a nearby VPS that is tens of milliseconds,
   which this game does not notice. You get wake lock, no certificate warnings, and a URL
   that does not change every time the router hands out new addresses. **The authoritative
   host is still the laptop in the house** — that does not move.
2. **Stay on the LAN and accept it.** Everything else works; turn the phones' auto-lock up
   before you start.

## Verify

```bash
npm run test:pipe             # relay only: inputs and snapshots round-trip
cd .. && node tools/net-race.mjs   # the real thing: two browsers, one race
```

`net-race.mjs` opens two browsers, has one host and one join, drives the client with real key
events, and then checks that the client's karts are on the host's recorded path, that the
host actually received the client's input, that both agree on every lap and place, and that a
race run to the flag produces the same finishing order on both machines.

## Protocol

Defined once, in [`../src/net/Protocol.ts`](../src/net/Protocol.ts). The relay does not parse
any of it — the two hot messages are opaque binary as far as this server is concerned.

| event | direction | meaning |
|---|---|---|
| `join {room, name, role, uid, v}` → ack | client → relay | enter a room as `host` or `player` |
| `roster {host, players[]}` | relay → room | who is present, with the `uid` seats are keyed on |
| `input {d}` | player → host | one packed input frame (~60Hz) |
| `snapshot` | host → players | packed world state (~25Hz); only the host may send |
| `lobby {…}` | host → players | the lobby, and the synchronised start |
| `to-host {…}` | player → host | ready-up, name change, "resend me everything" |
| `host-gone` | relay → room | the host disconnected; clients stop |
| `ping-probe` → ack | client → relay | round-trip, shown in the lobby |

Only the room's host may broadcast `snapshot`/`lobby`; the relay drops those from anyone
else, which is the first line of host arbitration.

`uid` is a per-tab identity the browser keeps. Seats are keyed on it rather than on
`socket.id`, which is reissued on every reconnect — that is what lets a phone which locked
itself mid-race come back into its own kart instead of a new one. The relay just carries it.
