/**
 * Room modules of the research lab: reception (desk, wall-buy board), atrium (catwalk ring,
 * stairs, ramp, containment dais with emitter pylons, roof with the glass lantern), glass lab
 * cubicles with specimen tanks, server racks, cryo pods, loading dock, pipes. Geometry only –
 * lights, volumetrics and the rift VFX are set up by ResearchLab.ts.
 */
import * as THREE from 'three';
import { DEG2RAD } from '../../core/math';
import { LAB_LAYOUT, type LabBoxDef, type LabCubicleDef, type LabTankDef } from '../../defs/labLayout';
import { LEVEL_KIT, type Facing, type RectDef } from '../../defs/level';
import { WallFrame, type LevelKit } from '../../world/LevelKit';
import { runForSlope, stairsLayout, subtractIntervals, subtractRects } from '../../world/kitMath';
import { expandRect } from './labSpaces';

const L = LAB_LAYOUT;
const T = L.wallThickness;
const DECAL = LEVEL_KIT.decal;
const TRIM = LEVEL_KIT.trim;
const _up = new THREE.Vector3(0, 1, 0);
/** Layout coordinates closer than this are the same line (m). */
const WALL_EPS = 1e-4;

function spaceCeiling(id: string): number {
  return L.spaces.find((s) => s.id === id)?.ceiling ?? L.spaces[0]!.ceiling;
}

/** Atrium ring stairs (rise = deck height). */
export function atriumStairs(): ReturnType<typeof stairsLayout> {
  return stairsLayout(L.atrium.ring.deckY, LEVEL_KIT.stairs.maxStepRise, LEVEL_KIT.stairs.stepRun);
}

export function atriumRampRun(): number {
  return runForSlope(L.atrium.ring.deckY, L.atrium.ramp.slopeDeg);
}

export function dockRampRun(): number {
  return runForSlope(L.dock.platform.height, L.dock.ramp.slopeDeg);
}

/** Stairs footprint (x/z rect) of an atrium stair flight. */
export function atriumStairsRect(s: (typeof L.atrium.stairs)[number]): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  const run = atriumStairs().totalRun;
  const z0 = s.dir > 0 ? s.topZ - run : s.topZ;
  const z1 = s.dir > 0 ? s.topZ : s.topZ + run;
  return { minX: s.minX, maxX: s.maxX, minZ: z0, maxZ: z1 };
}

/** Box with a trim top and an optional glowing edge (desks, planters, benches). */
function furnitureBlock(
  kit: LevelKit,
  b: LabBoxDef,
  body: string,
  top: string,
  glow: { material: string; faces: readonly Facing[] } | null,
): void {
  const topH = TRIM.capHeight;
  kit.boxMinMax(body, { x: b.minX, y: 0, z: b.minZ }, { x: b.maxX, y: b.height - topH, z: b.maxZ });
  kit.boxMinMax(
    top,
    { x: b.minX - TRIM.capOverhang, y: b.height - topH, z: b.minZ - TRIM.capOverhang },
    { x: b.maxX + TRIM.capOverhang, y: b.height, z: b.maxZ + TRIM.capOverhang },
  );
  if (!glow) return;
  const y = b.height - topH - L.reception.deskGlow.drop;
  const gh = L.reception.deskGlow.height;
  for (const face of glow.faces) {
    const alongX = face === 'pz' || face === 'nz';
    const len = (alongX ? b.maxX - b.minX : b.maxZ - b.minZ) - TRIM.stripInset * 4;
    const x =
      face === 'px' ? b.maxX + DECAL.offset : face === 'nx' ? b.minX - DECAL.offset : (b.minX + b.maxX) / 2;
    const z =
      face === 'pz' ? b.maxZ + DECAL.offset : face === 'nz' ? b.minZ - DECAL.offset : (b.minZ + b.maxZ) / 2;
    kit.box(
      glow.material,
      { x, y, z },
      { x: alongX ? len : DECAL.thickness, y: gh, z: alongX ? DECAL.thickness : len },
      { collider: false, castShadow: false },
    );
  }
}

// ---------------------------------------------------------------------------
// Reception
// ---------------------------------------------------------------------------

