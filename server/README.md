# Kart Royale — multiplayer relay

A dumb byte-mover with rooms for LAN multiplayer. It forwards player **inputs** up to the
authoritative host and **snapshots** back down to the players, and (optionally) serves the
built game from `../dist` so everything lives on one LAN URL. It knows nothing about karts,
physics or laps — that all stays in the game, running on one client (the host).

Full design: [`../docs/multiplayer/DESIGN.md`](../docs/multiplayer/DESIGN.md).

## Run

```bash
cd server
npm install
npm start            # relay on http://0.0.0.0:8080  (PORT env to override)
```

Build the game first (`cd .. && npm run build`) and the relay will also serve it at the same
URL — that's the URL the join QR code points at. Without a build, the relay still runs and
`GET /healthz` answers, which is all Phase 1 needs.

## Verify the pipe (Phase 1)

```bash
npm run test:pipe    # boots the relay in-process, connects a fake host + player,
                     # asserts inputs and snapshots round-trip. exit 0 = pass.
```

## Protocol (v0)

| event | direction | meaning |
|---|---|---|
| `join {room, name, role}` → ack | client → relay | enter a room as `host` or `player` |
| `roster {host, players[]}` | relay → room | who is present |
| `input {seq, steer, throttle, drift, item…}` | player → host | one input frame (~60Hz) |
| `snapshot {t, karts[], …}` | host → players | world state (~20–30Hz); only the host may send |
| `lobby {…}` | host → players | ready-up / countdown control (host-authored) |
| `host-gone` | relay → room | the host disconnected; clients pause |

Only the room's host may broadcast `snapshot`/`lobby`; the relay drops those from anyone
else, which is the first line of host arbitration.
