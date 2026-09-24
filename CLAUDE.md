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
| `npm run smoke:waves`                                                                                  | Wave scenario on the research lab (build must exist): waves, enemies, kills, wave complete, game over    |
| `node tools/photo.mjs --preset ultra [--hud] [--spots '[[x,y,z,yaw,pitch]]'] [--exec '["noclip on"]']` | Art-direction screenshots (build must exist)                                                             |

URL parameters (dev/testing): `?map=lab|testroom` map to build (else the last played / recommended map),
`?autostart` skip start screen, `?nolock` play without pointer lock,
`?preset=low|medium|high|ultra` session-only preset, `?smoke` expose `window.__RIFTFALL__` in production builds.

## Architecture

```
src/
  main.ts            entry (no three/postfx/Rapier imports): WebGL2 probe, loading screen, dynamic
                     Game import, fatal error screen; index.html adds a no-JS notice + boot watchdog
  game/Game.ts       composition root – constructs every system, wires events, owns the GameLoop
  game/              PauseController (pause/pointer-lock/visibility/console state machine),
                     GamePersistence (save wiring, session-only ?preset=, resetsave),
                     MenuPadNavigator (gamepad D-pad/A/B menu navigation), devCommands,
                     fixedTick (the fixed-tick order, see below)
  core/              engine-agnostic building blocks (no three.js imports except contracts.ts)
    contracts.ts     ALL public system interfaces (RenderApi, PhysicsApi, InputApi, …) – read this first
    events.ts        GameEvents map for the typed EventBus
    EventBus.ts      typed pub/sub, isolates throwing handlers
    GameLoop.ts      fixed-timestep loop (60 Hz sim) + interpolated rendering, timeScale, pause, fps limit
    Rng.ts           seeded sfc32 RNG (daily challenge determinism) – never Math.random() for gameplay
    Pool.ts          generic object pool (for projectiles/enemies; still unused – VFX pools are
                     preallocated typed-array buffers/rings, AudioEngine keeps its own voice free list)
    math.ts          damp/spring/noise/ring buffer helpers
    log.ts           tagged logger with history (dev console / debug overlay)
  defs/              ALL balancing & tuning data (no magic numbers in systems): weapons, combat,
                     viewmodels, vfx, targets, … (weapons.ts: every weapon is data, no per-id code)
  input/             InputSystem (keyboard/mouse/gamepad → Actions, rebinding, pointer lock)
  physics/           PhysicsWorld (Rapier wrapper, collision groups, raycasts, interpolated props)
  player/            PlayerController (movement state machine on Rapier KCC), PlayerCamera (look, bob,
                     shake, recoil kicks, FOV), ViewmodelRig (own scene/camera/FOV, sway, bob, sockets)
  weapons/           WeaponSystem (inventory, state machine, hitscan + penetration, reload, ADS, melee,
                     inspect, switching), recoil/spread/damage/aimAssist math, resolveWeapon (Rift Forge
                     tier, attachments, element → effective def), ViewmodelAnimator (procedural kicks,
                     reloads, inspect, equip)
    viewmodels/      procedural weapon models (registry by weapon id, sockets muzzle/ejectPort/sight)
  combat/            CombatWorld (hit resolution: BVH static meshes, analytic hitboxes, Rapier props;
                     damage + combat:* events), hitMath (ray vs sphere/capsule)
  vfx/               VfxSystem + VfxBridge (event → VFX): GPU instanced particles, decal ring, tracers,
                     casings (cheap CPU physics, raycast bounces), pooled flash lights, muzzle flash,
                     screen-space shockwave effect
  nav/               NavSystem (NavApi): worker-built tiled recast navmesh, detour crowd (throttled,
                     round-robin move requests), allocation-free queries, DirectSteering fallback
  enemies/           EnemyManager (pooled Damageable enemies, AI brains per type, attack-slot tokens,
                     flanking, spitter cover/LOS, tank charge/slam, knockback, stuck recovery),
                     render/ EnemyRenderer (one InstancedMesh per type, rig table interpreted by the
                     vertex shader AND poseMath → hitboxes match the drawn pose), types.ts contract
  spawning/          WaveDirector (classic wave formula, spawn point scoring in active zones, intermissions)
  stats/             StatSystem (StatsApi: player stat table defs/stats.ts, add/mul modifiers by source),
                     weaponStats (stat → effective weapon def)
  economy/           EconomySystem (points, spend/earn, multiplier), PointsRules (hit/kill/headshot/melee/
                     wave/repair points, no dummy or flagged dev-spawn rewards), PerkSystem + perkHooks
                     (16 perks in defs/perks.ts: stat modifiers + event hooks, Phoenix self revive)
  interactables/     InteractionSystem (focus: range + view cone + LOS, press/hold), ZoneSystem, Door (nav
                     area blocking + bullet blocker), WallBuy, MysteryBox ("Rift-Kiste"), PerkMachine,
                     placeInteractables (per-map placement), visuals/ (holograms, doors, machines, box)
  seals/             rift seals at wave-map spawn points (enemies breach bar by bar, hold F repairs)
  powerups/          PowerUpSystem (drops from kills, pooled pickups, timed effects), PickupView
  modes/             RunFlow (run lifecycle, death sequence, game over), RunStats, death camera
  maps/              registry (MAP_REGISTRY: testroom, lab), lab/ research lab builder (zones, door and
                     wall-buy slots for M4, spawn rifts, fog volumes), MapLevelInstance extras
  render/            RenderSystem (renderer, scenes, cameras), QualityManager, Environment, CSM shadows
    postfx/          PostFX pipeline (N8AO, bloom, DoF, motion blur, height fog, shockwave, CA, grading
                     LUT, grain, SMAA)
    materials/       GPU procedural PBR texture generator + MaterialLibrary (asset textures override),
                     dissolve (noise dissolve patch for dying targets/enemies)
    vfx/             volumetric light cones, dust particles (GPU/instanced) – level atmosphere only
  world/             level module kit (batched geometry + colliders), level builders (TestRoom),
                     TrainingTargets (calibration-hall dummies: rails, shields, weakpoints)
  assets/            manifest, loader (glTF+Draco/Meshopt, KTX2, HDR), placeholder system
  audio/             AudioEngine (buses, ducking, reverb zones, HRTF), procedural synth fallbacks,
                     weaponSynth (procedural gunshots/impacts/casings/hit sounds), AudioEventBridge
  save/              SaveSystem (IndexedDB → localStorage → memory), migrations, SettingsStore
  ui/                DOM HUD (hud/: crosshair, WeaponHud ammo/slots, CombatHud hitmarker/damage
                     numbers/kill confirmation), debug overlay (F3), dev console (^), Preact menus,
                     loading screen
```