export function buildReception(kit: LevelKit): void {
  const R = L.reception;
  furnitureBlock(kit, R.desk, 'wall_panel#white', 'trim_metal', {
    material: 'emissive_cyan',
    faces: ['nz', 'pz', 'px'],
  });
  for (const p of R.planters) planter(kit, p);
  for (const s of R.screens) {
    kit.screen({
      position: { x: s.position[0], y: s.position[1], z: s.position[2] },
      facing: s.facing,
      width: s.width,
      height: s.height,
      screen: 'screen',
      bezel: 'trim_metal',
    });
  }
  const h = spaceCeiling('reception');
  for (const [x, z] of R.pillars) {
    kit.pillar({
      x,
      z,
      y0: 0,
      height: h,
      size: R.pillarSize,
      material: 'wall_panel#white',
      trim: 'trim_metal',
      band: 'emissive_cyan',
      bands: R.pillarBands,
    });
  }
  // The wall-buy board at L.reception.wallBuy is built by the M4 interactables (WallBuyView).
}

function planter(kit: LevelKit, p: LabBoxDef): void {
  furnitureBlock(kit, p, 'wall_panel_dark#clinical', 'trim_metal', null);
  // Soil bed and a soft green grow-light strip around the rim.
  const i = L.reception.foliageInset;
  kit.boxMinMax(
    'rubber',
    { x: p.minX + i, y: p.height, z: p.minZ + i },
    { x: p.maxX - i, y: p.height + DECAL.thickness, z: p.maxZ - i },
    { collider: false, castShadow: false },
  );
  const g = L.reception.growLight;
  kit.boxMinMax(
    'emissive_cyan#fluid',
    { x: p.minX + g.inset, y: p.height, z: p.minZ + g.inset },
    { x: p.maxX - g.inset, y: p.height + g.height, z: p.maxZ - g.inset },
    { collider: false, castShadow: false },
  );
}

// ---------------------------------------------------------------------------
// Atrium
// ---------------------------------------------------------------------------

export function buildAtrium(kit: LevelKit): void {
  buildRing(kit);
  buildAtriumAccess(kit);
  buildDais(kit);
  buildRoof(kit);
  const A = L.atrium;
  for (const p of A.planters) planter(kit, p);
  for (const s of A.screens) {
    kit.screen({
      position: { x: s.position[0], y: s.position[1], z: s.position[2] },
      facing: s.facing,
      width: s.width,
      height: s.height,
      screen: 'screen',
      bezel: 'trim_metal',
    });
  }
  buildAtriumWallLines(kit);
}

const ATRIUM = L.spaces.find((s) => s.id === 'atrium')!.rects[0]!;

function ringInner(): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const w = L.atrium.ring.width;
  return { minX: ATRIUM.minX + w, maxX: ATRIUM.maxX - w, minZ: ATRIUM.minZ + w, maxZ: ATRIUM.maxZ - w };
}

