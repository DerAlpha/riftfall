/**
 * SX-0 „Ereignishorizont“ – singularity projector (M5). Model content (meters, model space:
 * origin = grip pivot, barrel along −Z). The showpiece: a heavy dark receiver ends in a
 * containment base from which three claws reach forward and curl around a floating micro black
 * hole – a lightless core with a violet event-horizon rim, a lensing halo and a tilted accretion
 * disk – inside a spinning containment ring and a tilted gyro ring. Each shot the core collapses
 * and re-forms (the model animates it), the ring spins up with heat. Parts: ring (containment,
 * heat spin driver), core (kicks forward per shot), cell (void cell in the magwell), trigger,
 * sight (reflex, violet ring reticle). Three charge LEDs on the left top chamfer.
 */
import { BoxGeometry, PlaneGeometry, RingGeometry, SphereGeometry, TorusGeometry } from 'three';
import { BLACKHOLE_VIEWMODEL } from '../../../defs/viewmodelData/blackhole';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import { chamferRectProfile, cylinderZ, profileX, profileZ, roundedBox, tubeZ } from '../shapes';
import { createReadout, ledUv, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import {
  EnergyWeaponModel,
  bentTube,
  createEnergyMaterial,
  freeParts,
  reformScale,
  spinner,
  type ExtraAnimator,
} from './energyKit';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.052;
/** Sight line: center of the reflex window. */
const SIGHT_Y = 0.138;
const GRIP_TILT = -18;
const GRIP_TOP = { y: 0.004, z: 0.012 } as const;
const LEDS = 3;
const BASE_Z = -0.205;
const CORE = { z: -0.318, r: 0.024 } as const;
const RING_R = 0.066;
/** Claws: angle around the bore (deg, 90 = top). */
const CLAWS = [135, 45, 270] as const;
/** Free-node motion (model content): idle spins (rad/s), core bob (m, rad/s), collapse on shot. */
const MOTION = {
  ringIdle: 0.9,
  gyro: -2.3,
  disk: 3.6,
  bobAmp: 0.0016,
  bobRate: 1.7,
  regrow: 1.15,
  collapsed: 0.1,
} as const;

const VOID = { accent: 0xa45cff, sight: 0xc28bff, rim: 0xa04dff, deep: 0x5a18ff } as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = BLACKHOLE_VIEWMODEL;
  if (!def) throw new Error('blackhole: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VOID.sight, readout?.texture ?? null, def.glow);
  glow.accent.emissive.set(VOID.accent);
  const horizon = createEnergyMaterial('void-horizon', {
    core: 0x000000,
    rim: VOID.rim,
    rimPower: 1.8,
    noise: 0.5,
    noiseScale: 260,
    flow: [2, -1, 3],
  });
  const lens = createEnergyMaterial('void-lens', {
    core: 0x000000,
    rim: VOID.deep,
    rimPower: 3,
    noise: 0.6,
    noiseScale: 160,
    flow: [-1.5, 2, 1],
    additive: true,
  });
  const disk = createEnergyMaterial('void-disk', {
    core: 0xffb0f0,
    rim: VOID.rim,
    rimPower: 1.2,
    noise: 1,
    noiseScale: 220,
    flow: [4, 4, 0],
    additive: true,
  });
  const field = createEnergyMaterial('void-field', {
    core: 0xe2c6ff,
    rim: VOID.rim,
    rimPower: 1.5,
    noise: 0.5,
    noiseScale: 180,
    flow: [0, 0, 3],
  });
  const cellGlow = createEnergyMaterial('void-cell', {
    core: 0xb77dff,
    rim: 0x4a10c8,
    rimPower: 1.5,
    noise: 1,
    noiseScale: 150,
    flow: [0.5, 2, 0.5],
  });
  const b = new ModelBuilder('blackhole', VIEWMODEL_ART.uvDensity);

  b.part('ring', [0, BORE_Y, CORE.z]);
  b.part('ringSpin', [0, BORE_Y, CORE.z], { parent: 'ring' });
  b.part('gyro', [0, BORE_Y, CORE.z], { rot: [68, 20, 0] });
  b.part('core', [0, BORE_Y, CORE.z]);
  b.part('coreFloat', [0, BORE_Y, CORE.z], { parent: 'core' });
  b.part('disk', [0, BORE_Y, CORE.z], { parent: 'coreFloat', rot: [-72, 12, 0] });
  b.part('cell', [0, -0.012, -0.118]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('sight', [0, 0.09, -0.03]);

  // --- receiver: heavy, dark, angular ---
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-0.085, 0.074],
        [0.0, 0.089],
        [0.15, 0.089],
        [-BASE_Z - 0.01, 0.074],
        [-BASE_Z - 0.01, 0.026],
        [0.16, 0.008],
        [-0.03, 0.008],
        [-0.085, 0.028],
      ],
      0.062,
      { bevel: 0.004, bevelSegments: 2 },
    ),
    { paint: P.darkMetal.paint },
  );
  // Raised armour plates on both flanks, violet seams between them.
  for (const side of [-1, 1]) {
    b.add(
      BODY,
      'gunmetal',
      profileX(
        [
          [-0.02, 0.078],
          [0.13, 0.078],
          [0.17, 0.06],
          [0.17, 0.03],
          [0.12, 0.018],
          [-0.02, 0.018],
        ],
        0.006,
        { bevel: 0.0015 },
      ),
      { pos: [side * 0.032, 0, 0], paint: P.gunmetal.paint },
    );
    b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0016, 0.16), { pos: [side * 0.0352, 0.048, -0.075] });
    b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.03, 0.0016), { pos: [side * 0.0352, 0.048, 0.0] });
  }
  // Void conduit along the shooter-facing flank into the containment base, clamped.
  const conduit: [number, number, number][] = [
    [-0.036, 0.052, 0.03],
    [-0.042, 0.056, -0.04],
    [-0.041, 0.06, -0.14],
    [-0.03, BORE_Y + 0.012, BASE_Z + 0.02],
  ];
  b.add(BODY, 'cellGlow', bentTube(conduit, 0.0052, 24, 10), { uv: 'keep' });
  b.add(BODY, 'lens', bentTube(conduit, 0.0068, 24, 12), { uv: 'keep' });
  for (const [x, y, z] of [
    [-0.0415, 0.0555, -0.02],
    [-0.0418, 0.058, -0.09],
    [-0.039, 0.059, -0.16],
  ] as const) {
    b.add(BODY, 'gunmetal', tubeZ(0.009, 0.0068, 0.008, 18), { pos: [x, y, z + 0.004], paint: P.gunmetal.paint });
  }
  b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.004, 0.16), { pos: [0, 0.091, -0.04], paint: P.darkMetal.paint });
  for (let i = 0; i < 11; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.026, 0.0035, 0.0065), {
      pos: [0, 0.0945, 0.03 - i * 0.0135],
      paint: P.darkMetal.paint,
    });
  }
  // Charge LEDs on the left top chamfer.
  b.add(BODY, 'gunmetal', roundedBox(0.012, 0.003, 0.04, 0.001), {
    pos: [-0.026, 0.084, 0.03],
    rot: [0, 0, 38],
    paint: P.gunmetal.paint,
  });
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.007, 0.0014, 0.009), {
      pos: [-0.0268, 0.0853, 0.042 - i * 0.012],
      rot: [0, 0, 38],
      uv: ledUv(i, LEDS),
    });
  }

  // --- containment base, claws ---
  b.add(BODY, 'gunmetal', tubeZ(0.046, 0.012, 0.024, 36), { pos: [0, BORE_Y, BASE_Z + 0.018], paint: P.gunmetal.paint });
  b.add(BODY, 'field', new TorusGeometry(0.031, 0.0024, 8, 40), { pos: [0, BORE_Y, BASE_Z - 0.007], uv: 'keep' });
  b.add(BODY, 'darkMetal', tubeZ(0.02, 0.008, 0.014, 24), { pos: [0, BORE_Y, BASE_Z - 0.004], paint: 0.4 });
  b.add(BODY, 'horizon', cylinderZ(0.008, 0.008, 0.002, 16), { pos: [0, BORE_Y, BASE_Z - 0.012] });
  for (const deg of CLAWS) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const pt = (r: number, z: number): [number, number, number] => [c * r, BORE_Y + s * r, z];
    b.add(
      BODY,
      'gunmetal',
      bentTube(
        [pt(0.034, BASE_Z), pt(0.074, BASE_Z - 0.035), pt(0.086, CORE.z), pt(0.074, CORE.z - 0.052), pt(0.044, CORE.z - 0.084)],
        0.0072,
        26,
        8,
      ),
      { paint: P.gunmetal.paint },
    );
    b.add(BODY, 'darkMetal', roundedBox(0.02, 0.017, 0.03, 0.003), {
      pos: pt(0.062, BASE_Z - 0.026),
      rot: [0, 0, deg - 90],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'field', new SphereGeometry(0.006, 12, 8), { pos: pt(0.042, CORE.z - 0.085) });
  }

  // --- containment ring (heat spin) + its idle-spinning body ---
  b.add('ringSpin', 'gunmetal', new TorusGeometry(RING_R, 0.0056, 10, 56), { pos: [0, BORE_Y, CORE.z], paint: P.gunmetal.paint });
  b.add('ringSpin', 'field', new TorusGeometry(RING_R - 0.0052, 0.0018, 8, 56), { pos: [0, BORE_Y, CORE.z], uv: 'keep' });
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    b.add('ringSpin', 'darkMetal', roundedBox(0.014, 0.011, 0.016, 0.002), {
      pos: [Math.cos(a) * RING_R, BORE_Y + Math.sin(a) * RING_R, CORE.z],
      rot: [0, 0, (a * 180) / Math.PI],
      paint: P.darkMetal.paint,
    });
    b.add('ringSpin', 'accent', new BoxGeometry(0.0016, 0.005, 0.0165), {
      pos: [Math.cos(a) * (RING_R - 0.0072), BORE_Y + Math.sin(a) * (RING_R - 0.0072), CORE.z],
      rot: [0, 0, (a * 180) / Math.PI],
    });
  }
  // Gyro ring (free, tilted, counter-spinning).
  b.add('gyro', 'gunmetal', new TorusGeometry(0.05, 0.0026, 8, 48), { local: true, paint: P.gunmetal.paint });
  b.add('gyro', 'field', new TorusGeometry(0.05, 0.0011, 6, 48), { local: true, pos: [0, 0, 0.0025], uv: 'keep' });

  // --- the singularity: horizon, lensing halo, accretion disk ---
  b.add('coreFloat', 'horizon', new SphereGeometry(CORE.r, 28, 20), { pos: [0, BORE_Y, CORE.z] });
  b.add('coreFloat', 'lens', new SphereGeometry(CORE.r * 1.75, 28, 20), { pos: [0, BORE_Y, CORE.z], uv: 'keep' });
  b.add('disk', 'disk', new RingGeometry(CORE.r * 1.25, CORE.r * 2.3, 48, 2), { local: true, uv: 'keep' });

  // --- magwell + void cell ---
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [0.078, 0.012],
        [0.162, 0.012],
        [0.162, -0.024],
        [0.082, -0.024],
      ],
      0.05,
      { bevel: 0.003 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add('cell', 'gunmetal', roundedBox(0.038, 0.095, 0.064, 0.006, 2), { pos: [0, -0.058, -0.118], paint: P.gunmetal.paint });
  b.add('cell', 'darkMetal', roundedBox(0.0395, 0.012, 0.066, 0.003), { pos: [0, -0.1, -0.118], paint: P.darkMetal.paint });
  b.add('cell', 'bore', roundedBox(0.0012, 0.052, 0.04, 0.0005), { pos: [-0.0192, -0.058, -0.118] });
  b.add('cell', 'cellGlow', cylinderZ(0.01, 0.01, 0.036, 16), { pos: [-0.0172, -0.058, -0.118], rot: [90, 0, 0] });
  b.add('cell', 'accentPaint', roundedBox(0.04, 0.005, 0.066, 0.002), { pos: [0, -0.024, -0.118], paint: P.accentPaint.paint });

  // --- trigger guard, trigger, grip ---
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-0.002, 0.01],
        [0.078, 0.01],
        [0.078, -0.024],
        [0.07, -0.032],
        [0.008, -0.032],
        [-0.004, -0.022],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, -0.004],
            [0.07, -0.004],
            [0.07, -0.021],
            [0.064, -0.027],
            [0.012, -0.027],
          ],
        ],
      },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(
    'trigger',
    'gunmetal',
    profileX(
      [
        [0.032, 0.004],
        [0.038, 0.004],
        [0.039, -0.009],
        [0.036, -0.019],
        [0.031, -0.022],
        [0.033, -0.012],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.gunmetal.paint },
  );
  b.add(BODY, 'polymer', roundedBox(0.032, 0.106, 0.045, 0.008, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0342, 0.07, 0.036, 0.004), {
    pos: gripAxis(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- heavy stock ---
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-0.08, 0.072],
        [-0.3, 0.07],
        [-0.315, 0.058],
        [-0.315, -0.04],
        [-0.3, -0.048],
        [-0.2, -0.016],
        [-0.08, 0.018],
      ],
      0.042,
      { bevel: 0.004, holes: [[[-0.13, 0.056], [-0.28, 0.054], [-0.28, -0.022], [-0.2, 0.0], [-0.13, 0.026]]] },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0016, 0.18), { pos: [-0.0212, 0.066, 0.19], rot: [0.5, 0, 0] });
  b.add(BODY, 'grip', roundedBox(0.046, 0.118, 0.016, 0.005), { pos: [0, 0.011, 0.32], uvDensity: VIEWMODEL_ART.knurlDensity });

  // --- reflex sight ---
  b.add('sight', 'darkMetal', roundedBox(0.026, 0.016, 0.05, 0.002), { pos: [0, 0.1, -0.03], paint: 0.4 });
  b.add(
    'sight',
    'gunmetal',
    profileZ(chamferRectProfile(0.04, 0.038, 0.012, 0.003), 0.03, {
      bevel: 0.0015,
      holes: [chamferRectProfile(0.032, 0.029, 0.009, 0.002)],
    }),
    { pos: [0, SIGHT_Y, -0.036], paint: P.gunmetal.paint },
  );
  b.add('sight', 'accent', new BoxGeometry(0.016, 0.0012, 0.02), { pos: [0, SIGHT_Y + 0.019, -0.036] });
  b.add('sight', 'lens', new PlaneGeometry(0.032, 0.029), { pos: [0, SIGHT_Y, -0.05], uv: 'keep' });
  b.add('sight', 'sight', new TorusGeometry(0.0062, 0.0004, 4, 40), { pos: [0, SIGHT_Y, -0.0503] });
  b.add('sight', 'sight', cylinderZ(0.0007, 0.0007, 0.0003, 10), { pos: [0, SIGHT_Y, -0.0503] });
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    b.add('sight', 'sight', new BoxGeometry(0.0022, 0.0005, 0.0003), {
      pos: [Math.cos(a) * 0.0082, SIGHT_Y + Math.sin(a) * 0.0082, -0.0503],
      rot: [0, 0, (a * 180) / Math.PI],
    });
  }

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, CORE.z - 0.03]);
  // No casings: the containment base stands in for the ejection port (void vapour).
  b.socket('ejectPort', [0.034, BORE_Y + 0.03, BASE_Z + 0.02], [-30, -100, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.02]);
  b.mount('optic', [0, 0.0965, -0.03]);
  b.mount('laser', [0.042, BORE_Y, BASE_Z + 0.03]);

  const built = b.build({ ...kit.materials, ...glow, horizon, lens, disk, field, cellGlow });
  const free = freeParts(built, ['ringSpin', 'gyro', 'coreFloat', 'disk']);
  const float = free.coreFloat;
  const floatRest = float.position.clone();
  const extras: ExtraAnimator[] = [
    spinner(free.ringSpin, 'z', MOTION.ringIdle),
    spinner(free.gyro, 'z', MOTION.gyro),
    spinner(free.disk, 'z', MOTION.disk),
    (fx) => {
      float.position.set(floatRest.x, floatRest.y + Math.sin(fx.time * MOTION.bobRate) * MOTION.bobAmp, floatRest.z);
      float.scale.setScalar(reformScale(fx.sinceShot, MOTION.regrow, MOTION.collapsed));
    },
  ];
  return new EnergyWeaponModel(
    'blackhole',
    def,
    built,
    glow,
    readoutSpec,
    readout,
    [
      { material: horizon, intensity: 4, pulseRate: 1.3, pulseDepth: 0.2, flash: 4 },
      { material: lens, intensity: 1.4, pulseRate: 0.9, pulseDepth: 0.3, flash: 3, heat: 1 },
      { material: disk, intensity: 1.1, pulseRate: 2.2, pulseDepth: 0.2, flash: 2.5, heat: 1.2 },
      { material: field, intensity: 2.3, pulseRate: 1.9, pulseDepth: 0.15, flash: 4, boost: 3 },
      { material: cellGlow, intensity: 1.5, pulseRate: 1.1, pulseDepth: 0.25 },
    ],
    { extras, readoutTint: [190, 120, 255] },
  );
}

export const buildBlackhole: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const BLACKHOLE_SIGHT_LINE = SIGHT_Y;
