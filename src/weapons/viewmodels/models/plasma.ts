/**
 * PL-2 „Sonnenwind“ – automatic plasma carbine (M5). Model content (meters, model space: origin =
 * grip pivot, barrel along −Z). A rounded receiver with a glass plasma cell clamped to the
 * shooter-facing left flank (aurora-green plasma churning inside), an open accelerator cage in
 * front holding three glowing magnetic rings around a plasma conduit, and a flared emitter bell.
 * Parts: cell (the magazine), coils (ring stack, kicks back per bolt), vents (louvre on top that
 * lifts with heat), trigger, sight (round holo ring). Seven-segment counter on the left rear.
 */
import { BoxGeometry, PlaneGeometry, TorusGeometry } from 'three';
import { PLASMA_VIEWMODEL } from '../../../defs/viewmodelData/plasma';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import {
  cylinderZ,
  latheZ,
  latheZHard,
  profileX,
  profileZ,
  regularPolygonProfile,
  roundedBox,
  tubeZ,
} from '../shapes';
import { createReadout, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import { EnergyWeaponModel, createEnergyMaterial, helixZ } from './energyKit';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.045;
/** Sight line: center of the holo ring. */
const SIGHT_Y = 0.118;
const GRIP_TILT = -17;
const GRIP_TOP = { y: 0.004, z: 0.012 } as const;
/** Plasma cell on the left flank: axis (x, y), front/back z, radius. */
const CELL = { x: -0.0385, y: 0.05, front: -0.138, back: -0.018, r: 0.0125 } as const;
const COIL_Z = [-0.215, -0.262, -0.309] as const;
const CAGE = { back: -0.165, front: -0.362, r: 0.029 } as const;

const PLASMA = { core: 0x7dffc8, rim: 0x0fb87a, accent: 0x2dffc0, sight: 0x8affda } as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = PLASMA_VIEWMODEL;
  if (!def) throw new Error('plasma: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'segments' };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(PLASMA.sight, readout?.texture ?? null, def.glow);
  glow.accent.emissive.set(PLASMA.accent);
  const plasma = createEnergyMaterial('plasma-cell', {
    core: PLASMA.core,
    rim: PLASMA.rim,
    rimPower: 1.3,
    noise: 1,
    noiseScale: 150,
    flow: [0.6, 1.2, -2.2],
  });
  const ring = createEnergyMaterial('plasma-ring', {
    core: 0xe8fff6,
    rim: PLASMA.rim,
    rimPower: 1.5,
    noise: 0.35,
    noiseScale: 200,
    flow: [0, 0, -3],
  });
  const stream = createEnergyMaterial('plasma-stream', {
    core: 0xd8fff0,
    rim: 0x0fd98c,
    rimPower: 1,
    noise: 0.9,
    noiseScale: 110,
    flow: [0, 0, -14],
  });
  const b = new ModelBuilder('plasma', VIEWMODEL_ART.uvDensity);

  b.part('cell', [CELL.x, CELL.y, (CELL.front + CELL.back) / 2]);
  b.part('coils', [0, BORE_Y, -0.262]);
  b.part('vents', [0, 0.083, -0.098]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('sight', [0, 0.087, -0.035]);

  // --- receiver: rounded shell, sloped nose ---
  b.add(
    BODY,
    'gunmetal',
    profileX(
      [
        [-0.105, 0.066],
        [-0.03, 0.084],
        [0.1, 0.084],
        [0.168, 0.072],
        [0.168, 0.02],
        [0.14, 0.012],
        [-0.03, 0.012],
        [-0.105, 0.028],
      ],
      0.052,
      { bevel: 0.005, bevelSegments: 3 },
    ),
    { paint: P.gunmetal.paint },
  );
  // Belly panel and the dark cradle plate the cell sits against (left flank).
  b.add(BODY, 'darkMetal', roundedBox(0.056, 0.014, 0.19, 0.004), {
    pos: [0, 0.017, -0.06],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.004, 0.036, 0.13, 0.0015), {
    pos: [-0.027, CELL.y, (CELL.front + CELL.back) / 2],
    paint: P.darkMetal.paint,
  });
  for (const z of [CELL.back - 0.004, CELL.front + 0.004]) {
    // Clamp brackets: half shells hugging the cell from the receiver side.
    b.add(BODY, 'gunmetal', tubeZ(CELL.r + 0.0035, CELL.r + 0.0008, 0.01, 20), {
      pos: [CELL.x, CELL.y, z + 0.005],
      paint: P.gunmetal.paint,
    });
    b.add(BODY, 'gunmetal', roundedBox(0.012, 0.012, 0.01, 0.002), {
      pos: [-0.031, CELL.y, z],
      paint: P.gunmetal.paint,
    });
  }
  // Contacts glowing at the cradle ends.
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.02, 0.0016), { pos: [-0.0292, CELL.y, CELL.back + 0.006] });
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.02, 0.0016), {
    pos: [-0.0292, CELL.y, CELL.front - 0.006],
  });
  // Accent seams along both flanks.
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [-0.0262, 0.0765, -0.03] });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [0.0262, 0.0765, -0.03] });

  // Top rail (behind the vent louvre).
  b.add(BODY, 'darkMetal', new BoxGeometry(0.02, 0.004, 0.13), {
    pos: [0, 0.0855, -0.02],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 9; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.0035, 0.0065), {
      pos: [0, 0.089, 0.036 - i * 0.0135],
      paint: P.darkMetal.paint,
    });
  }
  // Heat sink under the vent louvre (visible when it lifts) and its grille.
  b.add(BODY, 'heat', new BoxGeometry(0.034, 0.0015, 0.05), { pos: [0, 0.0838, -0.128] });
  for (let i = 0; i < 5; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.036, 0.003, 0.0022), {
      pos: [0, 0.0845, -0.108 - i * 0.01],
      paint: P.darkMetal.paint,
    });
  }

  // --- seven-segment counter, left rear, angled towards the shooter ---
  b.add(BODY, 'darkMetal', roundedBox(0.006, 0.02, 0.028, 0.0015), {
    pos: [-0.0275, 0.058, 0.062],
    rot: [0, 25, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'readout', new PlaneGeometry(0.021, 0.0165), {
    pos: [-0.0306, 0.058, 0.0635],
    rot: [0, -65, 0],
    uv: 'keep',
  });

  // --- accelerator cage: clamps, four bars, conduit, emitter bell ---
  for (const z of [CAGE.back, CAGE.front]) {
    b.add(
      BODY,
      'gunmetal',
      profileZ(regularPolygonProfile(CAGE.r + 0.006, 8, 22.5), 0.014, {
        bevel: 0.0015,
        holes: [regularPolygonProfile(CAGE.r - 0.007, 8, 22.5)],
      }),
      { pos: [0, BORE_Y, z], paint: P.gunmetal.paint },
    );
  }
  const barLen = CAGE.back - CAGE.front;
  const barZ = (CAGE.back + CAGE.front) / 2;
  for (const [x, y, w, h] of [
    [0, CAGE.r, 0.012, 0.006],
    [0, -CAGE.r, 0.012, 0.006],
    [-CAGE.r, 0, 0.006, 0.012],
    [CAGE.r, 0, 0.006, 0.012],
  ] as const) {
    b.add(BODY, 'darkMetal', roundedBox(w, h, barLen, 0.0018), {
      pos: [x, BORE_Y + y, barZ],
      paint: P.darkMetal.paint,
    });
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0016, 0.0012, barLen - 0.02), {
    pos: [0, BORE_Y + CAGE.r + 0.0031, barZ],
  });
  b.add(BODY, 'stream', cylinderZ(0.0052, 0.0052, barLen + 0.02, 12), { pos: [0, BORE_Y, barZ] });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.011, 0],
        [0.021, 0],
        [0.025, 0.022],
        [0.03, 0.036],
        [0.027, 0.04],
        [0.018, 0.012],
        [0.011, 0.006],
      ],
      24,
    ),
    { pos: [0, BORE_Y, CAGE.front - 0.004], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'ring', new TorusGeometry(0.0205, 0.0022, 8, 28), {
    pos: [0, BORE_Y, CAGE.front - 0.034],
    uv: 'keep',
  });
  b.add(
    BODY,
    'heat',
    latheZ(
      [
        [0.012, 0],
        [0.019, 0.026],
      ],
      20,
    ),
    { pos: [0, BORE_Y, CAGE.front - 0.008] },
  );
  // Laser rail on the right of the front clamp, rail under the cage.
  b.add(BODY, 'darkMetal', roundedBox(0.004, 0.014, 0.036, 0.0012), {
    pos: [0.037, BORE_Y, CAGE.front + 0.03],
    paint: P.darkMetal.paint,
  });

  // --- coil stack: glowing rings on copper windings (kicks back per bolt) ---
  for (const z of COIL_Z) {
    b.add('coils', 'brass', helixZ(0.0165, 0.0019, 0.018, 5), { pos: [0, BORE_Y, z], paint: 0.8 });
    b.add('coils', 'ring', new TorusGeometry(0.0178, 0.0034, 10, 30), {
      pos: [0, BORE_Y, z - 0.012],
      uv: 'keep',
    });
    b.add('coils', 'darkMetal', new TorusGeometry(0.0182, 0.0026, 8, 30), {
      pos: [0, BORE_Y, z + 0.011],
      paint: 0.4,
    });
  }

  // --- foregrip under the cage ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [0.19, BORE_Y - CAGE.r - 0.002],
        [0.25, BORE_Y - CAGE.r - 0.002],
        [0.238, -0.052],
        [0.222, -0.058],
        [0.208, -0.052],
      ],
      0.026,
      { bevel: 0.004, bevelSegments: 2 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.0272, 0.04, 0.03, 0.004), {
    pos: [0, -0.03, -0.224],
    rot: [-10, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- trigger guard, trigger, grip ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.014],
        [0.064, 0.014],
        [0.064, -0.024],
        [0.056, -0.032],
        [0.008, -0.032],
        [-0.004, -0.022],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, -0.002],
            [0.058, -0.002],
            [0.058, -0.021],
            [0.052, -0.027],
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
  b.add(BODY, 'polymer', roundedBox(0.031, 0.104, 0.043, 0.008, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0332, 0.07, 0.034, 0.004), {
    pos: gripAxis(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- stubby stock ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.1, 0.07],
        [-0.25, 0.064],
        [-0.262, 0.052],
        [-0.262, -0.036],
        [-0.25, -0.042],
        [-0.18, -0.024],
        [-0.1, 0.02],
      ],
      0.038,
      {
        bevel: 0.004,
        holes: [
          [
            [-0.135, 0.054],
            [-0.225, 0.052],
            [-0.225, -0.014],
            [-0.17, 0.004],
            [-0.135, 0.026],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.042, 0.108, 0.014, 0.004), {
    pos: [0, 0.012, 0.268],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'accentPaint', roundedBox(0.0404, 0.012, 0.008, 0.002), {
    pos: [0, 0.03, 0.262],
    paint: P.accentPaint.paint,
  });

  // --- plasma cell: glass capsule, churning plasma core, metal end caps ---
  const cellLen = CELL.back - CELL.front;
  const cellZ = (CELL.front + CELL.back) / 2;
  b.add('cell', 'plasma', cylinderZ(CELL.r - 0.0022, CELL.r - 0.0022, cellLen - 0.018, 16), {
    pos: [CELL.x, CELL.y, cellZ],
  });
  b.add('cell', 'lens', cylinderZ(CELL.r, CELL.r, cellLen - 0.018, 20), {
    pos: [CELL.x, CELL.y, cellZ],
    uv: 'keep',
  });
  for (const [z, dir] of [
    [CELL.front, 1],
    [CELL.back, -1],
  ] as const) {
    b.add(
      'cell',
      'gunmetal',
      latheZHard(
        [
          [0, 0],
          [CELL.r * 0.55, 0],
          [CELL.r + 0.0012, 0.005],
          [CELL.r + 0.0012, 0.012],
          [CELL.r - 0.002, 0.012],
        ],
        20,
      ),
      { pos: [CELL.x, CELL.y, z], rot: [0, dir > 0 ? 180 : 0, 0], paint: P.gunmetal.paint },
    );
  }
  b.add('cell', 'brass', cylinderZ(0.004, 0.004, 0.006, 12), {
    pos: [CELL.x, CELL.y, CELL.back + 0.002],
    paint: 0.8,
  });
  b.add('cell', 'accentPaint', tubeZ(CELL.r + 0.0014, CELL.r - 0.001, 0.004, 20), {
    pos: [CELL.x, CELL.y, CELL.front + 0.02],
    paint: P.accentPaint.paint,
  });

  // --- vent louvre (hinged at its rear edge) ---
  b.add('vents', 'gunmetal', roundedBox(0.04, 0.004, 0.062, 0.0015), {
    pos: [0, 0.0875, -0.13],
    paint: P.gunmetal.paint,
  });
  for (let i = 0; i < 4; i++) {
    b.add('vents', 'darkMetal', roundedBox(0.034, 0.0024, 0.006, 0.001), {
      pos: [0, 0.0905, -0.108 - i * 0.014],
      paint: P.darkMetal.paint,
    });
  }

  // --- holo ring sight ---
  b.add('sight', 'darkMetal', roundedBox(0.014, 0.012, 0.026, 0.002), {
    pos: [0, 0.093, -0.036],
    paint: 0.4,
  });
  b.add('sight', 'gunmetal', tubeZ(0.0175, 0.0142, 0.012, 32), {
    pos: [0, SIGHT_Y, -0.03],
    paint: P.gunmetal.paint,
  });
  b.add('sight', 'accent', new TorusGeometry(0.0176, 0.0007, 4, 40), { pos: [0, SIGHT_Y, -0.0302] });
  b.add('sight', 'darkMetal', roundedBox(0.008, 0.006, 0.014, 0.0015), {
    pos: [0, SIGHT_Y - 0.019, -0.03],
    paint: 0.4,
  });
  b.add('sight', 'lens', new PlaneGeometry(0.029, 0.029), { pos: [0, SIGHT_Y, -0.041], uv: 'keep' });
  b.add('sight', 'sight', new TorusGeometry(0.0055, 0.00035, 4, 36), { pos: [0, SIGHT_Y, -0.0413] });
  b.add('sight', 'sight', cylinderZ(0.00065, 0.00065, 0.0003, 10), { pos: [0, SIGHT_Y, -0.0413] });

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, CAGE.front - 0.04]);
  // No casings: the vent louvre stands in for the ejection port (heat puffs).
  b.socket('ejectPort', [0, 0.09, -0.12], [60, 0, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.022]);
  b.mount('optic', [0, 0.0915, -0.035]);
  b.mount('laser', [0.039, BORE_Y, CAGE.front + 0.03]);
  b.mount('underbarrel', [0, BORE_Y - CAGE.r - 0.004, -0.19]);

  const built = b.build({ ...kit.materials, ...glow, plasma, ring, stream });
  return new EnergyWeaponModel('plasma', def, built, glow, readoutSpec, readout, [
    { material: plasma, intensity: 1.15, pulseRate: 1.7, pulseDepth: 0.25, flash: 1, heat: 1 },
    { material: ring, intensity: 2.4, pulseRate: 2.6, pulseDepth: 0.12, flash: 6, heat: 2 },
    { material: stream, intensity: 1.9, pulseRate: 5.3, pulseDepth: 0.15, flash: 9, heat: 3 },
  ]);
}

export const buildPlasma: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const PLASMA_SIGHT_LINE = SIGHT_Y;