function buildRing(kit: LevelKit): void {
  const R = L.atrium.ring;
  const top = R.deckY;
  const bottom = top - R.thickness;
  const I = ringInner();
  const A = ATRIUM;
  const decks = [
    { minX: A.minX, maxX: A.maxX, minZ: A.minZ, maxZ: I.minZ },
    { minX: A.minX, maxX: A.maxX, minZ: I.maxZ, maxZ: A.maxZ },
    { minX: A.minX, maxX: I.minX, minZ: I.minZ, maxZ: I.maxZ },
    { minX: I.maxX, maxX: A.maxX, minZ: I.minZ, maxZ: I.maxZ },
  ];
  for (const d of decks)
    kit.boxMinMax('floor_grate', { x: d.minX, y: bottom, z: d.minZ }, { x: d.maxX, y: top, z: d.maxZ });

  // Fascia + underglow along the inner edge.
  const fh = R.fasciaHeight;
  const fd = R.fasciaDepth;
  const edges: { facing: Facing; x: number; z: number; len: number }[] = [
    { facing: 'pz', x: (I.minX + I.maxX) / 2, z: I.minZ, len: I.maxX - I.minX },
    { facing: 'nz', x: (I.minX + I.maxX) / 2, z: I.maxZ, len: I.maxX - I.minX },
    { facing: 'px', x: I.minX, z: (I.minZ + I.maxZ) / 2, len: I.maxZ - I.minZ },
    { facing: 'nx', x: I.maxX, z: (I.minZ + I.maxZ) / 2, len: I.maxZ - I.minZ },
  ];
  for (const e of edges) {
    const f = new WallFrame({ x: e.x, y: top, z: e.z }, e.facing);
    kit.box('trim_metal', f.point(0, -fh / 2 + DECAL.offset, fd / 2), f.size(e.len + fd * 2, fh, fd), {
      collider: false,
    });
    kit.box(
      'emissive_cyan',
      f.point(0, -fh + R.underglow.height, fd + DECAL.offset),
      f.size(e.len - R.underglow.margin * 2, R.underglow.height, DECAL.thickness),
      { collider: false, castShadow: false },
    );
  }

  for (const [x, z] of R.supports) {
    kit.box('pillar_metal', { x, y: bottom / 2, z }, { x: R.supportSize, y: bottom, z: R.supportSize });
    const cs = R.supportSize + R.supportCap.extra * 2;
    kit.box(
      'trim_metal',
      { x, y: bottom - R.supportCap.height / 2, z },
      { x: cs, y: R.supportCap.height, z: cs },
      {
        collider: false,
      },
    );
  }

  // Inner railings with gaps where the stairs and the ramp arrive.
  const inset = LEVEL_KIT.railing.edgeInset;
  const gaps = { n: [] as [number, number][], s: [] as [number, number][], w: [] as [number, number][] };
  for (const s of L.atrium.stairs) (s.dir > 0 ? gaps.s : gaps.n).push([s.minX, s.maxX]);
  gaps.w.push([L.atrium.ramp.minZ, L.atrium.ramp.maxZ]);
  for (const [s0, s1] of subtractIntervals(I.minX, I.maxX, gaps.n))
    kit.railing({ x: s0, y: top, z: I.minZ - inset }, { x: s1, y: top, z: I.minZ - inset });
  for (const [s0, s1] of subtractIntervals(I.minX, I.maxX, gaps.s))
    kit.railing({ x: s0, y: top, z: I.maxZ + inset }, { x: s1, y: top, z: I.maxZ + inset });
  for (const [s0, s1] of subtractIntervals(I.minZ, I.maxZ, gaps.w))
    kit.railing({ x: I.minX - inset, y: top, z: s0 }, { x: I.minX - inset, y: top, z: s1 });
  kit.railing({ x: I.maxX + inset, y: top, z: I.minZ }, { x: I.maxX + inset, y: top, z: I.maxZ });
}

function buildAtriumAccess(kit: LevelKit): void {
  const layout = atriumStairs();
  const top = L.atrium.ring.deckY;
  const sw = LEVEL_KIT.stairs.stringerWidth;
  for (const s of L.atrium.stairs) {
    const width = s.maxX - s.minX;
    const cx = (s.minX + s.maxX) / 2;
    // kit.stairs rise towards local -Z; yaw π turns them to rise towards +Z.
    const bottomZ = s.topZ + (s.dir > 0 ? -layout.totalRun : layout.totalRun);
    kit.stairs({
      material: 'diamond_plate',
      stringer: 'trim_metal',
      bottomCenter: { x: cx, y: 0, z: bottomZ },
      width,
      steps: layout.steps,
      stepRise: layout.stepRise,
      stepRun: layout.stepRun,
      yaw: s.dir > 0 ? Math.PI : 0,
    });
    const topRail = s.topZ - s.dir * layout.stepRun;
    for (const x of [s.minX - sw / 2, s.maxX + sw / 2]) {
      kit.railing({ x, y: 0, z: bottomZ }, { x, y: top, z: topRail });
    }
  }
  const r = L.atrium.ramp;
  const run = atriumRampRun();
  const width = r.maxZ - r.minZ;
  kit.ramp({
    material: 'diamond_plate',
    center: { x: r.topX + run / 2, y: 0, z: (r.minZ + r.maxZ) / 2 },
    width,
    run,
    rise: top,
    // Rises towards -X.
    yaw: Math.PI / 2,
    edgeTrim: 'painted_hazard',
  });
  const inset = LEVEL_KIT.railing.edgeInset;
  for (const z of [r.minZ + inset, r.maxZ - inset]) {
    kit.railing({ x: r.topX + run, y: 0, z }, { x: r.topX, y: top, z });
  }
}

