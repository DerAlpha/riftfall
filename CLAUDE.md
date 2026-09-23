# RIFTFALL – Engineering Guide (CLAUDE.md)

Browser first-person sci-fi horror wave shooter. TypeScript (strict) + Vite + Three.js (WebGL2) +
pmndrs/postprocessing + Rapier + three-mesh-bvh. Static build, deployable to any webspace.

Keep this file current: update **Milestone status** and **Decisions** whenever a milestone lands.

## Commands

| Command                                                                                                | Purpose                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                                                                          | Vite dev server (http://localhost:5173)                                                                  |
| `npm run build`                                                                                        | Typecheck + production build to `dist/` (relative base, works in any sub-path)                           |
| `npm run preview`                                                                                      | Serve the production build                                                                               |
| `npm run check`                                                                                        | typecheck + eslint + vitest – run before every commit                                                    |
| `npm test`                                                                                             | Vitest unit tests                                                                                        |
| `npm run assets`                                                                                       | Download CC0 assets (Poly Haven) into `public/assets/` (idempotent, optional)                            |
| `npm run smoke`                                                                                        | Headless Chromium smoke test (build must exist): boots the game, moves, screenshots into `smoke-output/` |
| `node tools/photo.mjs --preset ultra [--hud] [--spots '[[x,y,z,yaw,pitch]]'] [--exec '["noclip on"]']` | Art-direction screenshots (build must exist)                                                             |

URL parameters (dev/testing): `?autostart` skip start screen, `?nolock` play without pointer lock,
`?preset=low|medium|high|ultra` session-only preset, `?smoke` expose `window.__RIFTFALL__` in production builds.

## Architecture

```
src/
  main.ts            entry (no three/postfx/Rapier imports): WebGL2 probe, loading screen, dynamic
                     Game import, fatal error screen; index.html adds a no-JS notice + boot watchdog
  game/Game.ts       composition root – constructs every system, wires events, owns the GameLoop
  game/              PauseController (pause/pointer-lock/visibility/console state machine),
                     GamePersistence (save wiring, session-only ?preset=, resetsave),
                     MenuPadNavigator (gamepad D-pad/A/B menu navigation), devCommands
  core/              engine-agnostic building blocks (no three.js imports except contracts.ts)
    contracts.ts     ALL public system interfaces (RenderApi, PhysicsApi, InputApi, …) – read this first
    events.ts        GameEvents map for the typed EventBus
    EventBus.ts      typed pub/sub, isolates throwing handlers
    GameLoop.ts      fixed-timestep loop (60 Hz sim) + interpolated rendering, timeScale, pause, fps limit
    Rng.ts           seeded sfc32 RNG (daily challenge determinism) – never Math.random() for gameplay
    Pool.ts          generic object pool (for M2+ projectiles, particles, decals, enemies; unused in M1 –
                     AudioEngine keeps its own voice free list)
    math.ts          damp/spring/noise/ring buffer helpers
    log.ts           tagged logger with history (dev console / debug overlay)
  defs/              ALL balancing & tuning data (no magic numbers in systems)
  input/             InputSystem (keyboard/mouse/gamepad → Actions, rebinding, pointer lock)
  physics/           PhysicsWorld (Rapier wrapper, collision groups, raycasts, interpolated props)
  player/            PlayerController (movement state machine on Rapier KCC), PlayerCamera, ViewmodelRig
  render/            RenderSystem (renderer, scenes, cameras), QualityManager, Environment, CSM shadows
    postfx/          PostFX pipeline (N8AO, bloom, DoF, motion blur, height fog, CA, grading LUT, grain, SMAA)
    materials/       GPU procedural PBR texture generator + MaterialLibrary (asset textures override)
    vfx/             volumetric light cones, dust particles (GPU/instanced)
  world/             level module kit (batched geometry + colliders) and level builders (TestRoom)
  assets/            manifest, loader (glTF+Draco/Meshopt, KTX2, HDR), placeholder system
  audio/             AudioEngine (buses, ducking, reverb zones, HRTF), procedural synth fallbacks
  save/              SaveSystem (IndexedDB → localStorage → memory), migrations, SettingsStore
  ui/                DOM HUD, debug overlay (F3), dev console (^), Preact menus, loading screen
```

### Frame / tick flow

```
rAF → GameLoop.advance(dt)
  ├─ beginFrame (every frame, also paused): input.beginFrame (poll pads, compute edges)
  │     → pauseState.onFrame (pause binding opens/closes the pause menu)
  │     → padNav.update (menus open: D-pad/A/B) → playerCamera.applyLook (unpaused: mouse/stick look)
  ├─ fixedUpdate (60 Hz, 0..maxSubSteps times, unpaused): player.fixedUpdate (samples input, latches
  │     edges once per frame) → kill plane → physics.step → health.fixedUpdate → level.fixedUpdate
  ├─ update (per frame, unpaused): player.update (latches edges of frames without a tick, ADS, eye)
  │     → playerCamera.update (bob/roll/shake/FOV/DoF) → viewmodel → level.update
  │     → audio listener + sun probe → HUD
  └─ render (every frame): physics.syncVisuals(alpha) → render.render → quality.onFrame (unpaused only)
        → debug overlay → input.endFrame
```

- Simulation state (positions, velocities) only changes in `fixedUpdate`. Visuals interpolate with `alpha`.
- Input edges (`pressed`) are per-frame and computed in `beginFrame`, before the ticks. Tick consumers
  sample and latch them in `fixedUpdate` itself (so this frame's ticks see this frame's presses) and
  also in `update` for frames that ran no tick. Never move edge latching into `update` only – that
  adds a frame of input latency.
- Mouse look is applied per frame in `beginFrame` (`PlayerCamera.applyLook`), before the ticks: the tick
  reads the yaw the camera shows this frame (wish direction, dash, mantle probe).
- Paused (menus, lost pointer lock, hidden tab): no ticks/update, rendering continues behind the menus.

### Render pipeline (pmndrs/postprocessing, HalfFloat HDR buffers)

Authoritative order: the header of `src/render/postfx/PostFXPipeline.ts`.

```
RenderPass(world)
  → N8AO                                          (off: pass absent)
  → EffectPass[MotionBlur?, HeightFog]            (world-space; MB is a convolution → first)
  → Volumetrics                                   (additive cones/shafts/dust on RENDER.volumetricLayer)
  → EffectPass[DepthOfField]                      (own pass, enabled only while aiming)
  → RenderPass(viewmodel, clear depth only)
  → EffectPass[CA?, Bloom?, Exposure, ToneMapping (AgX/ACES), LUT3D]
  → EffectPass[SMAA|FXAA, ScreenStatus (low-HP, colorblind), Vignette?, Grain?]
    (AA off: ScreenStatus/Vignette/Grain close the grade pass)
```

- At most one convolution effect per EffectPass, and it comes first; depth consumers run before the
  viewmodel pass (it clears depth); AA runs on the LUT's sRGB output. Read the pipeline header before
  inserting an effect.
- Viewmodel is drawn after world-space effects so it is never fogged/blurred and never clips into walls.
- Additive volumetrics live on `RENDER.volumetricLayer` (main camera never sees it) and are drawn after
  AO and fog, depth-tested against the world; their shaders apply the fog transmittance themselves.
- Bloom is "selective" via an HDR threshold (`POSTFX.bloom.luminanceThreshold`, 0.92 on pre-exposure HDR):
  the emissive light panels (intensity 6–9) and bright specular highlights bloom. Deliberate: a
  mask-based emissive-only bloom costs an extra scene render; a test keeps every emissive material
  above threshold + smoothing.
- Renderer tone mapping is `NoToneMapping`; tone mapping happens in the post chain.
- Sun shadows: three CSM addon (`setupMaterial` must be called for every lit world material).
  `PCFShadowMap` + `shadow.radius` gives soft shadows (PCFSoftShadowMap is deprecated in r186). r186 PCF
  is a fixed 5-tap kernel: keep radii ≤ 2 texels, wider ones only dither the penumbra.

## Conventions

- **TypeScript strict**, ES modules, `import type` for types (`verbatimModuleSyntax`).
- **No magic numbers** in systems: tuning goes into `src/defs/*` (`as const` objects). Shader-internal
  constants (e.g. noise hashes) are fine.
- **Contracts first:** cross-system APIs live in `src/core/contracts.ts`. Systems `implements` them.
- **Event bus** for fire-and-forget coupling (`src/core/events.ts` lists every event). Direct calls for hard deps.
- **Never crash on content:** missing assets resolve to placeholders (magenta checker / grey box / silence)
  and are listed in the debug overlay; loaders never reject.
- **No per-frame allocations** in hot paths: reuse module-level scratch vectors (`const _v = new Vector3()`).
- **Units:** meters, seconds, radians in code (degrees only in defs where noted).
- **Coordinate system:** three.js – Y up, camera looks down −Z at yaw 0, positive yaw turns left.
- **Determinism:** gameplay randomness uses `Rng` (seeded); `Math.random` only for cosmetic jitter.
- **Tests:** Vitest for pure logic (economy, damage, progression, save migrations, movement math).
  Files named `*.test.ts` next to the code or under `tests/`.
- **Naming:** PascalCase classes/files for classes, camelCase functions, `SCREAMING_CASE` for defs objects.
- Comments explain _why_, not what. Keep them sparse.
- Language: code/comments in English, player-facing text in German (i18n later).

## Milestone status

| #   | Milestone                                                                   | Status |
| --- | --------------------------------------------------------------------------- | ------ |
| 1   | Setup, renderer, post-FX, test room, FPS controller (full movement)         | done   |
| 2   | Weapons (3), viewmodel, recoil, hit feedback, decals, particles             | –      |
| 3   | Enemy AI + navmesh, 3 enemy types, wave spawner, game over → vertical slice | –      |
| 4   | Economy: points, wall buys, doors, mystery box, perks, power-ups            | –      |
| 5   | All weapons, attachments, Rift Forge, elemental mods                        | –      |
| 6   | All enemies, elite affixes, spawn director, bosses                          | –      |
| 7   | Remaining maps, traps, events, easter eggs                                  | –      |
| 8   | All modes incl. roguelite cards + daily challenge                           | –      |
| 9   | Meta progression, skill tree, achievements, cosmetics, stats                | –      |
| 10  | Audio polish, dynamic music                                                 | –      |
| 11  | UI polish, settings, accessibility                                          | –      |
| 12  | Performance pass, balancing, bugfixing, production build                    | –      |

## Decisions (log)

- **TypeScript 6.0** instead of 7.x: typescript-eslint supports `<6.1`; TS 7 (native) would drop lint support.
- **WebGL2 only for now.** pmndrs/postprocessing and our ShaderMaterial/onBeforeCompile effects are WebGL-only;
  WebGPURenderer would need a parallel TSL pipeline. The spec marks WebGPU optional → deferred (RenderSystem
  creates the WebGLRenderer directly; there is no renderer factory yet).
- **Assets are fetched, not committed:** `npm run assets` downloads CC0 assets; without them the game uses
  GPU-generated procedural PBR textures and a procedural environment, so a fresh clone always runs.
- **Fixed 60 Hz simulation** with interpolation; mouse look per frame.
- **Rapier KinematicCharacterController** for the player (capsule), custom Source-style accel/friction on top.
- **Gamepad plays without pointer lock.** Gamepad presses grant no user activation, so a pad start/resume
  (A on a menu button, START = `pause` binding) unpauses lock-less; the next mouse press on the canvas takes
  the lock. The `pause` binding also closes the pause menu – except Escape (menus' "back", no activation).
- **Unload writes only pending settings** (`SettingsStore.flush`); profile changes are saved when they happen.
  `resetsave` resets the in-memory save in place, `?preset=` is session-only (never saved, no benchmark).
- **Movement unlocks** live in `profile.unlocks` (dev console `unlock` persists them); a map with
  `movementSandbox` (the calibration hall) grants every ability regardless.
- **Art direction (M1 test room):** dark industrial sci-fi horror – low IBL (0.26) and hemi fill, light comes
  from fixtures, emissive strips and skylight sun shafts. Poly Haven scans are used where they read well
  (worn concrete, diamond plate on stairs/ramps at their real `physicalSizeM`); sci-fi panels, grates and
  trims use the GPU procedural generators (scanned rusty grates/corrugated iron clashed with the style).
- **Viewmodel sun probe:** the viewmodel scene has no shadows, so Game casts one physics ray per frame from the
  eye towards the sun and fades the viewmodel's sun copy (`RENDER.viewmodelSunShadowedScale` ↔ `viewmodelSunScale`).
  Roof slabs therefore carry colliders; purely visual sky-glow panels neither collide nor cast shadows.
- **Quality auto-detect** runs once (GPU string heuristics, SwiftShader → low), then a one-time runtime benchmark
  may step down one preset; dynamic resolution keeps the target FPS afterwards.

## Known limitations / next steps

- Only verified on SwiftShader (headless); real-GPU frame times on the High preset still need a pass (M12 budget).
- Viewmodel is a procedural placeholder device; M2 replaces it with weapons via `ViewmodelRig.setModel()`.
- KTX2 path is implemented but untested with real files (`toktx` not available when fetching); textures ship as JPG.
- Height-fog sun glow is not shadowed (indoors it relies on low `sunScatterStrength`); shafts come from the level.
- Next: **Milestone 2** – weapon system (3 weapons), viewmodel animations, recoil, hit feedback, decals, particles.
