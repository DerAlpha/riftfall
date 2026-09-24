# Map kit – guide for map builders (M7)

One map = **one directory** `src/maps/<id>/` (+ nothing else). The kit, the registry, the interactables,
traps, events, the quest system and the music read everything from your level instance. Never edit a
shared table (`defs/interactables.ts`, `defs/workshop.ts`, `defs/traps.ts`, `defs/mapEvents.ts`,
`defs/quests.ts`, `defs/maps.ts`, `registry.ts`): the lab and the calibration hall use those tables, your
map uses its own data. Reference for quality: the research lab (`src/maps/lab`, `defs/labLayout.ts`).

Ids reserved for you: `arctic`, `biodome`, `reactor`, `orbital`, `rift` (music themes, quest achievements
`quest_<id>`, leaderboards and loadouts key on them). Player-facing text is German.

## 1. What the directory exports

`src/maps/<id>/index.ts` already exists as a stub: `export const <ID>_MAP: MapEntry | null = null;`
Replace the null with a `MapEntry` (`import type { MapEntry } from '../kit'`):

```ts
export const ARCTIC_MAP: MapEntry | null = {
  id: 'arctic', // === atmosphere.id (the registry rejects a mismatch)
  name: 'Arktis-Station',
  description: 'Ein Satz für die Kartenauswahl.',
  atmosphere: ARCTIC_ATMOSPHERE, // MapAtmosphereDef, defined in your directory
  build: buildArcticStation, // LevelBuilder: (ctx) => Promise<MapLevelInstance>
  recommended: false, // only the lab is recommended
  waves: true,
};
```

The registry lists every non-null entry; the start screen shows it; `?map=arctic` boots it. Keep all map
data (layout numbers, variants, placements) in your directory, e.g. `layout.ts` (the lab's
`defs/labLayout.ts` is the only map layout that lives in `defs/`).

## 2. The level instance (`MapLevelInstance`, `src/maps/types.ts`)

Required (wave map): `id`, `atmosphere`, `root` (Group, added to the scene by Game), `spawn`
(`{ position, yaw }`), `spawnPoints` (rifts: `{ id, position, yaw, zone, kind: 'rift'|'vent'|'floor' }`),
`navSources` (the meshes the navmesh is built from), `zones` (`{ id, name }`), `doorSlots`,
`wallBuySlots`, `hasVolumetricContent`, `zoneAt(x, z)`, `update(dt, time)`, `stats`, `dispose()`.

Optional M7 fields – **provide them all**; each falls back to a per-map table only for the old maps:

