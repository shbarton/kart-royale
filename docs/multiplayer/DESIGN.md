# Multiplayer — Design & Build Plan

Adding **real-time, simultaneous multiplayer** to Kart Royale so a few kids can race
each other live, each on their own phone, on the same home wifi. Self-hosted.

This document is the spec the build codes against. It records the research that led
to the architecture, the one open decision, the phased plan, and the traps we already
know about so we don't rediscover them the hard way.

Status: **Phases 1–4 built and passing `tools/net-race.mjs`; never yet played by a
human.** Branch: `multiplayer`. See §10 for exactly what was built, where the build
deviated from this plan and why, and what has not been tested.

---

## 1. Goal & constraints

| | |
|---|---|
| **Who** | 2–4 children |
| **Where** | all in the **same house, on the same wifi (LAN)** — latency ~1–5ms, no packet loss |
| **Device** | mobile phones (iOS Safari / Android Chrome), plus optionally a laptop/TV as host |
| **What** | race on the **same track at the same time**, seeing each other move live |
| **Hosting** | self-hosted — a LAN machine and/or a VPS. No paid cloud, no internet matchmaking |
| **Audience** | forgiving. Nobody files bug reports about sub-frame desync |

The LAN + few-players + forgiving-audience combination is the whole reason this is a
modest build rather than a hard one. It removes the need for the scary parts of netcode
(lag compensation, rollback, UDP/WebRTC, anti-cheat), which all exist to fight
internet-scale latency and adversarial players. We have neither.

## 2. Where we're starting from

The game today is **single-player with zero networking**. Every client simulates all 8
karts locally (1 player + 7 AI) and no client knows another client exists. Relevant facts:

- Physics is **complex and non-deterministic** across devices: raycast-suspension chassis,
  slip-angle tyre model, mini-turbo drift (`src/kart/Kart.ts`, `Suspension.ts`, `Tyre.ts`).
  This rules out any "everyone re-simulates from inputs" (lockstep) scheme.
- The race loop (`src/game/Race.ts`) already thinks in terms of **8 seats** with an
  `isPlayer` flag and an AI field filling the rest — so "N humans + AI fills the empty
  seats" maps onto the existing structure.
- Input is already abstracted (`src/core/Input.ts`, `src/core/TouchControls.ts`) and the
  mobile touch layer already sets `touch-action: none` and uses pointer capture.
- It builds to a **static bundle** (`vite build` → `dist/`) and is already a mobile PWA.
- `src/types.ts` is the shared contract; per `CLAUDE.md`, widen it only as a deliberate,
  separate commit.

## 3. Architecture decision

**Model: host-authoritative state synchronization over WebSockets.**

Three independent research passes (netcode theory, JS tooling, prior art + mobile) all
converged on this. Reasoning:

### 3.1 State sync, not lockstep
One machine runs *the* authoritative simulation and ships **state** (kart positions,
velocities, orientations) to everyone else. Because state is transmitted rather than
re-derived, the clients do **not** need identical physics — which is essential given our
non-deterministic engine. (Gambetta, client-server model; Gaffer-on-Games, state sync.)

### 3.2 The authority is a *client running the game*, not a headless server
Having "one authoritative simulator" does **not** require porting the physics to run
headless in Node. That port (~lifting 60k lines of physics out of Three.js rendering) is
the single biggest cost available and we are **not** paying it for v1. Instead, one machine
already running the game is the authority, and the network box is a **dumb relay**.

**Recommended host: a browser tab on a laptop or TV on the LAN** (the "Jackbox" pattern).
That one screen does three jobs at once:
1. runs the authoritative simulation,
2. shows the lobby + a **room code and QR code** to join,
3. optionally shows a big-screen spectator view of the race.

This beats "a phone is the host" because the host never wanders off mid-race and has no
latency advantage. **Open question for Sam:** is there a laptop/desktop/TV-browser at the
house to be this host? If strictly phones-only, we fall back to electing one phone as host
(same code path; just add host-migration/restart handling — see Risks).

### 3.3 Transport: plain WebSockets (socket.io)
On a LAN, TCP/WebSocket latency is effectively instant; UDP/WebRTC complexity (signalling,
STUN) buys nothing here. We use **socket.io** specifically because its free rooms and
**auto-reconnect** directly mitigate the #1 mobile trap (iOS dropping the socket on
background). If this ever leaves the LAN and real jitter shows up, revisit geckos.io (UDP).

### 3.4 Lag-hiding: keep the cheap bits, skip the rest
At LAN latency most of the classic stack is unnecessary:
- **Entity interpolation of remote karts — KEEP.** Render other karts ~2 snapshots (~30–50ms)
  in the past and slide between updates so they glide instead of teleporting.
- **Local prediction of your OWN kart — KEEP (cheap).** Apply your own input immediately so
  steering feels zero-lag even if wifi hiccups. Can be dropped to "pure display of authority
  state" if it causes correction pops — at LAN the difference is small.
