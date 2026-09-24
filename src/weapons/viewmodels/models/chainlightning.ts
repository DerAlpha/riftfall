/**
 * EX-1 „Kettenblitz“ – chain-lightning beam projector (M5). Model content (meters, model space:
 * origin = grip pivot, barrel along −Z). Tesla-lab industrial: a blocky receiver with a copper
 * conductor threaded through glazed insulators on the shooter-facing flank, a four-finned copper
 * rotor between two bearing rings, and an emitter head whose three claw prongs cradle a flickering
 * arc ball. A Leyden-jar cell full of crawling sparks feeds it from the magwell; a finned power
 * pack forms the stock. Parts: coils (rotor, spins with the beam), prongs → prongA/B/C (claw
 * open with the beam), cell, trigger, sight (rear aperture). Ten charge LEDs on the left top.
 */
import { BoxGeometry, CylinderGeometry, SphereGeometry, TorusGeometry } from 'three';
import { CHAINLIGHTNING_VIEWMODEL } from '../../../defs/viewmodelData/chainlightning';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import {
  chamferRectProfile,
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
  bentTube,
  createCeramicMaterial,
  createEnergyMaterial,
  helixZ,
} from './energyKit';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.048;
/** Sight line: rear aperture center = front post tip. */
const SIGHT_Y = 0.122;
const GRIP_TILT = -17;
const GRIP_TOP = { y: 0.004, z: 0.012 } as const;
const LEDS = 10;
const ROTOR = { back: -0.17, front: -0.285, r: 0.026 } as const;
const HEAD_Z = -0.305;
/** Prong roots sit on this radius around the bore at these angles (deg, 90 = top). */
const PRONG_R = 0.024;
const PRONGS = [
  ['prongA', 90],
  ['prongB', 210],
  ['prongC', 330],
] as const;
const ARC_Z = -0.43;
const CELL = { z: -0.112, tilt: 12, r: 0.0165, len: 0.1 } as const;

