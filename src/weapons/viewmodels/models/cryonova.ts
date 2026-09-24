/**
 * „Kryo-Nova“ – wonder weapon, cryo cannon (M5). Model content (meters, model space: origin = grip
 * pivot, barrel along −Z). Cold white armour with frost crusting its edges, a flared emitter
 * ringed by eight radiator fins with ice-glass tips and glowing edges, and in front of the
 * emitter a slowly turning star of ice crystals that shatters on every shot and grows back (the
 * model animates it). A glass cryo canister rides in a frosted cradle on the shooter-facing
 * flank. Parts: canister (the magazine), fins (slam back per shot), core (the crystal star),
 * trigger, sight (hexagonal reflex with a snowflake reticle). Six LEDs on the left top.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
} from 'three';
import { CRYONOVA_VIEWMODEL } from '../../../defs/viewmodelData/cryonova';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import {
  cylinderZ,
  latheZHard,
  profileX,
  profileZ,
  regularPolygonProfile,
  roundedBox,
  tubeZ,
} from '../shapes';
import { createReadout, ledUv, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import {
  EnergyWeaponModel,
  createCeramicMaterial,
  createEnergyMaterial,
  createIceMaterial,
  crystalZ,
  freeParts,
  reformScale,
  type ExtraAnimator,
} from './energyKit';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.05;
/** Sight line: center of the hexagonal reflex window. */
const SIGHT_Y = 0.134;
const GRIP_TILT = -18;
const GRIP_TOP = { y: 0.004, z: 0.012 } as const;
const LEDS = 6;
const EMITTER = { back: -0.18, front: -0.285 } as const;
const FIN_R = 0.047;
const CORE_Z = -0.318;
/** Canister on the left flank: center, length, radius, tilt (deg, + = front end up). */
const CAN = { x: -0.047, y: 0.047, z: -0.095, len: 0.13, r: 0.017, tilt: 10 } as const;
/** Crystal star directions [yaw, pitch] (deg) and lengths. */
const STAR: readonly (readonly [number, number, number])[] = [
  [0, 0, 0.046],
  [0, 58, 0.03],
  [72, 55, 0.028],
  [144, 60, 0.032],
  [216, 52, 0.027],
  [288, 57, 0.03],
  [36, 100, 0.022],
  [180, 110, 0.02],
];
const MOTION = { spin: 0.55, regrow: 0.85, collapsed: 0.15 } as const;