- **Server reconciliation / input replay — SKIP.**
- **Lag compensation / time-rewind — SKIP.**

### 3.5 Rates
- Simulation: **60Hz fixed timestep** (the existing physics tick).
- Snapshot broadcast from host: **20–30Hz** (interpolation hides the gap).
- Input from each client: **~60Hz**, tiny packets (steer/throttle/drift/item as a small
  bitfield + a sequence number).

### 3.6 The host arbitrates everything contested
Item pickups, shells/bananas, projectile hits, kart–kart collisions, lap counting and finish
order are decided **only** by the host. Clients send *requests* ("fired item", "pressed
drift"), play an optimistic local effect, and the host's next snapshot is the truth. This
structurally prevents two phones from disagreeing.

### Architecture at a glance

```
  Phone A (client)            LAN relay              Laptop/TV (HOST)
  - reads touch input      (socket.io server,     - runs authoritative sim
  - sends inputs @60Hz  →   rooms + reconnect,  ←   (all karts, physics, items)
  - predicts own kart       just moves bytes)   →   - ingests all clients' inputs
  - interpolates others  ←        ↑ ↓            →   - broadcasts snapshots @20-30Hz
                                Phone B, C ...        - lobby / QR / countdown
```

The relay and the host can be the same machine (the laptop runs both), or the relay can
live on the VPS while a laptop hosts — both work.

## 4. Plan (phased, each phase is playable-ish)

1. ~~**Prove the pipe.**~~ **Done.** The socket.io relay, rooms, and a verified
   input/snapshot round-trip (`server/test-pipe.mjs`).
2. ~~**Shared race.**~~ **Done.** Host runs all karts; human seats are driven by received
   inputs, AI fills the rest. Clients interpolate remote karts and simulate their own.
3. ~~**Fair race.**~~ **Done for what it decides**, see §10.3. Items, hits, laps, placement
   and the finishing order are the host's alone; clients replay the visuals.
4. ~~**Lobby & robustness.**~~ **Done.** Room code, QR join, name entry, ready-up,
   synchronised start, reconnect and a seat held through a drop.
5. **Characters.** Per-kid name + colour + livery, photo on the number-plate / podium / HUD.
   Not started — the easy, fun layer, deliberately last, on top of a working game. Names and
   per-racer colours already exist in the lobby, so this is the podium and the number-plate.

Rough effort: on the order of a couple of weeks of focused work to genuinely fun.

## 5. Mobile-web traps (design around these from day one)

Documented, real, and mostly iOS Safari. Each has a known mitigation:

1. **iOS Safari closes the WebSocket when the tab backgrounds**, and can fail to fire
   `onclose` when wifi drops (WebKit bugs 228296 / 247943). → heartbeat/ping, client-side
   dead-socket detection, **auto-reconnect + rejoin-by-room-code** (why we use socket.io),
   pause the race on `visibilitychange`.
2. **Backgrounded tabs throttle `requestAnimationFrame` to ~1Hz**; iOS Low Power Mode caps
   30fps. → never derive physics from frame count; on refocus **resync from the host**, don't
   fast-forward.
3. **Screen sleeps mid-race.** → Screen Wake Lock API (Safari 16.4+/Chrome 84+); locks
   auto-release on background, so **re-acquire on `visibilitychange`**.
4. **Touch delay / gestures hijacking a steering drag.** → already largely handled in-game
   (`touch-action: none`, pointer capture); keep listeners `{passive:false}` + `preventDefault`.
5. **PWA (Add to Home Screen)** hides Safari chrome (good for kids) but does **not** exempt
   you from the background suspension above — same resync logic still required.

## 6. Lobby / join UX (LAN scale)

Copy Jackbox: the host screen shows a short **room code** *and* a **QR code that deep-links
to the host's LAN URL with the code pre-filled** (`http://<host-ip>:<port>/?room=ABCD`). Kids
scan, type a name, tap Ready. Avoid mDNS/auto-discovery — flaky across phone OSes; a QR to a
raw IP is more reliable. Flow: lobby lists joined players → each taps **Ready** → host starts
a **synchronized countdown** by broadcasting a shared `startAt` timestamp so all countdowns
align → race. Drop mid-race: keep the slot for a grace window, allow rejoin-by-code into the
same slot, else convert to AI/ghost and continue.

## 7. Risks (ranked)

1. **Host quits / migrates** (phones-only fallback). The authority leaving kills the race. The
   laptop/TV host design avoids this; the phones-only design needs "host is player 1, restart
   if they drop" or true host migration. Prefer the laptop host.
2. **Snapshot bloat.** 4 karts + projectiles at 30Hz is trivially small, but naive full-object
   JSON per tick adds up — use compact/binary or delta-encoded state.
3. **Correction pops.** Even at LAN, self-prediction diverging from the authority can snap; budget
   for smoothing, and be willing to drop self-prediction to pure display (latency is negligible).
4. **iOS background/reconnect** (see §5.1) — most *likely* to bite in practice; build reconnect early.

## 8. Legal / hosting notes

- Repo is **MIT-licensed** — adapting and self-hosting is fine.
- It is an explicit *Mario Kart-style* clone. Fine for private family use; do **not** publish
  publicly with Nintendo-ish branding.
- The game is graphically heavy — best on newer phones; older devices may struggle.

## 9. Sources

Netcode: Gambetta *Fast-Paced Multiplayer* (client-server, prediction, interpolation);
Gaffer-on-Games (deterministic lockstep, floating-point determinism, state synchronization,
fix-your-timestep); Valve *Source Multiplayer Networking*.
Tooling: socket.io, `ws`, Colyseus, geckos.io, Nakama docs/repos.
Prior art: `colyseus/react-racing-game`, geckos.io three.js-forum build logs, `jeeanribeiro/tag-game`.
Mobile: WebKit bugs 228296 / 247943, MDN Screen Wake Lock, MDN Pointer/mobile touch controls.

---

## 10. What was actually built

Phases 1–4 are in. `tools/net-race.mjs` runs a real two-browser race and passes. **No child
has played it yet** — everything below is measured by harness, not by anyone having fun.

### 10.1 The map

| file | what it is |
|---|---|
| `src/net/Protocol.ts` | every byte on the wire, defined once |
| `src/net/Net.ts` | the session — host and client, one `System`, ticked after `Race` |
| `src/ui/LobbyScreen.ts`, `src/ui/lobby.css` | room code, QR, who's in, ready-up |
| `server/relay.mjs` | unchanged in shape; gained `uid`, `to-host` and a ping probe |
| `tools/net-race.mjs` | two browsers, one race, four questions |
| `tools/lobby-shots.mjs` | clicks through the join flow and photographs it |

The race director's whole footprint is three flags and one callback (`netMode`,
`netClient`, `netCommandFor`, `netSetState`). A remote player's controls enter the simulation
at the exact line the local player's do. Nothing in `src/game/` or `src/kart/` imports
anything from `src/net/`.