const VOLT = { core: 0xdbe8ff, rim: 0x3a62ff, arc: 0xa8b8ff, accent: 0x5c9dff, sight: 0x9fc4ff } as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = CHAINLIGHTNING_VIEWMODEL;
  if (!def) throw new Error('chainlightning: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VOLT.sight, readout?.texture ?? null, def.glow);
  glow.accent.emissive.set(VOLT.accent);
  const ceramic = createCeramicMaterial('chainlightning', 0xd9d4c7);
  const arc = createEnergyMaterial('volt-arc', {
    core: VOLT.core,
    rim: VOLT.rim,
    rimPower: 1.2,
    noise: 1,
    noiseScale: 260,
    flow: [3, -5, 4],
  });
  const halo = createEnergyMaterial('volt-halo', {
    core: 0x2a44ff,
    rim: VOLT.arc,
    rimPower: 0.8,
    noise: 1,
    noiseScale: 150,
    flow: [-4, 6, 2],
    additive: true,
  });
  const jar = createEnergyMaterial('volt-jar', {
    core: 0x8fa8ff,
    rim: 0x2438d8,
    rimPower: 1.4,
    noise: 1,
    noiseScale: 190,
    flow: [1.5, 4, -1],
  });
  const b = new ModelBuilder('chainlightning', VIEWMODEL_ART.uvDensity);

  b.part('coils', [0, BORE_Y, (ROTOR.back + ROTOR.front) / 2]);
  b.part('prongs', [0, BORE_Y, HEAD_Z]);
  for (const [name, deg] of PRONGS) {
    const a = (deg * Math.PI) / 180;
    // Local +Y = radial direction: +X rotations swing the tip outward.
    b.part(name, [Math.cos(a) * PRONG_R, BORE_Y + Math.sin(a) * PRONG_R, HEAD_Z - 0.004], {
      rot: [0, 0, deg - 90],
      parent: 'prongs',
    });
  }
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('cell', [0, -0.012, CELL.z], { rot: [CELL.tilt, 0, 0] });
  b.part('sight', [0, 0.088, -0.018]);

  // --- receiver: blocky housing ---
  b.add(
    BODY,
    'gunmetal',
    profileX(
      [
        [-0.095, 0.062],
        [-0.03, 0.084],
        [0.0, 0.087],
        [0.145, 0.087],
        [ROTOR.back * -1 + 0.002, 0.078],
        [-ROTOR.back + 0.002, 0.016],
        [0.12, 0.012],
        [-0.03, 0.012],
        [-0.095, 0.03],
      ],
      0.058,
      { bevel: 0.003 },
    ),
    { paint: P.gunmetal.paint },
  );
  // Top deck + rail and the LED strip on the left top chamfer.
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.005, 0.165, 0.0015), {
    pos: [0, 0.088, -0.0625],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.012, 0.004, 0.14, 0.001), {
    pos: [-0.0245, 0.083, -0.04],
    rot: [0, 0, 40],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0056, 0.0012, 0.0085), {
      pos: [-0.0258, 0.0848, 0.022 - i * 0.0128],
      rot: [0, 0, 40],
      uv: ledUv(i, LEDS),
    });
  }
  // Conductor through glazed insulators along the left flank.
  b.add(BODY, 'darkMetal', roundedBox(0.004, 0.03, 0.2, 0.0015), {
    pos: [-0.029, 0.05, -0.05],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'brass', helixZ(0.0048, 0.0014, 0.19, 22), { pos: [-0.0368, 0.05, -0.05], paint: 0.8 });
  b.add(BODY, 'arc', cylinderZ(0.0022, 0.0022, 0.19, 8), { pos: [-0.0368, 0.05, -0.05] });
  for (let i = 0; i < 4; i++) {
    const z = 0.03 - i * 0.052;
    b.add(
      BODY,
      'ceramic',
      latheZHard(
        [
          [0.004, 0],
          [0.0105, 0],
          [0.0118, 0.002],
          [0.0118, 0.004],
          [0.0078, 0.006],
          [0.0078, 0.008],
          [0.0105, 0.01],
          [0.0105, 0.012],
          [0.004, 0.014],
        ],
        18,
      ),
      { pos: [-0.0368, 0.05, z + 0.007] },
    );
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [0.0292, 0.07, -0.04] });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [-0.0292, 0.07, -0.04] });

  // --- rotor bearings (static), rotor top bridge carrying the front sight post ---
  for (const z of [ROTOR.back - 0.004, ROTOR.front - 0.002]) {
    b.add(BODY, 'gunmetal', tubeZ(ROTOR.r + 0.014, ROTOR.r + 0.008, 0.01, 28), {
      pos: [0, BORE_Y, z + 0.005],
      paint: P.gunmetal.paint,
    });
  }
  b.add(BODY, 'darkMetal', roundedBox(0.014, 0.006, ROTOR.back - ROTOR.front + 0.012, 0.0015), {
    pos: [0, BORE_Y + ROTOR.r + 0.014, (ROTOR.back + ROTOR.front) / 2],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.012, 0.006, ROTOR.back - ROTOR.front + 0.012, 0.0015), {
    pos: [0, BORE_Y - ROTOR.r - 0.014, (ROTOR.back + ROTOR.front) / 2],
    paint: P.darkMetal.paint,
  });
  // Front sight post: a fin on the bridge with a glowing tip on the sight line.
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [0.24, BORE_Y + ROTOR.r + 0.016],
        [0.262, BORE_Y + ROTOR.r + 0.016],
        [0.258, SIGHT_Y - 0.0025],
        [0.252, SIGHT_Y - 0.0025],
      ],
      0.004,
      { bevel: 0.0008 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'sight', new BoxGeometry(0.0034, 0.0034, 0.0034), { pos: [0, SIGHT_Y - 0.0011, -0.255] });
  // Laser rail on the right bearing.
  b.add(BODY, 'darkMetal', roundedBox(0.004, 0.014, 0.03, 0.0012), {
    pos: [ROTOR.r + 0.017, BORE_Y, ROTOR.back - 0.01],
    paint: P.darkMetal.paint,
  });

  // --- rotor: core, copper windings, four ceramic fins with glowing edges ---
  const rotorLen = ROTOR.back - ROTOR.front;
  const rotorZ = (ROTOR.back + ROTOR.front) / 2;
  b.add('coils', 'darkMetal', cylinderZ(0.012, 0.012, rotorLen + 0.02, 16), {
    pos: [0, BORE_Y, rotorZ],
    paint: 0.4,
  });
  b.add('coils', 'brass', helixZ(0.0148, 0.0024, rotorLen - 0.012, 13), {
    pos: [0, BORE_Y, rotorZ],
    paint: 0.85,
  });
  for (let i = 0; i < 4; i++) {
    const a = 45 + i * 90;
    const r = (a * Math.PI) / 180;
    const fx = Math.cos(r);
    const fy = Math.sin(r);
    b.add('coils', 'ceramic', roundedBox(0.004, 0.012, rotorLen - 0.006, 0.0014), {
      pos: [fx * (ROTOR.r - 0.001), BORE_Y + fy * (ROTOR.r - 0.001), rotorZ],
      rot: [0, 0, a - 90],
    });
    b.add('coils', 'arc', new BoxGeometry(0.0016, 0.0018, rotorLen - 0.012), {
      pos: [fx * (ROTOR.r + 0.0055), BORE_Y + fy * (ROTOR.r + 0.0055), rotorZ],
      rot: [0, 0, a - 90],
    });
  }

  // --- emitter head: hex plate, glowing throat ---
  b.add(
    BODY,
    'gunmetal',
    profileZ(regularPolygonProfile(0.038, 6, 30), 0.018, {
      bevel: 0.002,
      holes: [regularPolygonProfile(0.01, 6, 30)],
    }),
    { pos: [0, BORE_Y, HEAD_Z + 0.006], paint: P.gunmetal.paint },
  );
  b.add(BODY, 'arc', new TorusGeometry(0.0095, 0.0018, 8, 20), {
    pos: [0, BORE_Y, HEAD_Z - 0.002],
    uv: 'keep',
  });
  b.add(
    BODY,
    'accent',
    profileZ(regularPolygonProfile(0.039, 6, 30), 0.003, {
      holes: [regularPolygonProfile(0.036, 6, 30)],
    }),
    { pos: [0, BORE_Y, HEAD_Z + 0.014] },
  );

  // --- claw prongs (each in its own part, curving out and back in) ---
  for (const [name, deg] of PRONGS) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const pt = (r: number, z: number): [number, number, number] => [c * r, BORE_Y + s * r, z];
    b.add(
      name,
      'darkMetal',
      bentTube(
        [
          pt(PRONG_R, HEAD_Z),
          pt(0.042, HEAD_Z - 0.035),
          pt(0.044, HEAD_Z - 0.075),
          pt(0.032, HEAD_Z - 0.105),
          pt(0.015, ARC_Z + 0.004),
        ],
        0.0046,
        24,
        8,
      ),
      { paint: 0.45 },
    );
    for (const [r, z] of [
      [0.0405, HEAD_Z - 0.03],
      [0.0442, HEAD_Z - 0.055],
    ] as const) {
      b.add(
        name,
        'ceramic',
        latheZHard(
          [
            [0.004, 0],
            [0.0072, 0.003],
            [0.0072, 0.011],
            [0.004, 0.014],
          ],
          12,
        ),
        {
          pos: pt(r, z + 0.007),
        },
      );
    }
    b.add(name, 'arc', new SphereGeometry(0.0042, 12, 8), { pos: pt(0.013, ARC_Z + 0.002) });
  }

  // --- the arc ball between the prong tips ---
  b.add(BODY, 'arc', new SphereGeometry(0.0055, 14, 10), { pos: [0, BORE_Y, ARC_Z] });
  b.add(BODY, 'halo', new SphereGeometry(0.011, 16, 12), { pos: [0, BORE_Y, ARC_Z], uv: 'keep' });

  // --- magwell, trigger guard, trigger, grip ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [0.066, 0.014],
        [0.158, 0.014],
        [0.156, -0.02],
        [0.07, -0.02],
      ],
      0.044,
      { bevel: 0.0025 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.014],
        [0.066, 0.014],
        [0.066, -0.024],
        [0.058, -0.032],
        [0.008, -0.032],
        [-0.004, -0.022],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, -0.002],
            [0.06, -0.002],
            [0.06, -0.021],
            [0.054, -0.027],
            [0.012, -0.027],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(
    'trigger',
    'darkMetal',
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
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'polymer', roundedBox(0.032, 0.104, 0.044, 0.008, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0342, 0.07, 0.035, 0.004), {
    pos: gripAxis(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- power pack stock with heat fins ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.04, 0.046, 0.01, 0.006), 0.13, { bevel: 0.003 }), {
    pos: [0, 0.035, 0.155],
    paint: P.gunmetal.paint,
  });
  // Flank heat fins with the glowing sinks between them.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = 0.108 + i * 0.018;
      b.add(BODY, 'darkMetal', roundedBox(0.006, 0.032, 0.004, 0.001), {
        pos: [side * 0.022, 0.035, z],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0025, 0.026, 0.012), { pos: [side * 0.0205, 0.035, z + 0.009] });
    }
  }
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.2, 0.056],
        [-0.3, 0.06],
        [-0.31, 0.052],
        [-0.31, -0.04],
        [-0.296, -0.046],
        [-0.22, -0.01],
        [-0.2, 0.022],
      ],
      0.042,
      {
        bevel: 0.004,
        holes: [
          [
            [-0.23, 0.044],
            [-0.28, 0.046],
            [-0.28, -0.018],
            [-0.23, 0.008],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.044, 0.116, 0.014, 0.004), {
    pos: [0, 0.014, 0.315],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- Leyden-jar cell: glass, crawling sparks, caps (local frame: −Y down the well) ---
  b.add('cell', 'jar', new CylinderGeometry(CELL.r - 0.003, CELL.r - 0.003, CELL.len - 0.026, 18), {
    local: true,
    pos: [0, -CELL.len / 2, 0],
  });
  b.add('cell', 'lens', new CylinderGeometry(CELL.r, CELL.r, CELL.len - 0.026, 18), {
    local: true,
    pos: [0, -CELL.len / 2, 0],
    uv: 'keep',
  });
  b.add('cell', 'gunmetal', new CylinderGeometry(CELL.r + 0.0016, CELL.r + 0.0016, 0.014, 18), {
    local: true,
    pos: [0, -0.007, 0],
    paint: 0.25,
  });
  b.add('cell', 'gunmetal', new CylinderGeometry(CELL.r + 0.0022, CELL.r + 0.0022, 0.013, 18), {
    local: true,
    pos: [0, -CELL.len + 0.0065, 0],
    paint: P.gunmetal.paint,
  });
  b.add('cell', 'accentPaint', new CylinderGeometry(CELL.r + 0.0026, CELL.r + 0.0026, 0.004, 18), {
    local: true,
    pos: [0, -CELL.len - 0.001, 0],
    paint: P.accentPaint.paint,
  });

  // --- rear aperture sight ---
  b.add('sight', 'gunmetal', roundedBox(0.016, SIGHT_Y - 0.094, 0.01, 0.0015), {
    pos: [0, (SIGHT_Y + 0.082) / 2, -0.018],
    paint: P.darkMetal.paint,
  });
  b.add('sight', 'gunmetal', tubeZ(0.0074, 0.0032, 0.005, 24), {
    pos: [0, SIGHT_Y, -0.0155],
    paint: P.gunmetal.paint,
  });
  b.add('sight', 'accent', new TorusGeometry(0.0053, 0.0005, 4, 28), { pos: [0, SIGHT_Y, -0.0152] });

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, ARC_Z - 0.004]);
  // No casings: the stock's heat fins stand in for the ejection port.
  b.socket('ejectPort', [0.024, 0.035, 0.14], [0, -90, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.014]);
  b.mount('optic', [0, 0.0905, -0.05]);
  b.mount('laser', [ROTOR.r + 0.019, BORE_Y, ROTOR.back - 0.01]);

  const built = b.build({ ...kit.materials, ...glow, arc, halo, jar, ceramic });
  return new EnergyWeaponModel(
    'chainlightning',
    def,
    built,
    glow,
    readoutSpec,
    readout,
    [
      {
        material: arc,
        intensity: 2.6,
        pulseRate: 3.1,
        pulseDepth: 0.2,
        flash: 5,
        boost: 7,
        flickerRate: 37,
        flickerDepth: 0.35,
      },
      {
        material: halo,
        intensity: 0.5,
        pulseRate: 2.3,
        pulseDepth: 0.3,
        flash: 1.5,
        boost: 3,
        flickerRate: 53,
        flickerDepth: 0.6,
      },
      {
        material: jar,
        intensity: 1.3,
        pulseRate: 1.4,
        pulseDepth: 0.25,
        boost: 1.5,
        flickerRate: 29,
        flickerDepth: 0.25,
      },
    ],
    { owned: [ceramic] },
  );
}

export const buildChainlightning: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const CHAINLIGHTNING_SIGHT_LINE = SIGHT_Y;
