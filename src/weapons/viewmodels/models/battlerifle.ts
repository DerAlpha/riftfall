/**
 * SR-17 „Hammerschlag“ – heavy semi-auto battle rifle. Model content (meters, model space: origin =
 * grip pivot, barrel along −Z). Chunky slab-sided receiver with a full-length top rail, a reciprocating
 * charging handle forward on the left, the bolt face behind the right ejection port, a straight
 * 20-round box, a long octagonal handguard with glowing heat louvres and a boxy three-port "hammer"
 * brake whose ports glow when hot. Sight: an open holographic window with a ring-and-dot reticle.
 * Two-digit counter on the left rear, angled towards the shooter.
 */
import { BoxGeometry, PlaneGeometry, TorusGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BATTLERIFLE_VIEWMODEL } from '../../../defs/viewmodelData/battlerifle';
import type { ViewmodelBuilder } from '../index';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials } from '../materials';
import {
  chamferRectProfile,
  cylinderX,
  cylinderZ,
  latheZHard,
  profileX,
  profileZ,
  roundedBox,
  tiltedAxisPoint,
} from '../shapes';
import { ProceduralWeaponModel, createReadout, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.052;
const RAIL_TOP = 0.089;
/** Center of the holographic window (sight line). */
const SIGHT_Y = 0.1155;
const SIGHT_REAR = -0.02;
const SIGHT_FRONT = -0.07;
const GRIP_TILT = -20;
const MUZZLE_Z = -0.738;

const grip = (s: number): [number, number, number] => tiltedAxisPoint(GRIP_TILT, 0.002, 0.012, s);

export const buildBattlerifle: ViewmodelBuilder = (kit) => {
  const def = BATTLERIFLE_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'segments' };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.redDot, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('battlerifle', VIEWMODEL_ART.uvDensity);

  b.part('bolt', [0.0245, 0.058, -0.045]);
  b.part('chargingHandle', [-0.027, 0.067, -0.15]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('magazine', [0, 0.0, -0.105]);
  b.part('sight', [0, RAIL_TOP, -0.045]);

  // --- upper receiver: slab sides, heavy top chamfers ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.052, 0.056, 0.011, 0.004), 0.36, { bevel: 0.0022 }), {
    pos: [0, 0.054, -0.07],
    paint: P.gunmetal.paint,
  });
  // Raised side plates (machined inserts) with bolt heads.
  for (const side of [-1, 1]) {
    b.add(BODY, 'darkMetal', roundedBox(0.002, 0.022, 0.13, 0.0008), {
      pos: [side * 0.0265, 0.046, 0.02],
      paint: P.darkMetal.paint,
    });
    for (const z of [-0.035, 0.075]) {
      b.add(BODY, 'gunmetal', cylinderX(0.0026, 0.003, 8), { pos: [side * 0.028, 0.046, z], paint: 0.6 });
    }
  }
  // Top rail from the sight base forward (the receiver behind it stays flat: nothing under the eye).
  b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.006, 0.52), {
    pos: [0, RAIL_TOP - 0.005, -0.24],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 40; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.0035, 0.0062), {
      pos: [0, RAIL_TOP - 0.00175, 0.012 - i * 0.0128],
      paint: P.darkMetal.paint,
    });
  }
  // Rear top cover: a sloped armour plate over the action.
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-0.105, 0.078],
        [0.02, 0.078],
        [0.02, 0.086],
        [-0.03, 0.086],
        [-0.105, 0.082],
      ],
      0.036,
      { bevel: 0.0015 },
    ),
    { paint: P.darkMetal.paint },
  );
  // Ejection port (right) and charging slot (left, forward).
  b.add(BODY, 'bore', new BoxGeometry(0.0008, 0.017, 0.064), { pos: [0.0262, 0.058, -0.045] });
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.0065, 0.12), { pos: [-0.0262, 0.067, -0.16] });
  // Accent strips: under the charging slot and along the handguard's upper-left chamfer.
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0016, 0.21), { pos: [-0.0265, 0.0585, -0.07] });
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0024, 0.23), {
    pos: [-0.0222, BORE_Y + 0.0232, -0.39],
    rot: [0, 0, 45],
  });

  // --- ammo counter (left rear, angled towards the shooter) ---
  b.add(BODY, 'darkMetal', roundedBox(0.0065, 0.022, 0.031, 0.0015), {
    pos: [-0.0285, 0.06, 0.066],
    rot: [0, 25, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'readout', new PlaneGeometry(0.023, 0.018), {
    pos: [-0.0318, 0.06, 0.0675],
    rot: [0, -65, 0],
    uv: 'keep',
  });

  // --- lower receiver + flared magwell, trigger guard ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.11, 0.031],
        [0.15, 0.031],
        [0.15, 0.012],
        [0.143, 0.004],
        [0.141, -0.03],
        [0.07, -0.03],
        [0.068, 0.0],
        [-0.03, 0.0],
        [-0.11, 0.014],
      ],
      0.047,
      { bevel: 0.0025 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.002],
        [0.068, 0.002],
        [0.068, -0.024],
        [0.06, -0.033],
        [0.008, -0.033],
        [-0.004, -0.022],
      ],
      0.013,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, -0.004],
            [0.062, -0.004],
            [0.062, -0.022],
            [0.056, -0.028],
            [0.012, -0.028],
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
        [0.032, 0.0],
        [0.039, 0.0],
        [0.04, -0.009],
        [0.037, -0.02],
        [0.031, -0.023],
        [0.033, -0.012],
      ],
      0.0065,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );
  // Magazine release + bolt catch paddle (accent paint).
  b.add(BODY, 'accentPaint', roundedBox(0.0028, 0.008, 0.01, 0.001), {
    pos: [0.0245, 0.012, -0.066],
    paint: P.accentPaint.paint,
  });
  b.add(BODY, 'accentPaint', roundedBox(0.012, 0.004, 0.014, 0.001), {
    pos: [0, -0.0305, -0.155],
    paint: P.accentPaint.paint,
  });

  // --- grip ---
  b.add(BODY, 'polymer', roundedBox(0.031, 0.108, 0.043, 0.007, 3), {
    pos: grip(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0332, 0.072, 0.035, 0.004), {
    pos: grip(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- stock: solid slab with a cut that shows the hydraulic recoil buffer, cheek riser, thick pad ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.105, 0.08],
        [-0.34, 0.076],
        [-0.352, 0.064],
        [-0.352, -0.058],
        [-0.336, -0.066],
        [-0.24, -0.038],
        [-0.17, -0.008],
        [-0.105, 0.014],
      ],
      0.042,
      {
        bevel: 0.003,
        holes: [
          [
            [-0.165, 0.052],
            [-0.305, 0.05],
            [-0.305, 0.004],
            [-0.24, -0.012],
            [-0.165, 0.018],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'gunmetal', cylinderZ(0.0095, 0.0095, 0.18, 16), { pos: [0, 0.032, 0.235], paint: 0.55 });
  b.add(BODY, 'darkMetal', cylinderZ(0.0125, 0.0125, 0.03, 16), {
    pos: [0, 0.032, 0.15],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', cylinderZ(0.0128, 0.0128, 0.003, 16), { pos: [0, 0.032, 0.17] });
  b.add(BODY, 'grip', roundedBox(0.046, 0.134, 0.02, 0.005), {
    pos: [0, 0.006, 0.362],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  // Cheek pad seated on the comb.
  b.add(BODY, 'darkMetal', roundedBox(0.034, 0.009, 0.13, 0.003), {
    pos: [0, 0.0815, 0.245],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0022, 0.12), { pos: [-0.0213, 0.066, 0.24] });

  // --- handguard: long octagon with heat louvres, bottom + left rail sections ---
  b.add(
    BODY,
    'gunmetal',
    profileZ(chamferRectProfile(0.056, 0.058, 0.015, 0.012), 0.27, {
      bevel: 0.002,
      holes: [chamferRectProfile(0.04, 0.042, 0.01, 0.008)],
    }),
    { pos: [0, BORE_Y, -0.385], paint: P.gunmetal.paint },
  );
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = -0.29 - i * 0.034;
      b.add(BODY, 'darkMetal', new BoxGeometry(0.0014, 0.026, 0.014), {
        pos: [side * 0.0282, BORE_Y - 0.002, z],
        rot: [28, 0, 0],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.021, 0.008), {
        pos: [side * 0.0287, BORE_Y - 0.002, z],
        rot: [28, 0, 0],
      });
    }
  }
  b.add(BODY, 'darkMetal', new BoxGeometry(0.02, 0.005, 0.15), {
    pos: [0, BORE_Y - 0.0315, -0.41],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 9; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.003, 0.0065), {
      pos: [0, BORE_Y - 0.0345, -0.345 - i * 0.0155],
      paint: P.darkMetal.paint,
    });
  }
  b.add(BODY, 'darkMetal', new BoxGeometry(0.005, 0.018, 0.07), {
    pos: [-0.0305, BORE_Y, -0.465],
    paint: P.darkMetal.paint,
  });
  // The "hammer head": a heavy bolted collar closing the handguard, and a swept hand stop.
  b.add(
    BODY,
    'darkMetal',
    profileZ(chamferRectProfile(0.064, 0.066, 0.018, 0.015), 0.034, {
      bevel: 0.002,
      holes: [chamferRectProfile(0.03, 0.03, 0.006)],
    }),
    { pos: [0, BORE_Y, -0.506], paint: P.darkMetal.paint },
  );
  for (const side of [-1, 1]) {
    for (const y of [BORE_Y + 0.016, BORE_Y - 0.016]) {
      b.add(BODY, 'gunmetal', cylinderX(0.0028, 0.003, 8), { pos: [side * 0.0325, y, -0.506], paint: 0.6 });
    }
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.024, 0.0022), { pos: [-0.0323, BORE_Y, -0.494] });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [0.29, BORE_Y - 0.03],
        [0.33, BORE_Y - 0.03],
        [0.318, BORE_Y - 0.058],
        [0.305, BORE_Y - 0.06],
      ],
      0.02,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );

  // --- barrel, gas block, three-port hammer brake ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0115, 0.0115, 0.42, 18), {
    pos: [0, BORE_Y, -0.455],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.026, 0.03, 0.022, 0.003), {
    pos: [0, BORE_Y + 0.003, -0.538],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'gunmetal',
    latheZHard(
      [
        [0.0, 0.0],
        [0.0135, 0.0],
        [0.0135, 0.012],
      ],
      18,
    ),
    { pos: [0, BORE_Y, -0.652], paint: P.gunmetal.paint },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.036, 0.032, 0.074, 0.004, 2), {
    pos: [0, BORE_Y + 0.001, -0.701],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 3; i++) {
    const z = -0.68 - i * 0.021;
    b.add(BODY, 'bore', new BoxGeometry(0.0372, 0.019, 0.012), { pos: [0, BORE_Y, z] });
    b.add(BODY, 'heat', new BoxGeometry(0.03, 0.013, 0.002), { pos: [0, BORE_Y, z + 0.005] });
    b.add(BODY, 'bore', new BoxGeometry(0.008, 0.0332, 0.006), { pos: [0, BORE_Y + 0.001, z - 0.01] });
  }
  b.add(BODY, 'bore', cylinderZ(0.0068, 0.0068, 0.0012, 16), { pos: [0, BORE_Y, MUZZLE_Z + 0.0005] });

  // --- charging handle (left, forward, reciprocating) ---
  b.add('chargingHandle', 'darkMetal', cylinderX(0.0032, 0.016, 10), {
    pos: [-0.034, 0.067, -0.15],
    paint: P.darkMetal.paint,
  });
  b.add('chargingHandle', 'accentPaint', roundedBox(0.012, 0.014, 0.018, 0.003), {
    pos: [-0.045, 0.067, -0.15],
    paint: P.accentPaint.paint,
  });

  // --- bolt face behind the ejection port ---
  b.add('bolt', 'gunmetal', roundedBox(0.0018, 0.013, 0.026, 0.0006), {
    pos: [0.0254, 0.058, -0.045],
    paint: 0.5,
  });

  // --- 20-round box ---
  b.add(
    'magazine',
    'polymer',
    profileX(
      [
        [0.075, 0.0],
        [0.137, 0.0],
        [0.143, -0.06],
        [0.156, -0.122],
        [0.097, -0.13],
        [0.086, -0.06],
      ],
      0.029,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  for (let i = 0; i < 3; i++) {
    b.add('magazine', 'darkMetal', new BoxGeometry(0.0302, 0.0028, 0.05), {
      pos: [0, -0.032 - i * 0.03, -(0.11 + i * 0.006)],
      rot: [6 + i * 3, 0, 0],
      paint: P.darkMetal.paint,
    });
  }
  // Witness window on the left: brass rounds stacked inside.
  b.add('magazine', 'bore', new BoxGeometry(0.0008, 0.07, 0.012), {
    pos: [-0.0147, -0.056, -0.108],
    rot: [6, 0, 0],
  });
  for (let i = 0; i < 5; i++) {
    b.add('magazine', 'brass', cylinderZ(0.0045, 0.0045, 0.011, 10), {
      pos: [-0.011, -0.03 - i * 0.013, -0.108 - i * 0.0015],
      paint: 1,
    });
  }
  b.add('magazine', 'accentPaint', roundedBox(0.034, 0.01, 0.066, 0.003), {
    pos: [0, -0.13, -0.127],
    rot: [7.5, 0, 0],
    paint: P.accentPaint.paint,
  });

  // --- holographic sight: base, open hood, glass, ring-and-dot reticle ---
  b.add('sight', 'darkMetal', roundedBox(0.034, 0.009, 0.066, 0.002), {
    pos: [0, RAIL_TOP + 0.0045, -0.038],
    paint: P.darkMetal.paint,
  });
  b.add(
    'sight',
    'gunmetal',
    profileZ(chamferRectProfile(0.044, 0.036, 0.008, 0.002), SIGHT_REAR - SIGHT_FRONT, {
      bevel: 0.0015,
      holes: [chamferRectProfile(0.035, 0.027, 0.006, 0.001)],
    }),
    { pos: [0, SIGHT_Y, (SIGHT_REAR + SIGHT_FRONT) / 2], paint: P.gunmetal.paint },
  );
  // Battery housing + buttons at the rear.
  b.add('sight', 'darkMetal', roundedBox(0.03, 0.013, 0.022, 0.002), {
    pos: [0, RAIL_TOP + 0.012, 0.004],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.008, 0.008]) {
    b.add('sight', 'accent', roundedBox(0.006, 0.002, 0.004, 0.0006), { pos: [x, RAIL_TOP + 0.0188, 0.006] });
  }
  b.add('sight', 'lens', new PlaneGeometry(0.035, 0.027), {
    pos: [0, SIGHT_Y, SIGHT_FRONT + 0.002],
    uv: 'keep',
  });
  b.add('sight', 'lens', new PlaneGeometry(0.035, 0.027), {
    pos: [0, SIGHT_Y, SIGHT_REAR - 0.002],
    uv: 'keep',
  });
  const rz = SIGHT_FRONT + 0.0025;
  b.add('sight', 'sight', new TorusGeometry(0.0062, 0.00034, 6, 48), { pos: [0, SIGHT_Y, rz] });
  b.add('sight', 'sight', cylinderZ(0.0007, 0.0007, 0.0004, 12), { pos: [0, SIGHT_Y, rz] });
  for (const [x, y, w, h] of [
    [0, 0.0072, 0.0006, 0.0018],
    [0, -0.0072, 0.0006, 0.0018],
    [0.0072, 0, 0.0018, 0.0006],
    [-0.0072, 0, 0.0018, 0.0006],
  ] as const) {
    b.add('sight', 'sight', new BoxGeometry(w, h, 0.0004), { pos: [x, SIGHT_Y + y, rz] });
  }

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.028, 0.058, -0.045], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, SIGHT_REAR + 0.002]);
  b.mount('optic', [0, RAIL_TOP, -0.045]);
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, BORE_Y - 0.0365, -0.41]);
  b.mount('laser', [-0.033, BORE_Y, -0.465], [0, 0, 90]);
  b.mount('stock', [0, 0.054, 0.11]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('battlerifle', def, built, glow, readoutSpec, readout);
};

export const BATTLERIFLE_SIGHT_LINE = SIGHT_Y;