### 10.2 Where the build deviates from the plan above

**A synchronised start uses a DELAY, not a timestamp.** §6 called for broadcasting a shared
`startAt`. That imports a clock-synchronisation problem to solve a LAN-latency one — phones do
not agree on the time of day, and being 400 ms out on a wall clock is normal. The host instead
sends `startIn` and *everyone including the host* starts that many milliseconds after
receiving it. The spread between two devices is then one LAN hop, ~2–5 ms.

**Clients do not simulate the karts they do not own.** §3.4 kept local prediction of your own
kart (this was built, with soft correction) and said nothing definite about the other seven.
They are now *posed*, not simulated: `Kart.netPose` writes position, heading, wheel spin and
the driver rig directly from interpolated snapshots. Two devices integrating a
non-deterministic chassis diverge within a corner, so simulating them would have produced a
visible correction on every packet — and eight chassis of physics a phone does not need to
run. Measured path error against the host's own recorded trajectory: **0.02–0.32 m**.

**Item presses are sent as a running total, not a flag.** An edge cannot survive a lossy
sample: a press landing between two sends is simply gone and the shell never fires. The host
subtracts what it has already fired.

**`accelAuto` crosses the wire.** It has to. Auto-accelerate is on by default on touch and the
rocket start reads a held throttle as a decision — without that bit the host would burn every
phone out on the line, every race. This is the same bug the single-player game already fixed
once; it would have come straight back in multiplayer.

### 10.3 What is host-authoritative, and what is only drawn

Decided by the host, and true: item rolls and pickups, who was hit by what, stun/boost/star,
laps, placement, the finishing order, respawns, and the flag.

Drawn locally and *not* a decision: the shell itself. When the host reports a kart fired
something, the client spawns a cosmetic projectile that flies under local physics — because a
kart spinning out for no visible reason reads as a bug. Whatever that local shell appears to
hit changes nothing; the real consequence arrives as state in the same snapshot stream.

### 10.4 Known gaps

- **A remote kart mid-drift slides flat.** The chassis roll and crab angle are derived from
  forces a posed kart is not computing. Cosmetic, on someone else's kart, and it costs ten
  more floats a tick to fix properly.
- **A backwards throw replays forwards** on other machines. The bus event does not carry the
  direction; the wire would need one more bit.
- **Your own item icon can flicker** for up to 300 ms after you fire, when the host is still
  reporting it as held. Suppressed by a timer, not by a fix.
- **Wake lock does not work over plain LAN http** — it needs a secure context, and the
  request is refused quietly. Smaller than it first looks: the idle timer resets on TOUCH, so
  a player steering with a thumb keeps their own screen lit. What is exposed is the lobby,
  the countdown, the results board, and anyone using the tilt scheme with auto-accelerate —
  which is a supported way to drive a whole lap without touching the glass. Mitigation
  ladder in `server/README.md`; the free one is turning Auto-Lock off on the phones.
- **Untested:** a phone as the host, reconnect after a real drop, pausing mid-race, and more
  than two machines at once. All are implemented; none has been run.