function buildDais(kit: LevelKit): void {
  const D = L.atrium.dais;
  kit.platform({
    minX: D.minX,
    maxX: D.maxX,
    minZ: D.minZ,
    maxZ: D.maxZ,
    top: D.height,
    side: 'wall_panel_dark#clinical',
    topMaterial: 'floor_panel#gloss',
    edgeStrip: { material: 'emissive_red#violet', faces: ['px', 'nx', 'pz', 'nz'], drop: 0.08, height: 0.04 },
  });
  // Hazard border and the glowing containment ring on the dais.
  const y = D.height;
  const hw = D.hazardWidth;
  kit.marking('painted_hazard', D.minX, D.minZ, D.maxX, D.minZ + hw, y);
  kit.marking('painted_hazard', D.minX, D.maxZ - hw, D.maxX, D.maxZ, y);
  kit.marking('painted_hazard', D.minX, D.minZ + hw, D.minX + hw, D.maxZ - hw, y);
  kit.marking('painted_hazard', D.maxX - hw, D.minZ + hw, D.maxX, D.maxZ - hw, y);
  const i = D.ringInset;
  const rw = D.ringWidth;
  kit.marking('emissive_red#violet', D.minX + i, D.minZ + i, D.maxX - i, D.minZ + i + rw, y);
  kit.marking('emissive_red#violet', D.minX + i, D.maxZ - i - rw, D.maxX - i, D.maxZ - i, y);
  kit.marking('emissive_red#violet', D.minX + i, D.minZ + i + rw, D.minX + i + rw, D.maxZ - i - rw, y);
  kit.marking('emissive_red#violet', D.maxX - i - rw, D.minZ + i + rw, D.maxX - i, D.maxZ - i - rw, y);

  // Emitter pylons leaning their heads towards the anomaly.
  const P = L.atrium.pylons;
  const rift = L.atrium.rift.position;
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  for (const [x, z] of P.positions) {
    const s = P.size;
    kit.box('pillar_metal', { x, y: y + P.height / 2, z }, { x: s, y: P.height, z: s });
    const cap = s + P.capExtra;
    kit.box(
      'trim_metal',
      { x, y: y + TRIM.capHeight, z },
      { x: cap, y: TRIM.capHeight * 2, z: cap },
      {
        collider: false,
      },
    );
    const band = s + P.bandExtra;
    for (const by of P.bands) {
      kit.box(
        'emissive_red#violet',
        { x, y: y + by, z },
        { x: band, y: LEVEL_KIT.pillar.bandHeight, z: band },
        {
          collider: false,
          castShadow: false,
        },
      );
    }
    const topY = y + P.height;
    const hx = rift[0] - x;
    const hz = rift[2] - z;
    const hl = Math.hypot(hx, hz) || 1;
    const tilt = P.headTiltDeg * DEG2RAD;
    dir.set((hx / hl) * Math.sin(tilt), Math.cos(tilt), (hz / hl) * Math.sin(tilt));
    q.setFromUnitVectors(_up, dir);
    const [hsx, hsy, hsz] = P.headSize;
    kit.box(
      'pillar_metal',
      { x: x + dir.x * (hsy / 2), y: topY + dir.y * (hsy / 2), z: z + dir.z * (hsy / 2) },
      { x: hsx, y: hsy, z: hsz },
      { rotation: q.clone(), collider: false },
    );
    const tip = P.tipHeight;
    kit.box(
      'emissive_red#violet',
      { x: x + dir.x * (hsy + tip / 2), y: topY + dir.y * (hsy + tip / 2), z: z + dir.z * (hsy + tip / 2) },
      { x: hsx * P.tipScale, y: tip, z: hsz * P.tipScale },
      { rotation: q.clone(), collider: false, castShadow: false },
    );
  }
}