| field                              | what                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startZones`                       | zones open at the run start (else every zone would open – gating lost)                                                                            |
| `perkSpots`                        | `PerkMachinePlacementDef[]` – wall-face point at floor level + facing (+ `perk` to pin); 16 perks → 16 spots                                      |
| `boxLocations`, `boxStartIds`      | Rift-Kiste floor centers + front facing; start candidates (empty = any)                                                                           |
| `wallBuySlots`                     | `WallBuySlotDef[]`: board center on the wall face, facing, zone, `weaponHint` (the weapon sold), `costHint`                                       |
| `doorSlots`                        | `DoorSlotDef[]`: bottom center of the passage, facing zoneA → zoneB, width/height/depth, `costHint`, `blast`                                      |
| `forgePlacement`, `benchPlacement` | Rift Forge / Werkbank (`WorkshopPlacementDef`: wall-face point behind the machine); `null` = none                                                 |
| `trapSlots`                        | `TrapSlotDef[]` (§6)                                                                                                                              |
| `eventDefs`, `generators`          | map events + generator spots (§7)                                                                                                                 |
| `gravityZones`                     | permanent low/high-g boxes / spheres (§8, orbital)                                                                                                |
| `questDef`                         | the easter egg (§9); `null` = none                                                                                                                |
| `bossArena`                        | `{ center, radius, zone }` – open floor for M6 bosses (else derived from the start zone's rifts)                                                  |
| `musicTheme`                       | defs/music `mapThemes` key; default = the map id (themes for all five ids exist)                                                                  |
| `lightGroups`                      | dimmable lights for the power outage (else collected: lights, `level:emissive_*` meshes, `VolumetricCone`s; red = emergency, violet = rift, kept) |
| `poweredObjects`                   | level props that go dark in an outage (monitors, signs)                                                                                           |
| `sunCasterBounds`                  | box the sun reaches (enemy shadow cascades skip the rest); null = everywhere                                                                      |

Placement conventions (maps are axis-aligned): wall-mounted things give the point **on the wall face**
and `facing` = the interior direction (`'px'|'nx'|'pz'|'nz'`); free-standing things give the floor
center. Keep machines ≥ 1.2 m apart and their use anchors reachable on the navmesh (copy the lab's
`interactables/placements.test.ts` / `workshopPlacement.test.ts` for your map – they build the real
level in node and check overlap, zones and reachability).

## 3. Geometry: LevelKit

`new LevelKit({ physics, materials, name, setupMaterial })` (`src/world/LevelKit.ts`, re-exported by
`maps/kit`): `floor`, `wall`, `pillar`, `platform`, `catwalk`, `ramp`, `stairs`, `railing`, `door`
(frames), `screen`, `ventSlits`, `pipe`, `crate`, `box`, `prism`, `cylinder`, `marking`, `spotFixture`,
`pointLight`; then `kit.build()` merges every material bucket into **one draw call** with a BVH, and
colliders are created immediately. `WallFrame` converts face-local boxes to world boxes.

- **Bullets:** only meshes named `level:<materialId>[:noshadow]` or `panel:<materialId>` stop bullets,
  decals and line of sight (LevelKit names its batches that way). Anything built otherwise (glTF, own
  meshes) must follow the rule or bullets pass through what the player collides with.
- **Nav sources:** hand `navSources` = the `level:` meshes minus ceilings/roofs/lantern tops (set
  `mesh.userData.navIgnore = true` on those: islands otherwise) – see `flagNavSources` in
  `lab/ResearchLab.ts`. Props of the kit, the interactables and traps are never nav sources.
- **Materials:** base ids from `defs/materials.ts` (`floor_concrete`, `concrete_wall`, `floor_panel`,
  `diamond_plate`, `floor_grate`, `wall_panel`, `wall_panel_dark`, `trim_metal`, `painted_hazard`,
  `pillar_metal`, `rubber`, `crate`, `pipe`, `glass`, `screen`, `emissive_cyan|orange|red|white`).
  Variants `<base>#<name>` (tint, roughness, metalness, env, emissive, opacity, `navIgnore`) come from
  **your own table** through `KitMaterials` (`maps/kit/KitMaterials.ts`); call `materials.update()` in
  `level.update`. Preload every id you use (`materials.preload(ids)`) before building.
- **Emissive = light:** bloom is an HDR threshold; emissive panels need intensity ≥ ~4 to glow. Keep the
  red / violet / other color families: the power outage keeps red (emergency) and violet (rift) lights.
- **Props that are not level geometry** (your own animated machines): build them with `PropBuilder`
  (`maps/kit/PropBuilder.ts`, one merged mesh per material, `prop:` names, navIgnore) in their own group,
  never under `level.root` if they move.

## 4. Atmosphere, lights, audio

- `MapAtmosphereDef` (`defs/maps.ts` type, your instance in your dir): `grading` (the procedural LUT:
  exposure, contrast, saturation, lift/gamma/gain, split toning, temperature/tint – this is the map's
  color identity), `fog` (height fog density/falloff/noise, sun scatter – keep `sunScatterStrength` low
  indoors), `environment` (HDRI id from the asset manifest or `null` + procedural fallback colors, IBL
  intensity ~0.1–0.3: light comes from fixtures), `sun` (direction, color, intensity, shadows),
  `hemi`, `reverb` (`'small'|'medium'|'large'|'hangar'`), `preload` (asset ids – they must exist in
  `assets/manifest.ts`; the registry test checks it).
- Lights: `kit.spotFixture` (shadowPriority → the QUALITY_LEVELS local-shadow budget, staggered
  refresh) and `kit.pointLight` (never shadowed). Never add or remove lights after load (every lit
  shader recompiles); animate intensities / colors only.
- Volumetrics: `VolumetricCone` / `VolumetricShafts` / `DustParticles` (`render/vfx`), fog volumes – see
  the lab. Everything additive goes on `RENDER.volumetricLayer`; report it via `hasVolumetricContent`.
- Music: themes for all five ids exist (`defs/music.ts` `mapThemes`); `musicTheme` overrides.

