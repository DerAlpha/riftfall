/**
 * „Riss-Zerreißer“ – wonder weapon, void ray (M5). Model content (meters, model space: origin =
 * grip pivot, barrel along −Z). Organic rift-tech: an iridescent chitin carapace ribbed like a
 * spine, magenta light breathing between the vertebrae, gold inlays; at the front two mandibles
 * hold a vertical tear in reality open (it flares wide on every shot – the model animates it). A
 * void shard glows in a gold cage on the shooter-facing flank. Parts: prongs → prongL / prongR
 * (the mandibles, snap open per shot), cell (the shard), trigger, sight (a ring of four claws
 * around a floating mote). Eight rune LEDs along the left top.
 */
import { BoxGeometry, SphereGeometry, TorusGeometry } from 'three';
import { RIFTRIPPER_VIEWMODEL } from '../../../defs/viewmodelData/riftripper';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import { cylinderZ, profileX, roundedBox } from '../shapes';
import { createReadout, ledUv, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import {
  EnergyWeaponModel,
  bentTube,
  createChitinMaterial,
  createEnergyMaterial,
  crystalZ,
  freeParts,
  smoothOutline,
  type ExtraAnimator,
} from './energyKit';

const BORE_Y = 0.05;
/** Sight line: center of the claw ring. */
const SIGHT_Y = 0.12;
const GRIP_TILT = -20;
const GRIP_TOP = { y: 0.006, z: 0.014 } as const;
const LEDS = 8;
const JAW_Z = -0.2;
const RIFT = { z: -0.36, h: 0.046 } as const;
const CELL = { x: -0.043, y: 0.05, z: -0.1 } as const;
/** Rift breathing and its flare when fired (model content). */
const MOTION = { breatheRate: 2.3, breathe: 0.12, flare: 1.8, flareTime: 0.35 } as const;

const RIFT_COLOR = {
  core: 0xffe0f8,
  rim: 0xff2fd0,
  accent: 0xff3ad8,
  sight: 0xff7ae6,
  deep: 0x8a10ff,
} as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = RIFTRIPPER_VIEWMODEL;
  if (!def) throw new Error('riftripper: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(RIFT_COLOR.sight, readout?.texture ?? null, def.glow);
  glow.accent.emissive.set(RIFT_COLOR.accent);
  const chitin = createChitinMaterial('riftripper', 0x100816, 0x7a2470);
  const rift = createEnergyMaterial('rift-tear', {
    core: RIFT_COLOR.core,
    rim: RIFT_COLOR.rim,
    rimPower: 0.9,
    noise: 1,
    noiseScale: 240,
    flow: [0, 6, -2],
    additive: true,
  });
  const riftHalo = createEnergyMaterial('rift-halo', {
    core: RIFT_COLOR.deep,
    rim: RIFT_COLOR.rim,
    rimPower: 0.7,
    noise: 1,
    noiseScale: 120,
    flow: [0, -3, 1],
    additive: true,
  });
  const veins = createEnergyMaterial('rift-veins', {
    core: 0xff9cec,
    rim: RIFT_COLOR.rim,
    rimPower: 1.2,
    noise: 0.8,
    noiseScale: 200,
    flow: [0, 0, -2],
  });
  const shard = createEnergyMaterial('rift-shard', {
    core: 0xffc8f4,
    rim: 0xb01cff,
    rimPower: 1.4,
    noise: 0.7,
    noiseScale: 260,
    flow: [0.5, 1.5, -1],
  });
  const b = new ModelBuilder('riftripper', VIEWMODEL_ART.uvDensity);

  b.part('prongs', [0, BORE_Y, JAW_Z]);
  b.part('prongL', [-0.022, BORE_Y, JAW_Z], { parent: 'prongs' });
  b.part('prongR', [0.022, BORE_Y, JAW_Z], { parent: 'prongs' });
  b.part('riftTear', [0, BORE_Y, RIFT.z]);
  b.part('cell', [CELL.x, CELL.y, CELL.z]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('sight', [0, 0.09, -0.02]);

  // --- carapace ---
  b.add(
    BODY,
    'chitin',
    profileX(
      smoothOutline(
        [
          [-0.105, 0.03],
          [-0.085, 0.05],
          [-0.03, 0.074],
          [0.04, 0.088],
          [0.12, 0.086],
          [0.19, 0.074],
          [0.222, 0.06],
          [0.228, 0.042],
          [0.2, 0.026],
          [0.1, 0.012],
          [0.0, 0.006],
          [-0.06, 0.006],
          [-0.1, 0.016],
        ],
        4,
      ),
      0.054,
      { bevel: 0.006, bevelSegments: 3 },
    ),
  );
  // Vertebrae along the whole spine (following the carapace's top line), light breathing between
  // them, gold inlays on every other one.
  const SPINE: readonly (readonly [number, number])[] = [
    [0.075, 0.056],
    [0.03, 0.074],
    [-0.04, 0.088],
    [-0.12, 0.086],
    [-0.19, 0.074],
  ];
  const topAt = (z: number): number => {
    for (let k = 0; k + 1 < SPINE.length; k++) {
      const [z0, y0] = SPINE[k]!;
      const [z1, y1] = SPINE[k + 1]!;
      if (z <= z0 && z >= z1) return y0 + ((z - z0) / (z1 - z0)) * (y1 - y0);
    }
    return SPINE[SPINE.length - 1]![1];
  };
  for (let i = 0; i < 10; i++) {
    const z = 0.066 - i * 0.025;
    const top = topAt(z);
    const r = Math.min(0.03, top - 0.03);
    b.add(BODY, 'chitin', new TorusGeometry(r, 0.0058, 8, 20, Math.PI), { pos: [0, top - r, z] });
    if (i % 2 === 0) {
      b.add(BODY, 'brass', new TorusGeometry(r, 0.0017, 6, 20, Math.PI), {
        pos: [0, top - r, z - 0.0055],
        paint: 0.9,
      });
    }
    if (i < 9) {
      const zm = z - 0.0125;
      const tm = topAt(zm);
      b.add(BODY, 'veins', roundedBox(0.026, 0.002, 0.011, 0.0008), { pos: [0, tm + 0.0005, zm] });
      b.add(BODY, 'veins', roundedBox(0.002, 0.016, 0.011, 0.0008), { pos: [-0.0275, tm - 0.024, zm] });
    }
  }
  // Membrane windows on the left flank: void fluid glowing behind translucent chitin.
  for (const [z, len] of [
    [0.03, 0.05],
    [-0.035, 0.04],
  ] as const) {
    b.add(BODY, 'veins', new SphereGeometry(0.012, 16, 10), {
      pos: [-0.0262, 0.045, z],
      scale: [0.25, 1, len / 0.024],
    });
    b.add(BODY, 'lens', new SphereGeometry(0.0135, 16, 10), {
      pos: [-0.0268, 0.045, z],
      scale: [0.3, 1, len / 0.024],
      uv: 'keep',
    });
    b.add(BODY, 'brass', new TorusGeometry(0.0135, 0.0012, 6, 24), {
      pos: [-0.0282, 0.045, z],
      rot: [0, 90, 0],
      scale: [1, 1, len / 0.024],
      paint: 0.9,
    });
  }
  // Rune LEDs along the left top edge.
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0042, 0.0042, 0.0012), {
      pos: [-0.0232, 0.0785, 0.07 - i * 0.0105],
      rot: [0, -58, 45],
      uv: ledUv(LEDS - 1 - i, LEDS),
    });
  }
  // Jaw root: a gold collar the mandibles grow from.
  b.add(BODY, 'brass', new TorusGeometry(0.026, 0.004, 8, 28), {
    pos: [0, BORE_Y, JAW_Z + 0.012],
    paint: 0.9,
  });
  b.add(BODY, 'chitin', new SphereGeometry(0.026, 20, 14), {
    pos: [0, BORE_Y, JAW_Z + 0.02],
    scale: [1, 1, 0.8],
  });
  b.add(BODY, 'veins', cylinderZ(0.006, 0.006, 0.004, 14), { pos: [0, BORE_Y, JAW_Z - 0.001] });

  // --- mandibles: flattened curved blades, glowing inner edges, bone spikes ---
  for (const [part, side] of [
    ['prongL', -1],
    ['prongR', 1],
  ] as const) {
    const root: [number, number, number] = [side * 0.022, BORE_Y, JAW_Z];
    const rel = (x: number, y: number, z: number): [number, number, number] => [
      side * x - root[0],
      y - root[1],
      z - root[2],
    ];
    const blade = [
      rel(0.022, BORE_Y, JAW_Z),
      rel(0.056, BORE_Y + 0.006, JAW_Z - 0.06),
      rel(0.062, BORE_Y + 0.003, JAW_Z - 0.13),
      rel(0.042, BORE_Y, RIFT.z - 0.03),
      rel(0.012, BORE_Y - 0.003, RIFT.z - 0.066),
    ];
    b.add(part, 'chitin', bentTube(blade, 0.0078, 34, 10), { pos: root, scale: [1, 2.4, 1] });
    const edge = blade.map(([x, y, z]): [number, number, number] => [x - side * 0.0068, y, z]);
    b.add(part, 'veins', bentTube(edge.slice(1), 0.0017, 24, 6), { pos: root, scale: [1, 5.5, 1] });
    for (const [x, z, len] of [
      [0.054, JAW_Z - 0.045, 0.034],
      [0.061, JAW_Z - 0.09, 0.042],
      [0.061, JAW_Z - 0.135, 0.034],
      [0.05, RIFT.z - 0.02, 0.024],
    ] as const) {
      b.add(part, 'chitin', crystalZ(0.0048, len, 5), {
        pos: [side * x, BORE_Y + 0.008, z],
        rot: [-14, side * -122, 0],
      });
    }
    for (const z of [JAW_Z - 0.035, JAW_Z - 0.1]) {
      b.add(part, 'brass', new TorusGeometry(0.0095, 0.002, 6, 16), {
        pos: [side * (z > JAW_Z - 0.05 ? 0.05 : 0.061), BORE_Y + 0.004, z],
        rot: [0, side * 24, 0],
        paint: 0.9,
      });
    }
  }

  // --- the rift: a vertical tear (breathes; flares on shots) ---
  b.add('riftTear', 'rift', new SphereGeometry(RIFT.h, 24, 18), {
    pos: [0, BORE_Y, RIFT.z],
    scale: [0.16, 1, 0.1],
    uv: 'keep',
  });
  b.add('riftTear', 'riftHalo', new SphereGeometry(RIFT.h * 1.25, 24, 18), {
    pos: [0, BORE_Y, RIFT.z],
    scale: [0.42, 1, 0.3],
    uv: 'keep',
  });

  // --- void shard in its gold cage (left flank) ---
  b.add(BODY, 'chitin', roundedBox(0.006, 0.03, 0.1, 0.002), { pos: [-0.029, CELL.y, CELL.z], paint: 0.6 });
  for (const z of [CELL.z + 0.046, CELL.z - 0.046]) {
    b.add(BODY, 'brass', new TorusGeometry(0.013, 0.0022, 6, 18), { pos: [CELL.x, CELL.y, z], paint: 0.9 });
  }
  for (const a of [100, 180, 260]) {
    const r = (a * Math.PI) / 180;
    b.add(BODY, 'brass', cylinderZ(0.0014, 0.0014, 0.092, 6), {
      pos: [CELL.x + Math.cos(r) * 0.013, CELL.y + Math.sin(r) * 0.013, CELL.z],
      paint: 0.9,
    });
  }
  b.add('cell', 'shard', crystalZ(0.0095, 0.084, 6), {
    pos: [CELL.x, CELL.y, CELL.z + 0.042],
    rot: [0, 0, 15],
  });
  b.add('cell', 'brass', cylinderZ(0.006, 0.006, 0.008, 12), {
    pos: [CELL.x, CELL.y, CELL.z + 0.045],
    paint: 0.9,
  });

  // --- grip, trigger claw ---
  b.add(BODY, 'chitin', roundedBox(0.032, 0.108, 0.044, 0.012, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
  });
  for (let i = 0; i < 3; i++) {
    b.add(BODY, 'brass', roundedBox(0.0335, 0.004, 0.045, 0.0015), {
      pos: gripAxis(0.03 + i * 0.03),
      rot: [GRIP_TILT, 0, 0],
      paint: 0.9,
    });
  }
  b.add(
    BODY,
    'chitin',
    profileX(
      smoothOutline(
        [
          [0.0, 0.008],
          [0.07, 0.01],
          [0.07, -0.016],
          [0.05, -0.03],
          [0.012, -0.03],
          [0.0, -0.018],
        ],
        3,
      ),
      0.01,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.012, -0.004],
            [0.058, -0.004],
            [0.056, -0.018],
            [0.046, -0.024],
            [0.016, -0.024],
          ],
        ],
      },
    ),
  );
  b.add(
    'trigger',
    'brass',
    profileX(
      [
        [0.03, 0.004],
        [0.037, 0.004],
        [0.036, -0.01],
        [0.03, -0.02],
        [0.026, -0.021],
        [0.031, -0.01],
      ],
      0.005,
      { bevel: 0.0008 },
    ),
    { paint: 0.9 },
  );

  // --- claw-ring sight ---
  b.add('sight', 'chitin', roundedBox(0.012, SIGHT_Y - 0.098, 0.014, 0.003), {
    pos: [0, (SIGHT_Y + 0.08) / 2 - 0.004, -0.02],
  });
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    b.add(
      'sight',
      'brass',
      bentTube(
        [
          [c * 0.012, SIGHT_Y + s * 0.012, -0.012],
          [c * 0.0135, SIGHT_Y + s * 0.0135, -0.022],
          [c * 0.009, SIGHT_Y + s * 0.009, -0.03],
        ],
        0.0014,
        8,
        6,
      ),
      { paint: 0.9 },
    );
  }
  b.add('sight', 'accent', new TorusGeometry(0.0115, 0.0004, 4, 36), { pos: [0, SIGHT_Y, -0.022] });
  b.add('sight', 'sight', new SphereGeometry(0.0009, 10, 8), { pos: [0, SIGHT_Y, -0.03] });

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, RIFT.z - 0.008]);
  // No casings: the jaw root stands in for the ejection port (rift sparks).
  b.socket('ejectPort', [0.03, BORE_Y + 0.02, JAW_Z + 0.02], [-30, -100, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.01]);
  b.mount('optic', [0, 0.094, -0.02]);
  b.mount('laser', [0.03, 0.04, -0.14]);

  const built = b.build({ ...kit.materials, ...glow, chitin, rift, riftHalo, veins, shard });
  const tear = freeParts(built, ['riftTear']).riftTear;
  const extras: ExtraAnimator[] = [
    (fx) => {
      const breathe = 1 + MOTION.breathe * Math.sin(fx.time * MOTION.breatheRate);
      const flare =
        fx.sinceShot < MOTION.flareTime ? 1 + MOTION.flare * (1 - fx.sinceShot / MOTION.flareTime) : 1;
      tear.scale.set(breathe * flare, 1 + (flare - 1) * 0.25, 1);
    },
  ];
  return new EnergyWeaponModel(
    'riftripper',
    def,
    built,
    glow,
    readoutSpec,
    readout,
    [
      {
        material: rift,
        intensity: 2.6,
        pulseRate: 2.3,
        pulseDepth: 0.2,
        flash: 6,
        flickerRate: 23,
        flickerDepth: 0.25,
      },
      {
        material: riftHalo,
        intensity: 0.7,
        pulseRate: 1.7,
        pulseDepth: 0.3,
        flash: 2.5,
        flickerRate: 31,
        flickerDepth: 0.3,
      },
      { material: veins, intensity: 1.9, pulseRate: 1.4, pulseDepth: 0.35, flash: 3, heat: 2 },
      { material: shard, intensity: 2, pulseRate: 1.1, pulseDepth: 0.25, flash: 1 },
    ],
    { extras, owned: [chitin], readoutTint: [255, 80, 220] },
  );
}

export const buildRiftripper: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const RIFTRIPPER_SIGHT_LINE = SIGHT_Y;
