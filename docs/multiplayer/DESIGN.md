# Multiplayer — Design & Build Plan

Adding **real-time, simultaneous multiplayer** to Kart Royale so a few kids can race
each other live, each on their own phone, on the same home wifi. Self-hosted.

This document is the spec the build codes against. It records the research that led
to the architecture, the one open decision, the phased plan, and the traps we already
know about so we don't rediscover them the hard way.

Status (2026-08-17): **Phases 1–4 built, passing `tools/net-race.mjs`, and played on real
phones over real wifi.** Phase 5 not started. Branch: `multiplayer`, pushed.
§10 is what was built and where it deviates from this plan, §11 is what playing it found
and what changed as a result, and **§12 is where to start if you are picking this up cold.**

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
live on the VPS while a laptop hosts.

> **Correction, 2026-08-16.** "Both work" was written before anyone measured it. The relay
> is in the middle of the control loop — input goes phone → relay → host and the answer
> comes back host → relay → phone — so an off-LAN relay pays its round trip TWICE. The SFO2
> droplet measures 158 ms RTT, which puts ~450 ms between pressing a button and seeing
> another kart react. Your own kart is unaffected (locally simulated), but the field is
> stale and hits land late. A relay ~20 ms away is fine; that one is not. Keep the relay on
> the LAN unless you have measured the alternative. See `server/README.md`.

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

Phases 1–4 are in, `tools/net-race.mjs` passes, and **it has been played on real phones over
real wifi** — twice, by Sam, on 2026-08-16. Joining by QR, racing together, the shared
standings and the flag all worked. Everything in §11 came out of those two sittings.

Phase 5 (per-kid liveries, a photo on the number plate) is **not started**.

### 10.1 The map

| file | what it is |
|---|---|
| `src/net/Protocol.ts` | every byte on the wire, defined once |
| `src/net/Net.ts` | the session — host and client, one `System`, ticked after `Race` |
| `src/ui/LobbyScreen.ts`, `src/ui/lobby.css` | room code, QR, who's in, ready-up |
| `server/relay.mjs` | unchanged in shape; gained `uid`, `to-host` and a ping probe |
| `src/ui/HUD.ts` | `setRacers` + the in-race player board (`.kr-board`) |
| `tools/net-race.mjs` | two browsers, one race, four questions |
| `tools/lobby-shots.mjs` | clicks through the join flow and photographs it |
| `tools/mobile-hud-shot.mjs` | the in-race HUD on a phone, in a race with other humans in it |
| `tools/lobby-typing-test.mjs` | can you type your name and still steer? (see §12) |

The full harness list, including the single-player ones this lane added, is the table in
`CLAUDE.md`.

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

> Since §11, auto-accelerate is **permanent** on touch, so this bit is now always true from a
> phone. It still has to travel, because a desktop client can send it false. The standing
> consequence: a phone can never earn the rocket start, and can never burn out on the line
> either. That was already the behaviour of the default; it is now the only behaviour.

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
  than two machines at once. All are implemented; none has been run. Two humans plus AI has
  now been played repeatedly and works; **three or four has never actually happened**, and it
  is the thing this was built for, so it is the first thing to try next.
- **Item visuals in multiplayer are thinner than they look in single player**, and this
  matters now that a separate workstream is improving them (in flight as of 2026-08-17,
  touching `types.ts`, `Projectiles.ts`, `Items.ts`, `Effects.ts`, `Audio.ts`, `ItemIcons.ts`).
  What crosses the wire for a thrown item is `{kartId, itemKind}` and nothing else, so:
  a **backwards throw replays forwards** on every other screen, and the new `item-bounce` /
  `item-box-break` events fire from each client's own cosmetic copy rather than from the
  host's. Whatever that work lands, the protocol needs one more field and the replay needs
  the direction — cheap, but it has to be done deliberately after they merge.

---

## 11. What playing it found (2026-08-16)

Two sittings on a real iPhone in landscape, over house wifi, against a laptop host. The
netcode was not the problem in any of them — every single finding was the *phone*, and most
of them were older than this lane. They are recorded here because this is where they were
found, and because several are single-player bugs that had simply never been looked for.

**Everything below is on `multiplayer` and pushed.** Where a fix is touch-only it says so —
the desktop HUD is also the host's television and wants the weight it has.

### 11.1 The two that made it unplayable

**Typing your name took the steering wheel away.** The lobby asks for a name; on a phone that
raises the on-screen keyboard; `Input.onFirstKey` read those keydowns as proof of a hardware
keyboard and unmounted the touch controls *before the race started*. No stick, no drift, no
item button, and the HUD silently reverted to its desktop layout because `html[data-touch]`
went with it. The same missing guard meant typing also drove the kart, and `SWALLOW`
preventDefault'd Space, so a name could not contain one. Guarded by `typingInto`, with
`tools/lobby-typing-test.mjs` as the regression — written against the broken code first, so
it is a guard and not a hopeful assertion.