### Frame / tick flow

```
rAF → GameLoop.advance(dt)
  ├─ beginFrame (every frame, also paused): input.beginFrame (poll pads, compute edges)
  │     → pauseState.onFrame (pause binding opens/closes the pause menu)
  │     → padNav.update (menus open: D-pad/A/B) → playerCamera.applyLook (unpaused: mouse/stick look
  │       through the weapon LookModifier: ADS sensitivity, gamepad-only aim assist)
  ├─ fixedUpdate (60 Hz, 0..maxSubSteps times, unpaused) – game/fixedTick.ts:
  │     player.fixedUpdate (samples input, latches edges once per frame) → interaction (focus, press/
  │     hold: a purchase's give() is handled this tick) → weapons.fixedUpdate (fire, reload, melee: shots
  │     resolve NOW) → targets → waves → enemies.fixedUpdate (AI, nav.update – the crowd steps INSIDE
  │     the manager –, renderer commitTick) → interactables (doors, box) → powerUps (pickups, timers)
  │     → kill plane → physics.step → health → perks (hook cooldowns) → level → runFlow
  ├─ update (per frame, unpaused): player.update (latches edges of frames without a tick, ADS, eye)
  │     → interaction.update (once-per-frame press latch) → weapons.update (ADS blend, recoil
  │     counter-pull) → playerCamera.update (bob/roll/shake/recoil/FOV incl. ADS zoom/DoF) → viewmodel
  │     (sway, bob, animator) → vfx.update (flashes, casings, tracers at this frame's sockets)
  │     → interactables/seals/powerUps visuals → render.advanceWorldTime (shockwaves)
  │     → level.update → targets.update(alpha) → audio listener + sun probe → HUD (crosshair cone
  │     projected with this frame's FOV)
  └─ render (every frame): physics.syncVisuals(alpha) → render.render → quality.onFrame (unpaused only)
        → debug overlay → input.endFrame
```

- Simulation state (positions, velocities) only changes in `fixedUpdate`. Visuals interpolate with `alpha`.
- **Shots resolve against the previous tick's hitboxes**: weapons tick before targets/enemies. The last
  rendered frame showed damageables at lerp(prev, cur, alpha), so their hitboxes lead the visible model by
  (1 − alpha) ticks; stepping them before the weapons would add a full tick (cm-scale misses on moving
  weakpoints/heads). New damageables tick after `weapons.fixedUpdate` and before `physics.step`
  (kinematic moves must land in the same step); `fixedTick.test.ts` guards the order.
