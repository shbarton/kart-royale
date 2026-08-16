# Working on this repo

A kart racer in Three.js with **zero art assets** — every texture, mesh, material
and sound is generated in code at load time. Written almost entirely by Claude
agents working in parallel. This file is the handover note: the contract to code
against, the traps that have already cost real rounds, and how to tell whether a
change actually helped.

Read `README.md` for what the project is, and `ART_DIRECTION.md` for what it is
supposed to look like — §9 of that file is the scoring rubric, and it is the bar.

## Commands

```bash
npm run dev      # vite dev server
npm run build    # tsc --noEmit && vite build  — this is the gate, it must pass
npm run preview  # serve the production build
```

Never start a bare `npx vite` for a test harness. Use `tools/vite-server.mjs`,
which spawns the binary directly, kills the whole process group on teardown, and
refuses to adopt a server that is already serving a *different* working tree. An
orphaned dev server from a worktree once silently served stale code into every
measurement for a full round.

## The contract

`src/types.ts` is the interface every subsystem codes against — `ITrack`,
`IKart`, `IItems`, `IRace`, `IInput`, `Ctx`, `Surface`, `SURFACE_PROPS`.

**Do not edit `src/types.ts` as a side effect of another change.** It is what
makes parallel work possible; changing it invalidates everyone else's
assumptions at once. If a change genuinely needs the contract widened, do that
as its own commit and say so.

Rough ownership, one concern per directory:

| path | what lives there |
|---|---|
| `src/render/` | renderer, post chain, procedural textures/materials, sky |
| `src/world/` | track layout + geometry, scenery, foliage, water |
| `src/kart/` | chassis, suspension, tyres, model, liveries |
| `src/game/` | race state, AI, camera, items, projectiles |
| `src/fx/` | particles, trails, decals |
| `src/ui/` | HUD, menus, minimap |
| `src/audio/` | synthesis, music, engine |
| `src/core/` | input, settings, diagnostics, prewarm, event bus |
| `src/net/` | multiplayer: the wire protocol, and the host/client session |

`src/net/` is one-way. Nothing in `game/`, `kart/` or `ui/` imports from it; the race
director's entire footprint is three flags and one callback, and a remote player's
controls enter the simulation at the exact line the local player's do. Keep it that way —
the moment the chassis knows a network exists, every physics change becomes a netcode
change. See `docs/multiplayer/DESIGN.md`.

## Traps that have already cost a round

These are not style preferences. Each one is a bug that shipped, got measured,
and got fixed. The comment explaining each is load-bearing — if you remove the
guard, you reintroduce the bug.

**MSAA is incompatible with the AO pass.** `N8AOPostPass` samples the composer's
input buffer as a *texture*, which a multisampled target cannot resolve to.
`multisampling = 2` produced black frames on 7.6% of frames; `0` produced 0.2%.
`Renderer.ts` returns `0` samples whenever SSAO is on. Do not "optimise" this
back on.

**Steering handedness is corrected once, at the input boundary.** This chassis
uses `forward = (sin yaw, 0, cos yaw)`, so a rising yaw turns *left*, while the
input contract says `steer > 0` means the player wants to go *right*.
`Kart.ts` negates at the boundary and `Race.ts` negates the AI's command at its
call site, because the AI solves in the chassis frame. These two negations are
correct together. Flipping only one inverts steering for the player or sends
every AI kart into a wall. There is a probe: `tools/steer-test.mjs`.

**`DRIFT_CARRY_TIME` already exists** in `Kart.ts`. It preserves the mini-turbo
clock across a brief dip in slide angle so that a corner exit does not reset the
charge. Several agents have "discovered" this problem and added a second,
competing carry window. Check before adding one.

**A single global constant can defeat thousands of lines of work.**
`envMapIntensity` set flat across all materials silently deleted every metal
reflection and clearcoat highlight in the game. It is now per-material via
`envFor()` in `Liveries.ts`. Be suspicious of any one value applied uniformly to
things that are not uniform.

**Reading the presented frame requires `preserveDrawingBuffer`.** Without it,
`readPixels` after present returns discarded contents — which reads as "100% of
frames are black" and is completely false. `FrameWatch` now refuses to start
unless the context was created with it (`?debug=frames` sets it). This cost a
day of chasing a bug that did not exist.

**Shader pre-warm must bind a render target.** `WebGLPrograms.getParameters()`
reads `outputColorSpace` and `toneMapping` off the *currently bound* target, so
`renderer.compile()` with nothing bound compiles default-framebuffer variants
that the composer never uses, and every real shader still stalls on first use.
`Prewarm.ts` binds a 1×1 scratch target while compiling.