**A landscape phone drew a quarter of the pixels it could show.** Resolution had two policies
— an honest pixel budget in Mpx, and a flat `maxPixelRatio` — and on a short viewport the
flat one bound first and spent less than half the tier's own allowance. 0.56 Mpx against a
1.5 Mpx budget on a 2.24 Mpx panel. This read as "the car is super clear, the road ahead is
blurry", which is exactly what too few pixels looks like. `tools/pixel-check.mjs`.

### 11.2 Camera and lens, all measured

| what | before | after | harness |
|---|---|---|---|
| Vertical FOV on a 2.86:1 phone | **pinned at 45.2°** whatever was asked | 57.6° | `road-ahead.mjs` |
| Road visible ahead, cruising | 372 m | 427 m | `road-ahead.mjs` |
| Road visible, worst of a boost | 230 m | 255 m | `road-ahead.mjs` |
| Camera drop on a boost (phone) | 0.463 m | 0.247 m | `boost-cam.mjs` |
| Look-behind, frames to be behind | walked round over ~0.8 s | **1 frame** | `look-cut.mjs` |
| Heading error after a spin-out | median 123°, 9-in-16 backwards | median 17°, **0 backwards** | `spin-recover.mjs` |

The FOV one is the most interesting and the least visible: `fitFov` clamps horizontal to a
flat 100°, which never binds at 16:9 and binds *permanently* on a landscape phone, paying for
it out of the vertical. Every degree the rig opened the lens by on a boost was clamped away,
while the other half of the same dolly zoom — the arm coming in and dropping — went ahead as
designed. So on a phone a boost had been costing road ahead and giving nothing back, since
long before any of this.

### 11.3 HUD and controls, touch-only

- **Auto-accelerate is permanent.** No gas button, no AUTO chip on the race screen, no
  Auto/Manual row in the controls menu. The chip sat one tap from PAUSE and flipping it
  stopped the kart, which is a trap in a house full of children. See §10.2 for the standing
  consequence.
- **The position plate is replaced by a player board** listing the humans by name with their
  positions. "6th of 8" is the right question when the other seven are robots and the wrong
  one when your sister is in the race. Fed by `Net.racerNames()` → `HUD.setRacers()`; the HUD
  still knows nothing about networking.
- **The minimap moved to the top right and the clock to the centre.** This deliberately
  breaks ART_DIRECTION §7, which permits top-centre or bottom-centre and nothing else. Broken
  on touch only and said out loud in the stylesheet: §7 was written for a 16:9 frame.
- **Speedometer removed, lap plate and clock shrunk.**
- **Steering throw ~17% longer**, which is what "less sensitive" means. Deliberately not the
  expo — `CURVE = 1.26` has a measured invariant (half-travel output within 0.005 of 0.3990),
  and because the curve maps a *fraction* of the radius, lengthening the throw left that at
  0.4002. All 43 gates of `touch-feel.mjs` still hold.
- **A name field on the join pane.** It only existed on the choose pane, and a phone arriving
  by QR lands straight on join — which is the way we tell people to join — so every scanned
  player was called "Racer".

### 11.4 Coverage this lane knowingly lost

`touch-feel.mjs` measured chip hit-padding by pressing the AUTO chip and watching its label
flip. It was the only chip it could press, since PAUSE opens the menu and ends the run. AUTO
is gone, so **PAUSE's hit padding is now unverified** — the harness warns rather than
dropping the gate, and assumes the measured button padding in its place.

---

## 12. Picking this up cold

**State:** branch `multiplayer` on `shbarton/kart-royale`, pushed, 12 commits ahead of
`main`. Not merged to `main` and no PR opened — that is a decision for Sam, not a leftover.

**Run a race:**

```bash
npm run build          # in the repo root
cd server && npm install && npm start
```

Open the relay **by the host machine's LAN address, never `localhost`** — the QR is built
from whatever is in the host's address bar. Multiplayer → Start a room. Phones scan it.
Full instructions, including the screen-sleep ladder, are in `server/README.md`.

**Check it still works.** All four passed against this branch as committed. Note that the
working tree at the time of writing also carried a *separate* workstream's uncommitted
item-VFX changes, so a run today measures that too — commit or stash it first if a failure
needs attributing:

```bash
node tools/net-race.mjs           # two browsers, one race, to the flag
node tools/lobby-typing-test.mjs  # you can type your name and still steer
node tools/touch-feel.mjs         # 43 gates on the touch controls
npm run build                     # tsc + vite, the gate
```

**The next three things, in the order they are worth doing:**

1. **Play it with three or four kids.** Two humans works and is well covered. Three or four
   has never happened, and it is the entire point of the feature. Everything in §11 came from
   twenty minutes with two.
2. **Finish the item story across the wire** — one more field so a backwards throw replays
   backwards, and a decision about the new bounce/box-break events. Blocked on the item-VFX
   workstream merging (§10.4).
3. **Phase 5: characters.** Per-kid colour and name already exist in the lobby; what is
   missing is the livery, the number plate and the podium.

**Do not re-litigate** (all argued in this document, with measurements): the relay stays on
the LAN, not the SFO2 droplet (§3, correction box); clients do not simulate karts they do not
own (§10.2); the start is a delay, not a timestamp (§10.2); items are decided by the host and
only *drawn* by clients (§10.3).