const ICE = { glow: 0x9fe8ff, deep: 0x2d8cff, accent: 0x7fdcff, sight: 0xbff2ff } as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = CRYONOVA_VIEWMODEL;
  if (!def) throw new Error('cryonova: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(ICE.sight, readout?.texture ?? null, def.glow);
  glow.accent.emissive.set(ICE.accent);
  glow.heat.emissive.set(ICE.deep);
  const armour = createCeramicMaterial('cryonova', 0xaebac4);
  const ice = createIceMaterial('cryonova', 0xd4f1ff, 0x2a7aa8);
  const star = createEnergyMaterial('cryo-star', {
    core: 0xf2fdff,
    rim: ICE.glow,
    rimPower: 1.2,
    noise: 0.5,
    noiseScale: 320,
    flow: [0.5, 1, -1],
  });
  const aura = createEnergyMaterial('cryo-aura', {
    core: 0x06243a,
    rim: ICE.deep,
    rimPower: 1.4,
    noise: 0.9,
    noiseScale: 140,
    flow: [1, -2, 1.5],
    additive: true,
  });
  const cryo = createEnergyMaterial('cryo-liquid', {
    core: 0xbff4ff,
    rim: 0x2f9cff,
    rimPower: 1.3,
    noise: 1,
    noiseScale: 170,
    flow: [0, 0.8, -1.2],
  });
  const b = new ModelBuilder('cryonova', VIEWMODEL_ART.uvDensity);

  b.part('canister', [CAN.x, CAN.y, CAN.z], { rot: [CAN.tilt, 0, 0] });
  b.part('fins', [0, BORE_Y, (EMITTER.back + EMITTER.front) / 2]);
  b.part('core', [0, BORE_Y, CORE_Z]);
  b.part('star', [0, BORE_Y, CORE_Z], { parent: 'core' });
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('sight', [0, 0.09, -0.03]);

  // --- armoured body ---
  b.add(
    BODY,
    'armour',
    profileX(
      [
        [-0.085, 0.07],
        [0.0, 0.087],
        [0.13, 0.087],
        [-EMITTER.back + 0.002, 0.074],
        [-EMITTER.back + 0.002, 0.02],
        [0.14, 0.01],
        [-0.03, 0.01],
        [-0.085, 0.028],
      ],
      0.06,
      { bevel: 0.004, bevelSegments: 2 },
    ),
    { paint: 0.8 },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.062, 0.016, 0.24, 0.004), {
    pos: [0, 0.03, -0.05],
    paint: P.darkMetal.paint,
  });
  for (const side of [-1, 1]) {
    b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.22), { pos: [side * 0.0302, 0.0395, -0.05] });
  }
  b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.004, 0.16), {
    pos: [0, 0.089, -0.04],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 11; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.026, 0.0035, 0.0065), {
      pos: [0, 0.0925, 0.03 - i * 0.0135],
      paint: P.darkMetal.paint,
    });
  }
  // LEDs on the left top chamfer.
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.006, 0.0012, 0.0075), {
      pos: [-0.0262, 0.0832, 0.058 - i * 0.0105],
      rot: [0, 0, 30],
      uv: ledUv(i, LEDS),
    });
  }
  // Coolant line along the right flank and panel seams on the left.
  b.add(BODY, 'cryo', cylinderZ(0.0032, 0.0032, 0.2, 10), { pos: [0.031, 0.062, -0.06] });
  b.add(BODY, 'lens', cylinderZ(0.0045, 0.0045, 0.2, 12), { pos: [0.031, 0.062, -0.06], uv: 'keep' });
  for (const z of [0.05, -0.02, -0.16]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0616, 0.05, 0.0016, 0.0006), { pos: [0, 0.058, z], paint: 0.4 });
  }
  // Frost crusting the edges.
  for (const [x, y, z, s] of [
    [-0.03, 0.084, -0.12, 1],
    [-0.031, 0.02, -0.15, 0.8],
    [0.03, 0.083, -0.14, 0.9],
    [-0.03, 0.08, 0.04, 0.7],
    [0.03, 0.024, -0.1, 0.7],
  ] as const) {
    b.add(BODY, 'ice', new IcosahedronGeometry(0.009 * s, 0), { pos: [x, y, z], scale: [0.6, 0.8, 1.6] });
    b.add(BODY, 'ice', crystalZ(0.0034 * s, 0.018 * s, 5), {
      pos: [x, y + 0.004, z + 0.004],
      rot: [-40, x > 0 ? -30 : 30, 0],
    });
  }

  // --- canister cradle (left flank) ---
  b.add(BODY, 'darkMetal', roundedBox(0.006, 0.03, CAN.len + 0.01, 0.002), {
    pos: [-0.0325, CAN.y, CAN.z],
    rot: [CAN.tilt, 0, 0],
    paint: P.darkMetal.paint,
  });
  for (const dz of [-CAN.len / 2 + 0.012, CAN.len / 2 - 0.012]) {
    b.add(BODY, 'gunmetal', tubeZ(CAN.r + 0.0045, CAN.r + 0.0008, 0.01, 24), {
      local: false,
      pos: [CAN.x, CAN.y + Math.sin((-CAN.tilt * Math.PI) / 180) * dz, CAN.z + dz + 0.005],
      rot: [CAN.tilt, 0, 0],
      paint: P.gunmetal.paint,
    });
  }

  // --- canister: glass tube, cryo liquid, frosted caps (local frame: along −Z) ---
  b.add('canister', 'cryo', cylinderZ(CAN.r - 0.003, CAN.r - 0.003, CAN.len - 0.03, 18), { local: true });
  b.add('canister', 'lens', cylinderZ(CAN.r, CAN.r, CAN.len - 0.03, 22), { local: true, uv: 'keep' });
  for (const [dz, flip] of [
    [-CAN.len / 2, 180],
    [CAN.len / 2, 0],
  ] as const) {
    b.add(
      'canister',
      'gunmetal',
      latheZHard(
        [
          [0, 0],
          [CAN.r * 0.6, 0],
          [CAN.r + 0.0015, 0.006],
          [CAN.r + 0.0015, 0.016],
          [CAN.r - 0.002, 0.016],
        ],
        22,
      ),
      { local: true, pos: [0, 0, dz], rot: [0, flip, 0], paint: P.gunmetal.paint },
    );
    b.add('canister', 'ice', new TorusGeometry(CAN.r + 0.001, 0.0028, 6, 18), {
      local: true,
      pos: [0, 0, dz + (flip ? 0.012 : -0.012)],
      scale: [1, 1, 0.6],
    });
  }
  b.add('canister', 'accentPaint', tubeZ(CAN.r + 0.0012, CAN.r - 0.001, 0.005, 22), {
    local: true,
    pos: [0, 0, -0.02],
    paint: P.accentPaint.paint,
  });

  // --- emitter: flared cone, glowing throat ---
  b.add(
    BODY,
    'gunmetal',
    latheZHard(
      [
        [0.014, 0],
        [0.03, 0],
        [0.034, 0.05],
        [0.041, 0.095],
        [0.043, 0.105],
        [0.036, 0.107],
        [0.02, 0.07],
        [0.014, 0.03],
      ],
      32,
    ),
    { pos: [0, BORE_Y, EMITTER.back], paint: P.gunmetal.paint },
  );
  b.add(BODY, 'star', new TorusGeometry(0.03, 0.0018, 8, 36), {
    pos: [0, BORE_Y, EMITTER.front - 0.001],
    uv: 'keep',
  });
  b.add(
    BODY,
    'aura',
    latheZHard(
      [
        [0.014, 0.03],
        [0.02, 0.07],
        [0.036, 0.106],
      ],
      28,
    ),
    { pos: [0, BORE_Y, EMITTER.back], uv: 'keep' },
  );
  b.add(BODY, 'darkMetal', profileZ(regularPolygonProfile(0.036, 8, 22.5), 0.012, { bevel: 0.002 }), {
    pos: [0, BORE_Y, EMITTER.back + 0.004],
    paint: P.darkMetal.paint,
  });

  // --- radiator fins: radial plates, ice-glass tips, glowing edges ---
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4 + Math.PI / 8;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const deg = (a * 180) / Math.PI;
    b.add(
      'fins',
      'armour',
      profileX(
        [
          [0.0, 0.0],
          [0.09, 0.0],
          [0.075, 0.018],
          [0.012, 0.018],
        ],
        0.0032,
        { bevel: 0.0008 },
      ),
      {
        pos: [c * (FIN_R - 0.012), BORE_Y + s * (FIN_R - 0.012), EMITTER.back + 0.004],
        rot: [0, 0, deg - 90],
        paint: 0.8,
      },
    );
    b.add('fins', 'star', new BoxGeometry(0.0014, 0.0014, 0.06), {
      pos: [c * (FIN_R + 0.0065), BORE_Y + s * (FIN_R + 0.0065), EMITTER.back - 0.045],
      rot: [0, 0, deg],
    });
    b.add('fins', 'ice', crystalZ(0.0042, 0.03, 5), {
      pos: [c * (FIN_R + 0.004), BORE_Y + s * (FIN_R + 0.004), EMITTER.back - 0.07],
      rot: [-(90 - 0) * 0 - 8, 0, deg],
    });
  }
  b.add('fins', 'gunmetal', tubeZ(FIN_R - 0.008, FIN_R - 0.012, 0.012, 32), {
    pos: [0, BORE_Y, EMITTER.back - 0.02],
    paint: P.gunmetal.paint,
  });

  // --- the nova: a star of ice crystals (free, spins; shatters and re-grows per shot) ---
  for (const [yaw, pitch, len] of STAR) {
    b.add('star', 'star', crystalZ(0.0055, len, 6), {
      local: true,
      rot: [pitch * Math.cos((yaw * Math.PI) / 180), pitch * Math.sin((yaw * Math.PI) / 180), 0],
    });
  }
  b.add('star', 'star', new IcosahedronGeometry(0.008, 0), { local: true });
  b.add('star', 'aura', new SphereGeometry(0.03, 20, 14), { local: true, uv: 'keep' });
  b.add('core', 'darkMetal', cylinderZ(0.004, 0.004, 0.04, 8), {
    pos: [0, BORE_Y, CORE_Z + 0.035],
    paint: 0.4,
  });

  // --- magwell block, trigger guard, trigger, grip ---
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-0.002, 0.012],
        [0.07, 0.012],
        [0.07, -0.024],
        [0.062, -0.032],
        [0.008, -0.032],
        [-0.004, -0.022],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, -0.002],
            [0.062, -0.002],
            [0.062, -0.021],
            [0.056, -0.027],
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
  b.add(
    BODY,
    'armour',
    profileX(
      [
        [0.09, 0.012],
        [0.17, 0.012],
        [0.2, -0.004],
        [0.2, -0.05],
        [0.19, -0.058],
        [0.175, -0.05],
        [0.16, -0.012],
        [0.09, -0.012],
      ],
      0.036,
      { bevel: 0.004 },
    ),
    { paint: 0.8 },
  );

  // --- stock ---
  b.add(
    BODY,
    'armour',
    profileX(
      [
        [-0.08, 0.066],
        [-0.3, 0.064],
        [-0.312, 0.052],
        [-0.312, -0.038],
        [-0.3, -0.046],
        [-0.2, -0.014],
        [-0.08, 0.02],
      ],
      0.04,
      {
        bevel: 0.004,
        holes: [
          [
            [-0.13, 0.052],
            [-0.28, 0.05],
            [-0.28, -0.02],
            [-0.2, 0.002],
            [-0.13, 0.026],
          ],
        ],
      },
    ),
    { paint: 0.8 },
  );
  b.add(BODY, 'grip', roundedBox(0.044, 0.112, 0.016, 0.005), {
    pos: [0, 0.01, 0.318],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- hexagonal reflex sight, snowflake reticle ---
  b.add('sight', 'darkMetal', roundedBox(0.024, 0.02, 0.046, 0.002), { pos: [0, 0.1, -0.03], paint: 0.4 });
  b.add(
    'sight',
    'armour',
    profileZ(regularPolygonProfile(0.024, 6, 0), 0.03, {
      bevel: 0.0015,
      holes: [regularPolygonProfile(0.0185, 6, 0)],
    }),
    { pos: [0, SIGHT_Y, -0.036], paint: 0.8 },
  );
  b.add('sight', 'ice', crystalZ(0.003, 0.016, 5), {
    pos: [-0.018, SIGHT_Y + 0.014, -0.03],
    rot: [-60, 20, 0],
  });
  b.add('sight', 'lens', new PlaneGeometry(0.034, 0.03), { pos: [0, SIGHT_Y, -0.05], uv: 'keep' });
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 2;
    b.add('sight', 'sight', new BoxGeometry(0.0034, 0.00045, 0.0003), {
      pos: [Math.cos(a) * 0.0042, SIGHT_Y + Math.sin(a) * 0.0042, -0.0503],
      rot: [0, 0, (a * 180) / Math.PI],
    });
  }
  b.add('sight', 'sight', new CylinderGeometry(0.0007, 0.0007, 0.0003, 10), {
    pos: [0, SIGHT_Y, -0.0503],
    rot: [90, 0, 0],
  });

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, CORE_Z - 0.03]);
  // No casings: the canister cradle stands in for the ejection port (frost vapour).
  b.socket('ejectPort', [CAN.x - 0.01, CAN.y, CAN.z], [0, 90, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.02]);
  b.mount('optic', [0, 0.0945, -0.03]);
  b.mount('laser', [0.031, 0.05, -0.12]);
  b.mount('underbarrel', [0, 0.02, -0.14]);

  const built = b.build({ ...kit.materials, ...glow, armour, ice, star, aura, cryo });
  const starNode = freeParts(built, ['star']).star;
  const extras: ExtraAnimator[] = [
    (fx) => {
      starNode.rotation.set(0, 0, (fx.time * MOTION.spin) % (Math.PI * 2));
      starNode.scale.setScalar(reformScale(fx.sinceShot, MOTION.regrow, MOTION.collapsed));
    },
  ];
  return new EnergyWeaponModel(
    'cryonova',
    def,
    built,
    glow,
    readoutSpec,
    readout,
    [
      { material: star, intensity: 2.4, pulseRate: 1.6, pulseDepth: 0.18, flash: 5 },
      { material: aura, intensity: 0.8, pulseRate: 1.1, pulseDepth: 0.3, flash: 3 },
      { material: cryo, intensity: 1.3, pulseRate: 0.9, pulseDepth: 0.2 },
    ],
    { extras, owned: [armour, ice] },
  );
}

export const buildCryonova: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const CRYONOVA_SIGHT_LINE = SIGHT_Y;