**Workflow scripts must use a literal `ROOT`.** `tools/*.js` run in a sandbox
with no `process` global — reading `process.env` throws on line 1 and kills the
whole run. Every one of them has `const ROOT = '/Users/ryan/dev/personal/kart-game'`
with a comment saying why. A well-meaning "make this portable" commit broke all
of them at once.

**Worktrees need a `node_modules` symlink** or the `tools/*.mjs` harnesses will
not start.

## Verifying a change

The harnesses are the point of this repo more than the game is. Each one answers
a question that is genuinely hard to answer by looking.

| harness | the question it answers |
|---|---|
| `fps-bench.mjs` | Does it hold 60fps for a whole race — on desktop and on a throttled phone — and is the frame budget going to the CPU or the GPU? |
| `fill-probe.mjs` | How many ms of the frame are PIXELS and how many are not? Fits ms/Mpx above the vsync clamp, where the signal is not pinned to the refresh rate. |
| `drift-bench.mjs` | Is a drifting lap actually faster than a clean one, and does the mini-turbo ladder pay out? |
| `tear-hunt.mjs` | Are any presented frames torn or partially rendered? |
| `hitch-check.mjs` | Where are the frame-time spikes? |
| `camera-probe.mjs` | How much does the camera swing, in °/s? |
| `mobile-soak.mjs` | Does it survive a phone without a memory kill? |
| `context-loss-test.mjs` | Does it recover from a lost WebGL context? |
| `steer-test.mjs` | Does the kart go where the input says? |
| `ai-health.mjs` | How often does the AI touch a wall? |
| `touch-test.mjs`, `touch-lazy-test.mjs` | Do touch controls mount and steer, including when the browser lies about being a desktop? |
| `touch-feel.mjs` | Are the touch controls any *good*? Input latency in ms and frames, the histogram of steer values a slow drag actually produces, three-plus-finger integrity under out-of-order releases, control size/reach across six devices, and whether anything triggers a browser gesture. |
| `autoplay.mjs`, `shot.mjs` | Play a race unattended; capture frames. |
| `net-race.mjs` | Do two machines actually race each other? Opens two browsers, hosts and joins, drives the client with real key events, then checks the client's karts sit on the host's *recorded path*, that the host received the input, and that both agree on every lap, place and the finishing order. |
| `lobby-shots.mjs` | Clicks through Multiplayer → host a room → a phone joins by QR link, and photographs each step. The lobby's contrast was set by looking at these: a scrim that looks right over the title card is unreadable over a sunlit circuit. |
| `mobile-hud-shot.mjs` | The in-race HUD on a phone, in a race that has other humans in it — the player board only exists when the game has been told who they are, so single-player cannot show it. |
| `pickup-probe.mjs` | When a player says "the view shifted", was it the BROWSER (scroll/zoom) or the GAME (lens)? Samples both across a pickup and prints whichever moved. |
| `pixel-check.mjs` | How many pixels is the game actually DRAWING, against what the panel can show? Catches a flat `maxPixelRatio` binding below the tier's own pixel budget on a small viewport — which reads as "the car is sharp, the road ahead is blurry" and is invisible in every other measurement. |
| `road-ahead.mjs` | How many metres of road can you actually SEE in front of you — at rest and mid-boost, on a desktop frame and on a landscape phone? Marches the centreline and projects it through the live camera. Catches `fitFov`'s horizontal clamp pinning the vertical field on a wide aspect, which is invisible in every other measurement. |
| `look-cut.mjs` | Is the view behind you on the NEXT frame, or does the rig walk round over half a second? Measures the rendered camera, not the rig's intent — `lookAmt` flipping instantly means nothing while `MAX_EYE_SLIP` and the orientation slerp are still limiting the real one. |
| `lobby-typing-test.mjs` | Can you type your name in the lobby and still steer? Guards the regression where the on-screen keyboard's keydowns read as a hardware keyboard and unmounted the touch controls before the race started. |

Rules learned the hard way:

- **A phone-shaped viewport is not a phone.** `isMobile: true` does not put the
  game in touch mode: the pad mounts LAZILY on the first genuine pointer, so
  until something actually touches the glass `input.touch` is false and every
  `html[data-touch]` rule under test is inert. Worse, `Input.onFirstKey`
  *unmounts* it again the moment a real key arrives — so a harness that taps to
  mount and then drives with ArrowUp photographs a desktop HUD at phone size and
  passes. Tap a read-only area, assert `input.touch === true`, and drive with
  auto-accelerate rather than the keyboard.