function buildRoof(kit: LevelKit): void {
  const A = L.atrium;
  const S = A.skylight;
  const h = spaceCeiling('atrium');
  const rt = A.roofThickness;
  const outer = expandRect(ATRIUM, T);
  const hole = { minX: S.minX, maxX: S.maxX, minZ: S.minZ, maxZ: S.maxZ };
  for (const r of subtractRects(outer, [hole])) {
    kit.boxMinMax('concrete_wall#roof', { x: r.minX, y: h, z: r.minZ }, { x: r.maxX, y: h + rt, z: r.maxZ });
  }
  // Steel mullion grid in the opening (casts the striped sun pattern).
  const m = S.mullion;
  const md = S.mullionDepth;
  const pw = (S.maxX - S.minX) / S.panes[0];
  const pd = (S.maxZ - S.minZ) / S.panes[1];
  for (let i = 0; i <= S.panes[0]; i++) {
    const x = S.minX + i * pw;
    kit.box(
      'pillar_metal',
      { x, y: h + md / 2, z: (S.minZ + S.maxZ) / 2 },
      { x: m, y: md, z: S.maxZ - S.minZ },
      { collider: false },
    );
  }
  for (let k = 0; k <= S.panes[1]; k++) {
    const z = S.minZ + k * pd;
    kit.box(
      'pillar_metal',
      { x: (S.minX + S.maxX) / 2, y: h + md / 2, z },
      { x: S.maxX - S.minX, y: md, z: m },
      { collider: false },
    );
  }
  // Glass lantern: vertical glazing around the opening, a glass top and corner posts.
  const y0 = h + rt;
  const lh = S.lanternHeight;
  const gt = S.glassThickness;
  const cx = (S.minX + S.maxX) / 2;
  const cz = (S.minZ + S.maxZ) / 2;
  const w = S.maxX - S.minX;
  const d = S.maxZ - S.minZ;
  const glass = { collider: false, castShadow: false };
  const pane = 'glass#lantern';
  kit.box(pane, { x: cx, y: y0 + lh / 2, z: S.minZ }, { x: w, y: lh, z: gt }, glass);
  kit.box(pane, { x: cx, y: y0 + lh / 2, z: S.maxZ }, { x: w, y: lh, z: gt }, glass);
  kit.box(pane, { x: S.minX, y: y0 + lh / 2, z: cz }, { x: gt, y: lh, z: d }, glass);
  kit.box(pane, { x: S.maxX, y: y0 + lh / 2, z: cz }, { x: gt, y: lh, z: d }, glass);
  kit.box(pane, { x: cx, y: y0 + lh, z: cz }, { x: w, y: gt, z: d }, glass);
  for (const px of [S.minX, S.maxX]) {
    for (const pz of [S.minZ, S.maxZ]) {
      kit.box('pillar_metal', { x: px, y: y0 + lh / 2, z: pz }, { x: m, y: lh, z: m }, { collider: false });
    }
  }
  const rib = m * S.ribScale;
  for (let i = 0; i <= S.panes[0]; i++) {
    kit.box(
      'trim_metal',
      { x: S.minX + i * pw, y: y0 + lh + gt, z: cz },
      { x: rib, y: rib, z: d },
      { collider: false },
    );
  }
  for (let k = 0; k <= S.panes[1]; k++) {
    kit.box(
      'trim_metal',
      { x: cx, y: y0 + lh + gt, z: S.minZ + k * pd },
      { x: w, y: rib, z: rib },
      { collider: false },
    );
  }
  // Night sky glow above the lantern (never casts: it would block the sun shafts).
  const sm = S.skyMargin;
  kit.box(
    'emissive_white#sky',
    { x: cx, y: y0 + lh + S.skyLift, z: cz },
    { x: w + sm * 2, y: gt, z: d + sm * 2 },
    { collider: false, castShadow: false },
  );
}

