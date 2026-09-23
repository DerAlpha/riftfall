# RIFTFALL – Engineering Guide (CLAUDE.md)

Browser first-person sci-fi horror wave shooter. TypeScript (strict) + Vite + Three.js (WebGL2) +
pmndrs/postprocessing + Rapier + three-mesh-bvh. Static build, deployable to any webspace.

Keep this file current: update **Milestone status** and **Decisions** whenever a milestone lands.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server (http://localhost:5173) |
| `npm run build` | Typecheck + production build to `dist/` (relative base, works in any sub-path) |
| `npm run preview` | Serve the production build |
| `npm run check` | typecheck + eslint + vitest – run before every commit |
| `npm test` | Vitest unit tests |
| `npm run assets` | Download CC0 assets (Poly Haven / ambientCG) into `public/assets/` (idempotent, optional) |
| `npm run smoke` | Headless Chromium smoke test (build must exist): boots the game, moves, screenshots into `smoke-output/` |

## Architecture

```
src/
  main.ts            entry: creates Game, handles fatal errors (WebGL2 missing → friendly screen)
  game/Game.ts       composition root – constructs every system, wires events, owns the GameLoop
  core/              engine-agnostic building blocks (no three.js imports except contracts.ts)
    contracts.ts     ALL public system interfaces (RenderApi, PhysicsApi, InputApi, …) – read this first
    events.ts        GameEvents map for the typed EventBus
    EventBus.ts      typed pub/sub, isolates throwing handlers
    GameLoop.ts      fixed-timestep loop (60 Hz sim) + interpolated rendering, timeScale, pause, fps limit
    Rng.ts           seeded sfc32 RNG (daily challenge determinism) – never Math.random() for gameplay
    Pool.ts          object pooling (projectiles, particles, decals, enemies, voices)
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
  ├─ fixedUpdate (60 Hz, 0..maxSubSteps times): player.fixedUpdate → physics.step → level.fixedUpdate
  ├─ update (per frame): input.beginFrame → player.update (samples intents, latches edges)
  │                      → camera rig (look is per-frame for zero input lag) → level.update → HUD/audio listener
  └─ render: physics.syncVisuals(alpha) → render.render(dt) → debug overlay → input.endFrame
```

* Simulation state (positions, velocities) only changes in `fixedUpdate`. Visuals interpolate with `alpha`.
* Input edges (`pressed`) are per-frame; tick consumers must latch them in `update` and consume in `fixedUpdate`.
* Mouse look is applied per frame (not per tick) – the tick reads the current yaw for wish direction.

### Render pipeline (pmndrs/postprocessing, HalfFloat HDR buffers)

```
RenderPass(world) → N8AO → EffectPass[height fog, DoF(ADS), motion blur]
  → RenderPass(viewmodel, clear depth only) → EffectPass[bloom, CA, tone mapping (AgX/ACES), LUT grading,
     low-HP, vignette, film grain] → EffectPass[SMAA|FXAA]
```

* Viewmodel is drawn after world-space effects so it is never fogged/blurred and never clips into walls.
* Bloom is "selective" via HDR threshold: only emissive surfaces (intensity > 1) exceed `POSTFX.bloom.luminanceThreshold`.
* Renderer tone mapping is `NoToneMapping`; tone mapping happens in the post chain.
* Sun shadows: three CSM addon (`setupMaterial` must be called for every lit world material).
  `PCFShadowMap` + `shadow.radius` gives soft shadows (PCFSoftShadowMap is deprecated in r186).

## Conventions

* **TypeScript strict**, ES modules, `import type` for types (`verbatimModuleSyntax`).
* **No magic numbers** in systems: tuning goes into `src/defs/*` (`as const` objects). Shader-internal
  constants (e.g. noise hashes) are fine.
* **Contracts first:** cross-system APIs live in `src/core/contracts.ts`. Systems `implements` them.
* **Event bus** for fire-and-forget coupling (`src/core/events.ts` lists every event). Direct calls for hard deps.
* **Never crash on content:** missing assets resolve to placeholders (magenta checker / grey box / silence)
  and are listed in the debug overlay; loaders never reject.
* **No per-frame allocations** in hot paths: reuse module-level scratch vectors (`const _v = new Vector3()`).
* **Units:** meters, seconds, radians in code (degrees only in defs where noted).
* **Coordinate system:** three.js – Y up, camera looks down −Z at yaw 0, positive yaw turns left.
* **Determinism:** gameplay randomness uses `Rng` (seeded); `Math.random` only for cosmetic jitter.
* **Tests:** Vitest for pure logic (economy, damage, progression, save migrations, movement math).
  Files named `*.test.ts` next to the code or under `tests/`.
* **Naming:** PascalCase classes/files for classes, camelCase functions, `SCREAMING_CASE` for defs objects.
* Comments explain *why*, not what. Keep them sparse.
* Language: code/comments in English, player-facing text in German (i18n later).

## Milestone status

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Setup, renderer, post-FX, test room, FPS controller (full movement) | in progress |
| 2 | Weapons (3), viewmodel, recoil, hit feedback, decals, particles | – |
| 3 | Enemy AI + navmesh, 3 enemy types, wave spawner, game over → vertical slice | – |
| 4 | Economy: points, wall buys, doors, mystery box, perks, power-ups | – |
| 5 | All weapons, attachments, Rift Forge, elemental mods | – |
| 6 | All enemies, elite affixes, spawn director, bosses | – |
| 7 | Remaining maps, traps, events, easter eggs | – |
| 8 | All modes incl. roguelite cards + daily challenge | – |
| 9 | Meta progression, skill tree, achievements, cosmetics, stats | – |
| 10 | Audio polish, dynamic music | – |
| 11 | UI polish, settings, accessibility | – |
| 12 | Performance pass, balancing, bugfixing, production build | – |

## Decisions (log)

* **TypeScript 6.0** instead of 7.x: typescript-eslint supports `<6.1`; TS 7 (native) would drop lint support.
* **WebGL2 only for now.** pmndrs/postprocessing and our ShaderMaterial/onBeforeCompile effects are WebGL-only;
  WebGPURenderer would need a parallel TSL pipeline. The spec marks WebGPU optional → deferred, factory prepared.
* **Assets are fetched, not committed:** `npm run assets` downloads CC0 assets; without them the game uses
  GPU-generated procedural PBR textures and a procedural environment, so a fresh clone always runs.
* **Fixed 60 Hz simulation** with interpolation; mouse look per frame.
* **Rapier KinematicCharacterController** for the player (capsule), custom Source-style accel/friction on top.
