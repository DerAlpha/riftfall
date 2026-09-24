/**
 * „Äther-Harfe“ – wonder weapon, homing resonance orbs (M5). Model content (meters, model space:
 * origin = grip pivot, barrel along −Z). Precious and strange: a smooth ivory body with gold
 * bands; a golden harp frame leans out over the shooter-facing flank and strings six beams of
 * light across a soundboard; at the front a gold fork holds a spinning cyan resonator crystal
 * inside two orbit rings. Parts: strings (twitch per shot, the shader makes them shiver),
 * resonator (fork + crystal, kicks back per shot; the crystal spins on its own), cell (tuning
 * cell in the magwell), trigger, sight (gold ring with a floating diamond).
 */
import { BoxGeometry, CylinderGeometry, OctahedronGeometry, SphereGeometry, TorusGeometry } from 'three';
import { AETHERHARP_VIEWMODEL } from '../../../defs/viewmodelData/aetherharp';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import { cylinderZ, profileX, roundedBox, tubeZ } from '../shapes';
import { createReadout, ledUv, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import {
  EnergyWeaponModel,
  bentTube,
  createCeramicMaterial,
  createEnergyMaterial,
  freeParts,
  smoothOutline,
  spinner,
  type ExtraAnimator,
} from './energyKit';

const BORE_Y = 0.05;
/** Sight line: center of the gold ring. */
const SIGHT_Y = 0.118;
const GRIP_TILT = -18;
const GRIP_TOP = { y: 0.004, z: 0.012 } as const;
const LEDS = 8;
/** Harp: soundboard edge (x, y), frame span (z), apex height, lean outwards (deg). */
const HARP = { x: -0.029, y: 0.074, back: 0.012, front: -0.29, height: 0.076, lean: 32 } as const;
const STRINGS = 6;
const RES = { z: -0.33, r: 0.013 } as const;
const MOTION = { crystal: 1.6, orbitA: 0.9, orbitB: -1.3, bobAmp: 0.0012, bobRate: 2.1 } as const;

const AETHER = { gold: 0xffc86a, light: 0xfff2d2, cyan: 0x7ff0ff, sight: 0x8ff6ff } as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

/** Point of the harp frame at z (the frame's height follows a half sine over its span). */
function harpPoint(z: number, inset = 0): [number, number, number] {
  const u = (HARP.back - z) / (HARP.back - HARP.front);
  const h = Math.max(0, HARP.height * Math.sin(Math.PI * Math.min(1, Math.max(0, u))) - inset);
  const a = (HARP.lean * Math.PI) / 180;
  return [HARP.x - Math.sin(a) * h, HARP.y + Math.cos(a) * h, z];
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = AETHERHARP_VIEWMODEL;
  if (!def) throw new Error('aetherharp: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(AETHER.sight, readout?.texture ?? null, def.glow);
  glow.accent.emissive.set(AETHER.gold);
  const ivory = createCeramicMaterial('aetherharp', 0xc9bea2);
  const light = createEnergyMaterial('aether-strings', {
    core: AETHER.light,
    rim: 0xffb84a,
    rimPower: 0.8,
    noise: 0.4,
    noiseScale: 400,
    flow: [0, 8, 0],
    additive: true,
    waveRate: 70,
    wavePin: 0,
  });
  const crystal = createEnergyMaterial('aether-crystal', {
    core: 0xe8ffff,
    rim: AETHER.cyan,
    rimPower: 1.1,
    noise: 0.5,
    noiseScale: 300,
    flow: [1, 2, 0],
  });
  const aura = createEnergyMaterial('aether-aura', {
    core: 0x0a3a60,
    rim: AETHER.cyan,
    rimPower: 1.6,
    noise: 0.8,
    noiseScale: 160,
    flow: [-2, 1, 2],
    additive: true,
  });
  const b = new ModelBuilder('aetherharp', VIEWMODEL_ART.uvDensity);

  b.part('strings', [HARP.x, HARP.y, (HARP.back + HARP.front) / 2]);
  b.part('resonator', [0, BORE_Y, RES.z]);
  b.part('crystal', [0, BORE_Y, RES.z], { parent: 'resonator' });
  b.part('orbitA', [0, BORE_Y, RES.z], { parent: 'resonator', rot: [70, 0, 0] });
  b.part('orbitB', [0, BORE_Y, RES.z], { parent: 'resonator', rot: [0, 70, 30] });
  b.part('cell', [0, -0.012, -0.112]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('sight', [0, 0.09, -0.02]);

  // --- ivory body with gold bands ---
  b.add(
    BODY,
    'ivory',
    profileX(
      smoothOutline(
        [
          [-0.1, 0.03],
          [-0.08, 0.058],
          [-0.02, 0.078],
          [0.1, 0.082],
          [0.2, 0.074],
          [0.255, 0.06],
          [0.262, 0.042],
          [0.235, 0.026],
          [0.12, 0.012],
          [0.0, 0.008],
          [-0.06, 0.008],
          [-0.095, 0.014],
        ],
        4,
      ),
      0.05,
      { bevel: 0.006, bevelSegments: 3 },
    ),
    { paint: 0.85 },
  );
  for (const z of [0.03, -0.08, -0.2]) {
    b.add(BODY, 'brass', tubeZ(0.028, 0.02, 0.006, 32), {
      pos: [0, 0.047, z + 0.003],
      scale: [0.96, 1.25, 1],
      paint: 0.9,
    });
  }
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.004, 0.13, 0.0015), { pos: [0, 0.082, -0.03], paint: 0.4 });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0016, 0.24), { pos: [0.0252, 0.062, -0.09] });
  // Gold filigree waving along both flanks.
  for (const side of [-1, 1]) {
    const wave: [number, number, number][] = [];
    for (let i = 0; i <= 24; i++) {
      const z = 0.06 - i * 0.0125;
      wave.push([side * 0.0256, 0.044 + 0.009 * Math.sin(i * 0.9), z]);
    }
    b.add(BODY, 'brass', bentTube(wave, 0.0011, 72, 5), { paint: 0.9 });
  }

  // --- harp: soundboard, golden frame, pillars, strings of light ---
  const boardLen = HARP.back - HARP.front;
  const boardZ = (HARP.back + HARP.front) / 2;
  b.add(BODY, 'brass', roundedBox(0.012, 0.008, boardLen + 0.02, 0.003), {
    pos: [HARP.x - 0.002, HARP.y - 0.002, boardZ],
    rot: [0, 0, HARP.lean],
    paint: 0.9,
  });
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0035, 0.0012, 0.009), {
      pos: [HARP.x + 0.002, HARP.y + 0.0028, HARP.back - 0.02 - i * 0.034],
      rot: [0, 0, HARP.lean],
      uv: ledUv(i, LEDS),
    });
  }
  const frame: [number, number, number][] = [];
  for (let i = 0; i <= 16; i++) frame.push(harpPoint(HARP.back - (i / 16) * boardLen));
  b.add(BODY, 'brass', bentTube(frame, 0.0045, 48, 10), { paint: 0.9 });
  b.add(
    BODY,
    'brass',
    bentTube(
      frame.map(([x, y, z]) => [x + 0.004, y - 0.004, z] as [number, number, number]),
      0.0018,
      48,
      6,
    ),
    {
      paint: 0.9,
    },
  );
  // Scroll finials where the frame meets the body.
  for (const z of [HARP.back, HARP.front]) {
    b.add(BODY, 'brass', new TorusGeometry(0.008, 0.0024, 8, 20, Math.PI * 1.5), {
      pos: [HARP.x - 0.004, HARP.y + 0.006, z],
      rot: [0, 90, z > boardZ ? 40 : 140],
      paint: 0.9,
    });
  }
  const a = (HARP.lean * Math.PI) / 180;
  for (let i = 0; i < STRINGS; i++) {
    const z = HARP.back - ((i + 1) / (STRINGS + 1)) * boardLen;
    const top = harpPoint(z, 0.003);
    const base: [number, number, number] = [HARP.x - Math.sin(a) * 0.004, HARP.y + Math.cos(a) * 0.004, z];
    const len = Math.hypot(top[0] - base[0], top[1] - base[1]);
    b.add('strings', 'light', new CylinderGeometry(0.0009, 0.0009, len, 5, 14), {
      pos: [(top[0] + base[0]) / 2, (top[1] + base[1]) / 2, z],
      rot: [0, 0, HARP.lean],
      uv: 'keep',
    });
    b.add(BODY, 'darkMetal', cylinderZ(0.0022, 0.0022, 0.004, 10), {
      pos: base,
      rot: [90 - 0, 0, 0],
      paint: 0.4,
    });
  }

  // --- resonator: gold fork, crystal, orbit rings ---
  for (const side of [-1, 1]) {
    b.add(
      'resonator',
      'brass',
      bentTube(
        [
          [side * 0.012, BORE_Y, RES.z + 0.07],
          [side * 0.024, BORE_Y, RES.z + 0.035],
          [side * 0.026, BORE_Y, RES.z],
          [side * 0.018, BORE_Y, RES.z - 0.02],
        ],
        0.0035,
        18,
        8,
      ),
      { paint: 0.9 },
    );
    b.add('resonator', 'crystal', new SphereGeometry(0.0032, 10, 8), {
      pos: [side * 0.018, BORE_Y, RES.z - 0.021],
    });
  }
  b.add('resonator', 'brass', cylinderZ(0.011, 0.014, 0.03, 20), {
    pos: [0, BORE_Y, RES.z + 0.078],
    paint: 0.9,
  });
  b.add('crystal', 'crystal', new OctahedronGeometry(RES.r, 0), { local: true, scale: [0.8, 0.8, 1.5] });
  b.add('crystal', 'aura', new SphereGeometry(RES.r * 1.6, 20, 14), { local: true, uv: 'keep' });
  b.add('orbitA', 'brass', new TorusGeometry(0.021, 0.0012, 6, 40), { local: true, paint: 0.9 });
  b.add('orbitB', 'brass', new TorusGeometry(0.018, 0.001, 6, 40), { local: true, paint: 0.9 });
  b.add('orbitA', 'accent', new SphereGeometry(0.0022, 8, 6), { local: true, pos: [0.021, 0, 0] });
  b.add('orbitB', 'accent', new SphereGeometry(0.0018, 8, 6), { local: true, pos: [-0.018, 0, 0] });
  // Neck from the body to the fork.
  b.add(BODY, 'ivory', cylinderZ(0.016, 0.02, 0.05, 20), { pos: [0, BORE_Y, -0.27] });
  b.add(BODY, 'brass', tubeZ(0.021, 0.015, 0.006, 24), { pos: [0, BORE_Y, -0.29], paint: 0.9 });

  // --- magwell, tuning cell ---
  b.add(
    BODY,
    'ivory',
    profileX(
      [
        [0.076, 0.014],
        [0.152, 0.014],
        [0.148, -0.018],
        [0.08, -0.018],
      ],
      0.042,
      { bevel: 0.004 },
    ),
  );
  b.add('cell', 'ivory', roundedBox(0.032, 0.09, 0.058, 0.01, 3), { pos: [0, -0.056, -0.112] });
  b.add('cell', 'brass', roundedBox(0.0335, 0.006, 0.06, 0.002), { pos: [0, -0.03, -0.112], paint: 0.9 });
  b.add('cell', 'brass', roundedBox(0.0335, 0.006, 0.06, 0.002), { pos: [0, -0.094, -0.112], paint: 0.9 });
  b.add('cell', 'crystal', roundedBox(0.0012, 0.04, 0.028, 0.0005), { pos: [-0.0163, -0.062, -0.112] });
  for (const z of [-0.104, -0.12]) {
    b.add('cell', 'brass', cylinderZ(0.0022, 0.0022, 0.004, 8), {
      pos: [-0.0168, -0.084, z],
      rot: [0, 90, 0],
      paint: 0.9,
    });
  }

  // --- grip, trigger guard, trigger ---
  b.add(BODY, 'ivory', roundedBox(0.031, 0.104, 0.043, 0.011, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
  });
  for (let i = 0; i < 2; i++) {
    b.add(BODY, 'brass', roundedBox(0.0325, 0.005, 0.0445, 0.0018), {
      pos: gripAxis(0.03 + i * 0.05),
      rot: [GRIP_TILT, 0, 0],
      paint: 0.9,
    });
  }
  b.add(
    BODY,
    'brass',
    profileX(
      smoothOutline(
        [
          [0.0, 0.008],
          [0.072, 0.01],
          [0.07, -0.018],
          [0.05, -0.03],
          [0.012, -0.03],
          [0.0, -0.018],
        ],
        3,
      ),
      0.008,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.012, -0.004],
            [0.06, -0.004],
            [0.058, -0.019],
            [0.046, -0.025],
            [0.016, -0.025],
          ],
        ],
      },
    ),
    { paint: 0.9 },
  );
  b.add(
    'trigger',
    'darkMetal',
    profileX(
      [
        [0.03, 0.004],
        [0.037, 0.004],
        [0.037, -0.009],
        [0.033, -0.019],
        [0.028, -0.021],
        [0.031, -0.01],
      ],
      0.005,
      { bevel: 0.0008 },
    ),
    { paint: 0.4 },
  );

  // --- gold ring sight with a floating diamond ---
  b.add('sight', 'brass', roundedBox(0.008, SIGHT_Y - 0.1, 0.01, 0.002), {
    pos: [0, (SIGHT_Y + 0.078) / 2 - 0.006, -0.02],
    paint: 0.9,
  });
  b.add('sight', 'brass', new TorusGeometry(0.0118, 0.0018, 8, 40), { pos: [0, SIGHT_Y, -0.02], paint: 0.9 });
  b.add('sight', 'accent', new TorusGeometry(0.0098, 0.00035, 4, 40), { pos: [0, SIGHT_Y, -0.0205] });
  b.add('sight', 'sight', new OctahedronGeometry(0.0011, 0), {
    pos: [0, SIGHT_Y, -0.024],
    scale: [1, 1.5, 0.4],
  });

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, RES.z - 0.02]);
  // No casings: the soundboard stands in for the ejection port (sparks off the strings).
  b.socket('ejectPort', [HARP.x - 0.01, HARP.y + 0.02, -0.12], [0, 90, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.008]);
  b.mount('optic', [0, 0.084, -0.03]);
  b.mount('laser', [0.027, 0.04, -0.2]);

  const built = b.build({ ...kit.materials, ...glow, ivory, light, crystal, aura });
  const free = freeParts(built, ['crystal', 'orbitA', 'orbitB']);
  const cr = free.crystal;
  const crRest = cr.position.clone();
  const extras: ExtraAnimator[] = [
    spinner(free.crystal, 'z', MOTION.crystal),
    spinner(free.orbitA, 'z', MOTION.orbitA),
    spinner(free.orbitB, 'z', MOTION.orbitB),
    (fx) =>
      cr.position.set(crRest.x, crRest.y + Math.sin(fx.time * MOTION.bobRate) * MOTION.bobAmp, crRest.z),
  ];
  return new EnergyWeaponModel(
    'aetherharp',
    def,
    built,
    glow,
    readoutSpec,
    readout,
    [
      {
        material: light,
        intensity: 2.2,
        pulseRate: 2.7,
        pulseDepth: 0.2,
        flash: 4,
        wave: 0.00015,
        waveFlash: 0.0016,
      },
      { material: crystal, intensity: 2.6, pulseRate: 1.9, pulseDepth: 0.2, flash: 4 },
      { material: aura, intensity: 0.9, pulseRate: 1.3, pulseDepth: 0.3, flash: 2.5 },
    ],
    { extras, owned: [ivory], readoutTint: [255, 232, 160] },
  );
}

export const buildAetherharp: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const AETHERHARP_SIGHT_LINE = SIGHT_Y;
