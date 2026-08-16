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

## Screens going to sleep

The game asks for a Screen Wake Lock at the start of every race, but that API **only exists
in a secure context** — a plain `http://192.168.x.x` LAN address is not one, so over LAN http
the request is quietly refused and the phones are on their own.

**Be precise about what that costs, because it is smaller than it sounds.** The OS idle timer
is reset by TOUCH, not by rendering, so a player with a thumb on the steering stick keeps
their own screen awake by playing. What is exposed is every moment nobody is touching the
glass:

- the lobby, waiting for the last child to join — easily a minute;
- the countdown, and the results board;
- **tilt steering**, which is one of the four shipped control schemes, combined with
  auto-accelerate, which is ON by default on touch. That combination is a supported way to
  play a whole lap without touching the screen once.

Three ways out, cheapest first:

1. **Turn the phones' Auto-Lock off before you start** (iOS: Settings → Display & Brightness
   → Auto-Lock → Never). Twenty seconds a phone, no code, works today. Do this whatever else
   you do.
2. **A real certificate for a name that points at the LAN box.** Put an A record for
   something like `race.example.com` on the host's LAN address and issue a certificate by
   DNS-01 challenge (no inbound port needed). Phones trust it, no warnings, and **the traffic
   never leaves the house**. This is the right answer if it works; the catch is that some
   routers and resolvers refuse to return a private address for a public name (DNS-rebinding
   protection), so it needs testing on the actual network before you rely on it.

3. **Put the relay on a VPS with a certificate — MEASURE FIRST.** Tempting, and it is what
   §3.2 above assumed, but the relay sits in the middle of the control loop: a phone's input
   goes phone → relay → host, and the answer comes back host → relay → phone. Hosting the
   relay off-LAN therefore pays the round trip to it **twice**.

   Measured 2026-08-16, laptop to the SFO2 droplet: **158 ms RTT**. That makes the loop
   ~160 ms up, ~160 ms back, plus a snapshot interval and the interpolation delay — call it
   450 ms from pressing a button to seeing another kart react to it. Your own kart still
   steers instantly (it is simulated locally), but the rest of the field is a quarter of a
   second stale and every hit lands late enough to feel unfair.

   A relay on the same continent, ~20 ms away, would be fine. That one is not. Ping it before
   choosing it.

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