function buildAtriumWallLines(kit: LevelKit): void {
  const W = L.atrium.wallLines;
  const A = ATRIUM;
  const h = W.y1 - W.y0;
  const sides: { facing: Facing; fixed: number; from: number; to: number; along: 'x' | 'z' }[] = [
    { facing: 'pz', fixed: A.minZ, from: A.minX, to: A.maxX, along: 'x' },
    { facing: 'nz', fixed: A.maxZ, from: A.minX, to: A.maxX, along: 'x' },
    { facing: 'px', fixed: A.minX, from: A.minZ, to: A.maxZ, along: 'z' },
    { facing: 'nx', fixed: A.maxX, from: A.minZ, to: A.maxZ, along: 'z' },
  ];
  for (const s of sides) {
    const blocked: [number, number][] = [];
    for (const sc of L.atrium.screens) {
      if (sc.facing !== s.facing) continue;
      const c = s.along === 'x' ? sc.position[0] : sc.position[2];
      blocked.push([c - sc.width / 2 - W.width * 4, c + sc.width / 2 + W.width * 4]);
    }
    for (let t = s.from + W.margin; t <= s.to - W.margin + 1e-6; t += W.spacing) {
      if (blocked.some(([b0, b1]) => t > b0 && t < b1)) continue;
      const origin = s.along === 'x' ? { x: t, y: 0, z: s.fixed } : { x: s.fixed, y: 0, z: t };
      const f = new WallFrame(origin, s.facing);
      kit.box('emissive_cyan', f.point(0, W.y0 + h / 2, DECAL.offset), f.size(W.width, h, DECAL.thickness), {
        collider: false,
        castShadow: false,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Labs
// ---------------------------------------------------------------------------

export function buildLabs(kit: LevelKit): void {
  const B = L.labs;
  const h = spaceCeiling('labs');
  const labs = L.spaces.find((s) => s.id === 'labs')!.rects[0]!;
  for (const c of B.cubicles) cubicle(kit, c, h, labs);
  for (const t of B.tanks) tank(kit, t, h);
  for (const b of B.benches) {
    furnitureBlock(kit, b, 'wall_panel#white', 'trim_metal', null);
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const alongX = b.maxX - b.minX > b.maxZ - b.minZ;
    const sc = B.benchScreen;
    kit.box(
      'screen',
      { x: cx, y: b.height + sc.lift + sc.height / 2, z: cz },
      alongX ? { x: sc.width, y: sc.height, z: sc.depth } : { x: sc.depth, y: sc.height, z: sc.width },
      { collider: false, uv: 'face' },
    );
  }
  // Glowing guide line down the aisle.
  const aisleX = (L.labs.cubicles[0]!.maxX + L.labs.cubicles[2]!.minX) / 2;
  const A = B.aisleLine;
  kit.marking(
    'emissive_cyan',
    aisleX - A.halfWidth,
    labs.minZ + A.startMargin,
    aisleX + A.halfWidth,
    labs.maxZ - A.endMargin,
    0,
  );
}

function cubicle(kit: LevelKit, c: LabCubicleDef, h: number, room: RectDef): void {
  const P = L.labs.partition;
  const t = P.thickness;
  // Solid side partitions (full height, from the room wall to the front). A side on the room wall
  // is that wall: a partition there would put its face on the wall face (z-fighting).
  if (c.minZ > room.minZ + WALL_EPS)
    kit.boxMinMax('wall_panel#white', { x: c.minX, y: 0, z: c.minZ - t }, { x: c.maxX, y: h, z: c.minZ });
  if (c.maxZ < room.maxZ - WALL_EPS)
    kit.boxMinMax('wall_panel#white', { x: c.minX, y: 0, z: c.maxZ }, { x: c.maxX, y: h, z: c.maxZ + t });
  // Glass front with the opening.
  const x0 = c.front === 'px' ? c.maxX - t : c.minX;
  const x1 = x0 + t;
  const xc = (x0 + x1) / 2;
  const open: [number, number] = [c.opening - c.openingWidth / 2, c.opening + c.openingWidth / 2];
  for (const [z0, z1] of subtractIntervals(c.minZ - t, c.maxZ + t, [open])) {
    const zl = z1 - z0;
    const zc = (z0 + z1) / 2;
    kit.box(
      'wall_panel_dark#clinical',
      { x: xc, y: P.glassBottom / 2, z: zc },
      { x: t, y: P.glassBottom, z: zl },
      { collider: false },
    );
    kit.box(
      'glass',
      { x: xc, y: (P.glassBottom + P.glassTop) / 2, z: zc },
      { x: P.glassThickness, y: P.glassTop - P.glassBottom, z: zl },
      {
        collider: false,
      },
    );
    kit.staticBox({ x: xc, y: P.glassTop / 2, z: zc }, { x: t, y: P.glassTop, z: zl }, undefined, 'glass');
    const n = Math.max(1, Math.round(zl / P.mullionSpacing));
    for (let i = 0; i <= n; i++) {
      kit.box(
        'trim_metal',
        { x: xc, y: (P.glassBottom + P.glassTop) / 2, z: z0 + (zl * i) / n },
        { x: t + P.mullionExtra, y: P.glassTop - P.glassBottom, z: P.mullionWidth },
        { collider: false },
      );
    }
    kit.box(
      'trim_metal',
      { x: xc, y: P.glassBottom, z: zc },
      { x: t + P.sillExtra, y: TRIM.capHeight, z: zl },
      { collider: false },
    );
  }
  // Header above the glass (and the opening) up to the ceiling.
  kit.boxMinMax('wall_panel#white', { x: x0, y: P.glassTop, z: c.minZ - t }, { x: x1, y: h, z: c.maxZ + t });
  const me = P.mullionExtra;
  kit.boxMinMax(
    'trim_metal',
    { x: x0 - me, y: P.glassTop - TRIM.capHeight, z: c.minZ - t },
    { x: x1 + me, y: P.glassTop, z: c.maxZ + t },
    {
      collider: false,
    },
  );
  // Cyan status strip over the opening.
  const sx = c.front === 'px' ? x1 + DECAL.offset : x0 - DECAL.offset;
  kit.box(
    'emissive_cyan',
    { x: sx, y: P.glassTop + P.statusLift, z: c.opening },
    { x: DECAL.thickness, y: P.statusHeight, z: c.openingWidth },
    { collider: false, castShadow: false },
  );
}

/** Specimen tank: metal base, glass cylinder with glowing fluid, cap and a feed pipe to the ceiling. */
function tank(kit: LevelKit, t: LabTankDef, ceiling: number): void {
  const K = L.labs.tank;
  const r = t.radius;
  const at = (y: number): { x: number; y: number; z: number } => ({ x: t.x, y, z: t.z });
  kit.cylinder('trim_metal', at(0), at(K.baseHeight), r + K.rimExtra, { collider: true });
  kit.cylinder('glass#tank', at(K.baseHeight), at(t.height - K.capHeight), r, {
    collider: true,
    castShadow: false,
  });
  kit.cylinder(
    'emissive_cyan#fluid',
    at(K.baseHeight + K.fluidLift),
    at(t.height - K.capHeight - K.fluidTopGap),
    r - K.fluidInset,
    {
      castShadow: false,
    },
  );
  kit.cylinder('trim_metal', at(t.height - K.capHeight), at(t.height), r + K.rimExtra);
  kit.cylinder('pipe', at(t.height), at(ceiling), K.pipeRadius);
}

// ---------------------------------------------------------------------------
// Server room
// ---------------------------------------------------------------------------

export function buildServer(kit: LevelKit): void {
  const S = L.server;
  const h = spaceCeiling('server');
  const d = S.rackDepth;
  for (const z of S.rows) {
    for (const [x0, x1] of S.blocks) {
      kit.boxMinMax(
        'wall_panel_dark',
        { x: x0, y: 0, z: z - d / 2 },
        { x: x1, y: S.rackHeight, z: z + d / 2 },
      );
      const co = S.capOverhang;
      kit.boxMinMax(
        'trim_metal',
        { x: x0 - co, y: S.rackHeight, z: z - d / 2 - co },
        { x: x1 + co, y: S.rackHeight + TRIM.capHeight, z: z + d / 2 + co },
        { collider: false },
      );
      const n = Math.max(1, Math.round((x1 - x0) / S.cabinetWidth));
      const cw = (x1 - x0) / n;
      for (const side of [-1, 1]) {
        const zf = z + side * (d / 2 + DECAL.offset);
        for (let i = 0; i <= n; i++) {
          kit.box(
            'trim_metal',
            { x: x0 + i * cw, y: S.rackHeight / 2, z: zf },
            { x: S.dividerWidth, y: S.rackHeight, z: DECAL.thickness * 2 },
            {
              collider: false,
            },
          );
        }
        for (const y of S.ledStrips) {
          kit.box(
            'emissive_cyan#led',
            { x: (x0 + x1) / 2, y, z: zf },
            { x: x1 - x0 - S.ledMargin * 2, y: S.ledHeight, z: DECAL.thickness },
            { collider: false, castShadow: false },
          );
        }
      }
      // Cable tray above the row with hangers to the ceiling.
      kit.box(
        'floor_grate',
        { x: (x0 + x1) / 2, y: S.trayY, z },
        { x: x1 - x0, y: S.trayHeight, z: S.trayWidth },
        { collider: false },
      );
      for (const hx of [x0 + S.hangerInset, x1 - S.hangerInset]) {
        kit.box(
          'trim_metal',
          { x: hx, y: (S.trayY + h) / 2, z },
          { x: S.hangerSize, y: h - S.trayY, z: S.hangerSize },
          {
            collider: false,
          },
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cryo storage
// ---------------------------------------------------------------------------

export function buildCryo(kit: LevelKit): void {
  const C = L.cryo;
  const P = C.pod;
  const h = spaceCeiling('cryo');
  for (const x of C.podX) {
    for (const z of C.podZ) {
      const at = (y: number): { x: number; y: number; z: number } => ({ x, y, z });
      kit.cylinder('trim_metal', at(0), at(P.baseHeight), P.radius + P.rimExtra, { collider: true });
      kit.cylinder(
        'emissive_cyan',
        at(P.baseHeight),
        at(P.baseHeight + P.glowHeight),
        P.radius + P.glowExtra,
        {
          castShadow: false,
        },
      );
      kit.cylinder('glass#frost', at(P.baseHeight + P.glowHeight), at(P.height - P.capHeight), P.radius, {
        collider: true,
        castShadow: false,
      });
      // Frozen occupant (dark silhouette behind the frost).
      kit.cylinder(
        'wall_panel_dark',
        at(P.baseHeight + P.glowHeight),
        at(P.baseHeight + P.bodyHeight),
        P.bodyRadius,
      );
      kit.cylinder('trim_metal', at(P.height - P.capHeight), at(P.height), P.radius + P.rimExtra);
      kit.cylinder('pipe', at(P.height), at(h), P.pipeRadius);
    }
  }
}

// ---------------------------------------------------------------------------
// Loading dock
// ---------------------------------------------------------------------------

export function buildDock(kit: LevelKit): void {
  const D = L.dock;
  const P = D.platform;
  kit.platform({
    minX: P.minX,
    maxX: P.maxX,
    minZ: P.minZ,
    maxZ: P.maxZ,
    top: P.height,
    side: 'wall_panel_dark',
    topMaterial: 'diamond_plate',
    edgeStrip: { material: 'emissive_orange', faces: ['pz'], drop: 0.06, height: 0.05 },
  });
  kit.marking('painted_hazard', P.minX, P.maxZ, D.ramp.minX, P.maxZ + P.hazardDepth, 0);
  const run = dockRampRun();
  kit.ramp({
    material: 'diamond_plate',
    center: { x: (D.ramp.minX + D.ramp.maxX) / 2, y: 0, z: P.maxZ + run / 2 },
    width: D.ramp.maxX - D.ramp.minX,
    run,
    rise: P.height,
    yaw: 0,
    edgeTrim: 'painted_hazard',
  });

  // Shutter door on the north wall above the platform: slats in a hazard frame.
  const S = D.shutter;
  const face = P.minZ;
  const bottom = P.height;
  const pitch = S.slat + S.gap;
  const n = Math.floor((S.top - bottom) / pitch);
  const w = S.maxX - S.minX;
  const cx = (S.minX + S.maxX) / 2;
  for (let i = 0; i < n; i++) {
    const y = bottom + i * pitch + S.slat / 2;
    kit.box(
      'trim_metal',
      { x: cx, y, z: face + S.depth / 2 },
      { x: w, y: S.slat, z: S.depth },
      { collider: false },
    );
  }
  kit.staticBox(
    { x: cx, y: (bottom + S.top) / 2, z: face + S.depth / 2 },
    { x: w, y: S.top - bottom, z: S.depth },
    undefined,
    'metal',
  );
  for (const side of [-1, 1]) {
    kit.box(
      'painted_hazard',
      { x: cx + side * (w / 2 + S.frame / 2), y: (bottom + S.top + S.frame) / 2, z: face + S.depth },
      { x: S.frame, y: S.top + S.frame - bottom, z: S.depth * 2 },
    );
  }
  kit.box(
    'painted_hazard',
    { x: cx, y: S.top + S.frame / 2, z: face + S.depth },
    { x: w + S.frame * 2, y: S.frame, z: S.depth * 2 },
  );
  const al = S.alarm;
  kit.box(
    'emissive_red',
    { x: cx, y: S.top + S.frame + al.lift + al.size[1] / 2, z: face + al.offset },
    { x: al.size[0], y: al.size[1], z: al.size[2] },
    { collider: false, castShadow: false },
  );

  for (const c of D.crates) {
    kit.crate({
      material: 'crate',
      center: { x: c.position[0], y: c.position[1], z: c.position[2] },
      size: c.size,
      yaw: c.yawDeg * DEG2RAD,
      dynamic: c.dynamic,
    });
  }
  const dock = L.spaces.find((s) => s.id === 'dock')!.rects[0]!;
  const [bw, bh] = D.crane.size;
  for (const z of D.crane.beams) {
    kit.box(
      'pillar_metal',
      { x: (dock.minX + dock.maxX) / 2, y: D.crane.y, z },
      { x: dock.maxX - dock.minX, y: bh, z: bw },
      {
        collider: false,
      },
    );
  }
  for (const [x, z] of D.bollards) {
    kit.cylinder('painted_hazard', { x, y: 0, z }, { x, y: D.bollard.height, z }, D.bollard.radius, {
      collider: true,
    });
  }
}

export function buildPipes(kit: LevelKit): void {
  for (const p of L.pipes) {
    kit.pipe({
      from: { x: p.from[0], y: p.from[1], z: p.from[2] },
      to: { x: p.to[0], y: p.to[1], z: p.to[2] },
      radius: p.radius,
      material: 'pipe',
      bracket: 'trim_metal',
      supportSpacing: L.pipeSupportSpacing,
      wall: p.wall,
      flangeSpacing: L.pipeFlangeSpacing,
    });
  }
}