## 5. Performance budget (per map, 'high' preset, SwiftShader-verified)

- Level draw calls ≤ 120 (lab ≈ 68): merge per material, instance repeated props, flicker panels only
  where they flicker. Trap/quest/event props add ~2–4 draws per trap.
- Level lights ≤ 16 (spots + points); VFX adds its pool (`VFX.lights.count`) – total ≤ 20.
- Local shadow casters: mark ≤ 6 spots with `shadowPriority` (the preset decides how many cast).
- Triangles ≤ ~400 k for the static level; no per-frame allocation in `update`; test boot time.

## 6. Traps (`defs/traps.ts` types, `src/traps`)

`trapSlots: TrapSlotDef[]`, each `{ id, kind, zone, panel: { position, facing } (wall face), price?,
duration?, cooldown? }` plus by kind:

- `fence`: `a`, `b` floor points of the two posts across a corridor (≤ 5 m), `height?` – stuns + shocks
  enemies crossing, hurts the player; does not block the navmesh.
- `turret`: `position` (ceiling underside or floor), `mount: 'ceiling'|'floor'`, `yawDeg` (rest / sweep
  center), `range?` – targets the nearest enemy in LOS, hitscan bursts.
- `fan`: `position` (rotor hub on the wall face / floor), `facing` (intake direction, `'up'` = floor
  shaft), `radius?`, `reach?` – pulls enemies in front of it and shreds them; the housing is solid.
- `flame`: `position` (floor grate center), `height?`, `radius?` – pulsed fire column.

Place panels within reach of the trap but out of its damage area; 1–3 traps per map; test with
`trap list` / `trap activate <id|all>`.

## 7. Map events (`defs/mapEvents.ts`)

`eventDefs: MapEventDef[]` with `trigger: { minWave, maxWave?, chance, waves?, questStep?,
cooldownWaves, delay: [min, max] }` and by kind:

- `powerOutage` (`generators?` ids): lights → emergency red, machines dark and refusing, restored by
  holding interact at a generator in an **open** zone (no open generator → never starts). Provide
  `generators: [{ id, position (wall face, floor level), facing, zone }]` – one near the start zone.
- `invasion`: `count { base, perWave, max }`, `types [{ type, weight, minWave? }]`, `spread` s.
- `gravityAnomaly`: `points [{ position, zone }]` (open floor ≥ radius), `radius`, `scale`, `duration`.

Rolled events never overlap; the intermission stays calm. Test: `event list | trigger <id> | stop`.

## 8. Gravity zones (orbital)

`gravityZones: [{ id, shape: 'box', min, max, scale, feather? } | { id, shape: 'sphere', center,
radius, scale, feather? }]`. The player (jump launch speed unchanged → low g jumps higher, falls slower)
and arsenal projectiles / grenades sample the scale per tick; enemies walk the navmesh unaffected.
Overlaps multiply; `feather` blends the border. Visuals of the zones are yours. Debug: `gravity show`.

## 9. Quest / easter egg (`defs/quests.ts`)

`questDef: { id, name, steps, rewards, achievement: 'quest_<mapId>', rewardText }` – steps `shoot`
(hidden targets on surfaces), `collect` (carry an item), `interact` (objects, `requires` the carried
item; `style: 'socket'|'console'`), `kill` (count, volume / zone / element / weapon / enemy), `defend`
(point, radius, duration, grace, decay), `trap` (activate traps). Rewards: `weapon` (given directly),
`perk` (free), `points`. Hints are cues (flicker, hums, glows) – no UI text before the reward. An event
with `trigger.questStep: '<stepId>'` starts with that step (the lab's invasion during the defend step).
Test: `quest status | step | complete`. The achievement `quest_<id>` already exists (hidden).

## 10. Checklist

1. `index.ts` exports the entry; `npm run check` passes; `?map=<id>&autostart` boots without errors.
2. Copy the lab's placement / nav tests for your map (spawn points on the navmesh, interactables free
   and reachable, doors gate zones, `zoneAt` covers every walkable rect).
3. Screenshots with `node tools/photo.mjs --map <id>`; walk every zone (noclip), check fog / LUT / bloom.
4. `trap activate all`, `event trigger …`, `quest complete`, a full wave with `wave <n>`.