- Hitscan starts at the rendered camera (`render.camera.position`, incl. the movement-driven view pitch):
  the player hits what the crosshair shows. Tracers/flashes start at the muzzle socket as displayed.
- `weapons.update` runs before `playerCamera.update` (the camera reads this frame's ADS blend, recoil and
  FOV multiplier); `vfx.update` runs after the viewmodel (muzzle flashes, casings and player tracers are
  queued in the tick and resolved at the sockets the player sees this frame).
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
RenderPass(world)                                 (incl. decals, casings, training targets)
  → N8AO                                          (off: pass absent)
  → EffectPass[MotionBlur?, HeightFog]            (world-space; MB is a convolution → first)
  → EffectPass[Shockwave]                         (explosion UV distortion; own pass, enabled only
                                                   while a wave runs)
  → Volumetrics                                   (RENDER.volumetricLayer: level cones/shafts/dust +
                                                   VFX particles/tracers + target barriers; always
                                                   present, enabled while any of them draws)
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
  VFX particles/tracers and the targets' energy barriers share that layer (not darkened by AO, drawn
  after the shockwave so fireballs stay undistorted); `render.setVolumetricContentProbe` tells the
  pass when they draw, so it costs nothing while the layer is empty.
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
| 2   | Weapons (3), viewmodel, recoil, hit feedback, decals, particles             | done   |
| 3   | Enemy AI + navmesh, 3 enemy types, wave spawner, game over → vertical slice | done   |
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
- **Hit resolution (M2, CombatWorld):** static level meshes are hit through three-mesh-bvh on the rendered
  triangles (exact surface, material → surface/penetrable); damageables through analytic sphere/capsule
  hitboxes behind a bounds-sphere broadphase; dynamic props through Rapier (the collider is authoritative,
  the mesh is interpolated; shots push them, they get no world-space decals). **Only meshes named
  `level:<materialId>[:noshadow]` or `panel:<materialId>` (`COMBAT.staticMeshPrefixes`) stop
  bullets** – LevelKit names its batches that way; geometry built any other way (e.g. a glTF map) must
  follow the rule, or bullets, decals and line of sight pass through what the player collides with.
- **Shots resolve against the previous tick's hitboxes** (weapons tick before targets/enemies, see
  Frame / tick flow) and **start at the rendered camera** (WYSIWYG, incl. landing dip / mantle pitch).
- **Reused payloads and hits:** hot-path event payloads (`weapon:fired`/`ammoChanged`,
  `combat:impact`/`tracer`/`damage`/`kill`, shake, pulse), `CombatHit` and `RaycastHit` are shared
  objects. Handlers copy what they keep and read everything before emitting or raycasting again (a nested
  raycast rewrites the shared hit).
- **Weapons are data:** `defs/weapons.ts` + `resolveWeapon` (Rift Forge tier, attachments, element → one
  effective def) drive fire modes, recoil patterns, spread, ADS, reload markers, VFX and audio ids;
  WeaponSystem, ViewmodelAnimator, VFX and audio never branch on a weapon id. New viewmodels register a
  builder in `weapons/viewmodels/index.ts`.
- **Viewmodel:** own scene + camera (own FOV) drawn after the world effects; procedural models and
  procedural animation (springs + time-based curves, no keyframe assets); gamepad aim assist only
  applies while the gamepad is the active device (`controls.aimAssist`).
- **VFX are pooled up front at max quality capacity** (particle buffers, instanced decal ring, tracers,
  casings) and quality only changes the used capacity. **Flash lights are a constant pool**
  (`VFX.lights.count` PointLights at intensity 0, + one in the viewmodel scene): three keys programs on the
  light count, so lights are never added/removed at runtime. VFX is therefore built **before
  `render.applyAtmosphere()`**, so the atmosphere warm-up compiles the world for the final light count once.
- **Shader warm-up with a render target bound:** the world and the viewmodel are only drawn into the post
  chain's targets, and three keys programs on the output color space (canvas sRGB vs working space), so
  `renderer.compile` runs with a 1×1 target bound (Game `compileForPostChain`, `ViewmodelRig.warmupWeapons`);
  `vfx.warmup()` then renders one invisible composer frame with every VFX draw active. The loadout is
  handed out (`weapons.setLoadout`) only after every weapon-event listener exists.
- **Weapon audio is procedural** (`audio/weaponSynth.ts`, rendered once per sample rate and cached);
  real assets registered under the same ids override it. AudioEventBridge maps weapon/combat events to it.