- **Validate the instrument before trusting the reading.** Two harnesses here
  produced confident, precise, entirely fictional numbers before anyone checked
  them — one projected a camera-relative vector as if it were a world point, and
  one had a frame-rate knob wired to nothing at all, which manufactured a "17×
  frame-rate dependence" that did not exist.
- **A timing number from a software rasteriser is fiction.** Every harness here
  passes `--enable-unsafe-swiftshader`, which is right when the question is
  about correctness and wrong when it is about milliseconds: headless Chrome
  falls back to SwiftShader silently and still returns confident numbers.
  `fps-bench.mjs` omits that flag on purpose, reads `UNMASKED_RENDERER_WEBGL`
  off the context the game actually rendered with, and hard-exits rather than
  report a frame time it cannot attribute to a real GPU. Run
  `node tools/fps-bench.mjs --force-software` to watch the refusal fire.
- **At 60Hz there is no such thing as a 20ms frame.** vsync only ever hands back
  ~16.7ms or ~33.4ms, so the *median* frame time of a build running at 48fps is
  exactly 16.70 and reads as a perfect pass, and "% of frames over 16.7ms" is
  ~45% on a flawless run purely from jitter. `fps-bench.mjs` gates on the MEAN
  (which is 1000/fps by construction) and on frames that took two vsyncs. Do not
  tidy either of those onto the obvious statistic.
- **A screenshot cannot find a gameplay bug.** Inverted steering, unusable mobile
  controls and a pause menu that permanently ended your race all survived three
  full rounds of six reviewers scoring beautiful stills. If a change affects how
  the game *plays*, it needs a harness or a human, not a critic looking at a PNG.
- **Measuring touch means measuring the browser too, and it lies in three
  specific ways.** `touch-action` does not inherit, but its *effect* does — the
  browser intersects it up the ancestor chain, so asserting `none` on a button
  whose `html` already says `none` fails a correct page. Chrome does not
  implement `-webkit-touch-callout` and DISCARDS the declaration at parse time,
  so neither `getComputedStyle` nor the CSSOM can see it and both read as "the
  CSS is missing". And Chrome coalesces `pointermove`s inside one frame, so a
  125-step sweep returns 124 samples and the last one is not where you put it.
  `touch-feel.mjs` failed the build for all three before any of them was real.
  The fourth: `Kart.step` sets `steer = 0` while `stunTime > 0`, so an
  unattended kart that finds a wall produces a 150 ms "input latency" hole that
  the touch layer did not cause. Contaminated frames are dropped, not averaged.
- **Pin the adaptive scaler for every A/B: `?scaler=off`, or `--scaler off`.**
  The ladder in `main.ts` spends resolution to protect frame rate, which is
  right for a player and ruinous for a measurement — an optimisation that
  genuinely saves 2 ms lets the ladder hold a higher rung, so it draws *more
  pixels* and reports the same fps. The saving is real and completely
  invisible. Measured here: unpinned run-to-run spread is 8.65 ms, pinned it is
  2.04 ms, and the two *slowest* unpinned runs are the two that walked down to
  rung 0.5 — a quarter of the pixels, running slower than full resolution.
  `__loopHealth().scalerPinned` reports whether the pin took; `fps-bench`
  refuses to print a run that claims to be pinned and is not.
- **Benchmark runs degrade this machine, so idle between them.** Four
  consecutive `fps-bench` runs fell 59.9 → 58.4 → 53.4 → 39.4 fps with no code
  change, and the game's own JS doubled (2.0 → 4.2 ms) across the sequence; a
  120 s idle restored the next run to 57.6. Anything that sweeps must also
  relaunch the browser per point — reusing one browser and opening a page per
  point leaves a WebGL context and ~344 MB of textures alive each time, which
  made `fill-probe`'s first draft report a *negative* fill slope.
- **Draw calls are not proof of rendering.** All five known black-screen failure
  modes still issue a full frame's worth of draws into a canvas that is never
  painted. `Diagnostics.ts` samples the luma spread of the presented image
  instead; trust that, not the counter.

Before calling anything done: `npm run build` must pass, and the harness that
covers the thing you touched must pass.

## Style

Match the surrounding code — it is fairly heavily commented, and deliberately so.
Comments here explain *why*, and more than once a correct-looking cleanup that
deleted a "wrong" comment also deleted the guard it justified and reintroduced a
7.6%-of-frames rendering bug. If a comment seems wrong, the guard may still be
right for a different reason. Work out which before removing either.