- **Hit feedback:** hitmarker, damage numbers (toggleable: `gameplay.damageNumbers`/`hitmarkers`), kill
  confirmation, trauma screen shake (`camera:shake`, scaled by `accessibility.screenShake`) and
  explosion hit pulses (`fx:hitPulse`, scaled by `reduceFlashing`).

- **Maps switch by reload (M3):** every system holds level state (nav, combat, spawn points, targets), so the
  start screen's map choice is stored (`localStorage riftfall.lastMap`) and applied with `?map=` + reload.
  Without a choice the recommended map (research lab) boots.
- **Navigation (M3):** tiled recast navmesh (9.6 m tiles) built in a Web Worker (main-thread fallback),
  voxel-aligned floor heights, eroded for the medium agent (0.4 m); walkable() = snap tolerance + slope +
  layer-checked 2D raycast; a rebuild keeps the old navmesh live until the swap; recast fails → DirectSteering.
- **Enemies (M3):** one InstancedMesh per type from procedural parts; a packed rig table is interpreted
  identically by the vertex shader and `poseMath` (hitboxes follow the drawn pose); one program for all
  types compiled in `EnemyRenderer.warmup`. AI: per-target melee token pools (light 3 / heavy 1), per-kind
  attack spacing, lobbed acid flattens under probed ceilings, the player is a parked crowd agent.
- **Run flow (M3):** RunFlow owns the run (begin/restart/abandon), the death slow motion (real time) and
  the game over screen; `run:restart` resets enemies, waves, VFX, health, loadout and position.

- **Economy (M4):** every player modifier is a `StatModifier` on the StatSystem (perks `perk:<id>`,
  power-ups `powerup:<id>`, later skills/cards); consumers re-read stats on their next tick/frame/damage
  call, so removing a source restores the exact previous value. Points only for player damage, per enemy
  kind (`EnemyTypeDef.points`: swarmer = CoD 10/60/100, melee +70; tank kill 250); nuke kills pay nothing
  each (the power-up pays a flat bonus); dev-console spawns pay and drop nothing; repairs are capped per
  wave; `economy/pacing.test.ts` guards the wave 1–10 rhythm (a door per wave, box ~3–4, perk ~4–6). The
  calibration hall starts with `ECONOMY.sandboxStartPoints`. Only Phoenix is lost on a revive (its fire
  burst goes off on the next perk tick). Perk blasts (Nova, Kinetik, Phoenix) do not use the frag
  explosion: an effect straight below the first-person camera must not use smoke or big billboards (a quad
  centered there sits at the near plane and veils the screen), so they play a small center effect (light,
  shake, floor sparks) plus a ring of bursts around the player (`perk.*` presets, `PerkBlastDef.fx`).
  `run kill` uses `health.kill()` (bypasses revives and damage stats).
- **Doors block the navmesh (M4):** NavSystem.setAreaBlocked regenerates the tiles under a door box once
  (the doorway gets its own polygons), then blocking is an instant poly-flag toggle that queries and the
  crowd filter respect; blocked areas are re-applied after a rebuild. Perk machines and box spots are
  blocked the same way. CombatWorld cannot remove static meshes, so opened doors park their bullet
  blocker far below the world. Interactable props live in their own scene group, never under level.root.
- **Pad X** is shared by reload and interact: WeaponSystem skips reload presses while an interaction is
  offered and the gamepad is the active device (`setReloadSuppressor`).

## Known limitations / next steps

- Only verified on SwiftShader (headless); real-GPU frame times on the High preset still need a pass (M12 budget).
- Weapons are procedural models; unknown viewmodel ids fall back to the placeholder device. Only hitscan
  fire is implemented: projectile/launcher kinds are refused (M5), so explosions are reachable only via the
  dev console `explode`. `WeaponSystem.setWeaponMods` (Rift Forge / attachments / elements) is wired to
  nothing in gameplay yet (M5).
- `core/Pool.ts` is still unused (M5 projectiles are its first candidate).
- KTX2 path is implemented but untested with real files (`toktx` not available when fetching); textures ship as JPG.
- Height-fog sun glow is not shadowed (indoors it relies on low `sunScatterStrength`); shafts come from the level.
- Tanks share the medium-agent navmesh (may clip corners); no off-mesh links (no leaps onto platforms).
- Doors and seals rely on the navmesh: with the DirectSteering fallback enemies ignore closed doors.
- Next: **Milestone 5** – all weapons (≥24, projectile/beam/charge kinds), attachments, Rift Forge tiers,
  elemental mods + status effects, grenades, abilities.
