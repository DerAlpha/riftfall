/**
 * DB-2 „Zwilling“ – side-by-side break-action shotgun. Model content (meters, model space: origin =
 * grip pivot, barrel along −Z). Parts: barrels (the whole barrel block with rib, fore-end and choke
 * rings, pivoting on the glowing hinge pin), shells (two, children of the barrels, hidden at rest –
 * shown while being extracted / loaded), external hammers (cocked at rest), top lever, trigger.
 * The vented rib glows with heat; a bead on the rib and a notch on the action form the sights; two
 * shell LEDs on the left flank of the action and three spare shells in a side saddle on the stock.
 */
import { BoxGeometry, SphereGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { DOUBLEBARREL_VIEWMODEL } from '../../../defs/viewmodelData/doublebarrel';
import { getWeaponDef } from '../../../defs/weapons';
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
import { ProceduralWeaponModel, createReadout, ledUv, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

const BARREL_Y = 0.056;
const BARREL_X = 0.0125;
const BARREL_R = 0.0118;
/** Breech face (rear of the chambers) and muzzle. */
const BREECH_Z = -0.07;
const MUZZLE_Z = -0.5;
/** Hinge pin the barrels pivot on. */
const HINGE: readonly [number, number, number] = [0, 0.034, -0.08];
const RIB_TOP = 0.0745;
/** Bead center = sight line. */
const SIGHT_Y = 0.0776;
const BEAD_R = 0.0031;
const GRIP_TILT = -18;
const LEDS = 2;

const grip = (s: number): [number, number, number] => tiltedAxisPoint(GRIP_TILT, 0.006, 0.012, s);

export const buildDoublebarrel: ViewmodelBuilder = (kit) => {
  const def = DOUBLEBARREL_VIEWMODEL;
  const leds = Math.max(1, Math.min(LEDS, getWeaponDef('doublebarrel')?.magazine ?? LEDS));
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: leds };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.tritium, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('doublebarrel', VIEWMODEL_ART.uvDensity);

  b.part('barrels', HINGE);
  b.part('shells', [0, BARREL_Y, BREECH_Z], { parent: 'barrels', hidden: true });
  b.part('hammers', [0, 0.058, 0.008]);
  b.part('lever', [0, 0.07, 0.026]);
  b.part('trigger', [0, 0.012, -0.03]);

  // --- action: L-shaped frame with the standing breech, rounded knuckle and tang ---
  b.add(
    BODY,
    'gunmetal',
    profileX(
      [
        [-0.04, 0.062],
        [-0.01, 0.07],
        [0.068, 0.07],
        [0.068, 0.044],
        [0.094, 0.044],
        [0.101, 0.037],
        [0.099, 0.027],
        [0.088, 0.019],
        [0.04, 0.016],
        [-0.04, 0.016],
      ],
      0.05,
      { bevel: 0.0025 },
    ),
    { paint: P.gunmetal.paint },
  );
  // Engraved side panels + hinge pin (glowing caps).
  for (const side of [-1, 1]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0016, 0.026, 0.05, 0.0008), {
      pos: [side * 0.0253, 0.042, -0.032],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'accent', cylinderX(0.0048, 0.0014, 16), { pos: [side * 0.0258, HINGE[1], HINGE[2]] });
  }
  b.add(BODY, 'gunmetal', cylinderX(0.004, 0.0516, 14), { pos: HINGE, paint: 0.6 });
  // Shell LEDs (left flank).
  b.add(BODY, 'darkMetal', roundedBox(0.0014, 0.009, leds * 0.013 + 0.005, 0.0005), {
    pos: [-0.0262, 0.058, -0.028 - ((leds - 1) * 0.013) / 2],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < leds; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0012, 0.0048, 0.008), {
      pos: [-0.0268, 0.058, -0.028 - i * 0.013],
      uv: ledUv(i, leds),
    });
  }
  // Rear notch with glowing dots (the bead sits between them when aimed).
  b.add(BODY, 'darkMetal', roundedBox(0.016, 0.006, 0.01, 0.0015), {
    pos: [0, 0.073, -0.058],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.0048, 0.0048]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0042, 0.0062, 0.008, 0.0008), {
      pos: [x, SIGHT_Y - 0.0006, -0.058],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'accent', new BoxGeometry(0.0016, 0.0016, 0.0006), { pos: [x, SIGHT_Y - 0.0008, -0.0538] });
  }

  // --- trigger frame, guard, trigger ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.018],
        [0.066, 0.018],
        [0.066, -0.01],
        [0.058, -0.02],
        [0.006, -0.02],
        [-0.004, -0.008],
      ],
      0.013,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, 0.012],
            [0.058, 0.012],
            [0.058, -0.007],
            [0.052, -0.014],
            [0.012, -0.014],
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
        [0.028, 0.016],
        [0.034, 0.016],
        [0.035, 0.005],
        [0.032, -0.006],
        [0.027, -0.009],
        [0.029, 0.002],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

  // --- grip + coach stock with cheek plate, glowing inlay and a side saddle of spare shells ---
  b.add(BODY, 'polymer', roundedBox(0.031, 0.106, 0.044, 0.007, 3), {
    pos: grip(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0332, 0.07, 0.036, 0.004), {
    pos: grip(0.056),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.036, 0.062],
        [-0.3, 0.063],
        [-0.308, 0.053],
        [-0.308, -0.058],
        [-0.294, -0.064],
        [-0.12, -0.012],
        [-0.036, 0.018],
      ],
      0.038,
      { bevel: 0.003 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.042, 0.126, 0.018, 0.004), {
    pos: [0, 0.0, 0.314],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  // Cheek plate behind the aimed eye (it would fill the sight picture further forward).
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.01, 0.09, 0.003), {
    pos: [0, 0.068, 0.25],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0022, 0.14), { pos: [0.0193, 0.04, 0.19] });
  b.add(BODY, 'darkMetal', roundedBox(0.004, 0.028, 0.1, 0.0015), {
    pos: [-0.0205, 0.018, 0.2],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 3; i++) {
    const y = 0.027 - i * 0.0095;
    b.add(BODY, 'shellHull', cylinderZ(0.0045, 0.0045, 0.05, 12), { pos: [-0.0255, y, 0.2], paint: 1 });
    b.add(BODY, 'brass', cylinderZ(0.0049, 0.0049, 0.012, 12), { pos: [-0.0255, y, 0.231], paint: 1 });
  }

  // --- barrels: two tubes, vented rib, choke rings, beavertail fore-end ---
  const barrelLen = BREECH_Z - MUZZLE_Z;
  for (const x of [-BARREL_X, BARREL_X]) {
    b.add('barrels', 'darkMetal', cylinderZ(BARREL_R, BARREL_R, barrelLen, 22), {
      pos: [x, BARREL_Y, (BREECH_Z + MUZZLE_Z) / 2],
      paint: P.darkMetal.paint,
    });
    b.add(
      'barrels',
      'darkMetal',
      latheZHard(
        [
          [BARREL_R, 0],
          [BARREL_R + 0.0014, 0.002],
          [BARREL_R + 0.0014, 0.018],
          [BARREL_R + 0.0004, 0.02],
          [0.0092, 0.02],
        ],
        22,
      ),
      { pos: [x, BARREL_Y, MUZZLE_Z + 0.02], paint: P.darkMetal.paint },
    );
    b.add('barrels', 'bore', cylinderZ(0.0092, 0.0092, 0.001, 18), { pos: [x, BARREL_Y, MUZZLE_Z - 0.0006] });
    // Chamber mouths (seen when broken open).
    b.add('barrels', 'bore', cylinderZ(0.0098, 0.0098, 0.001, 18), { pos: [x, BARREL_Y, BREECH_Z + 0.0004] });
    // Sci-fi coil band near the muzzle.
    b.add(
      'barrels',
      'accent',
      latheZHard(
        [
          [BARREL_R + 0.0008, 0],
          [BARREL_R + 0.0008, 0.003],
        ],
        22,
      ),
      {
        pos: [x, BARREL_Y, MUZZLE_Z + 0.05],
      },
    );
  }
  // Monoblock around the chambers + extractor.
  b.add('barrels', 'darkMetal', roundedBox(0.05, 0.028, 0.04, 0.003), {
    pos: [0, BARREL_Y - 0.002, BREECH_Z - 0.02],
    paint: P.darkMetal.paint,
  });
  b.add(
    'barrels',
    'darkMetal',
    profileZ(chamferRectProfile(0.012, 0.006, 0.0015), barrelLen - 0.04, { bevel: 0.0008 }),
    {
      pos: [0, RIB_TOP - 0.003, (BREECH_Z + MUZZLE_Z) / 2 - 0.02],
      paint: P.darkMetal.paint,
    },
  );
  for (let i = 0; i < 9; i++) {
    b.add('barrels', 'heat', new BoxGeometry(0.0085, 0.0012, 0.02), {
      pos: [0, RIB_TOP - 0.0003, BREECH_Z - 0.07 - i * 0.036],
    });
  }
  b.add('barrels', 'sight', new SphereGeometry(BEAD_R, 14, 10), { pos: [0, SIGHT_Y, MUZZLE_Z + 0.012] });
  b.add(
    'barrels',
    'polymer',
    profileZ(
      [
        [0.0265, 0.048],
        [0.0265, 0.036],
        [0.02, 0.026],
        [-0.02, 0.026],
        [-0.0265, 0.036],
        [-0.0265, 0.048],
      ],
      0.2,
      { bevel: 0.002 },
    ),
    { pos: [0, 0, BREECH_Z - 0.13], paint: P.polymer.paint },
  );
  for (const side of [-1, 1]) {
    b.add('barrels', 'grip', roundedBox(0.002, 0.012, 0.13, 0.001), {
      pos: [side * 0.0265, 0.037, BREECH_Z - 0.13],
      uvDensity: VIEWMODEL_ART.knurlDensity,
    });
  }
  b.add('barrels', 'accent', new BoxGeometry(0.0008, 0.0016, 0.16), {
    pos: [-0.0269, 0.0455, BREECH_Z - 0.13],
  });

  // --- shells in the chambers (hidden at rest) ---
  for (const x of [-BARREL_X, BARREL_X]) {
    b.add('shells', 'shellHull', cylinderZ(0.0098, 0.0098, 0.05, 16), {
      pos: [x, BARREL_Y, BREECH_Z - 0.028],
      paint: 1,
    });
    b.add(
      'shells',
      'brass',
      latheZHard(
        [
          [0.0, 0.0],
          [0.0108, 0.0],
          [0.0108, 0.002],
          [0.0101, 0.0026],
          [0.0101, 0.013],
        ],
        16,
      ),
      { pos: [x, BARREL_Y, BREECH_Z + 0.002], paint: 1 },
    );
  }

  // --- external hammers (cocked back at rest) + top lever ---
  // Sidelock hammers on the flanks of the action; the spurs stay below the sight line.
  for (const x of [-0.0232, 0.0232]) {
    b.add(
      'hammers',
      'darkMetal',
      profileX(
        [
          [0.006, 0.052],
          [-0.012, 0.05],
          [-0.02, 0.056],
          [-0.028, 0.066],
          [-0.035, 0.073],
          [-0.028, 0.0755],
          [-0.018, 0.068],
          [-0.006, 0.064],
          [0.006, 0.062],
        ],
        0.0065,
        { bevel: 0.0012 },
      ),
      { pos: [x, 0, 0], paint: P.darkMetal.paint },
    );
  }
  b.add('lever', 'accentPaint', roundedBox(0.012, 0.004, 0.034, 0.0015), {
    pos: [0.003, 0.0656, 0.03],
    rot: [9, -12, 0],
    paint: P.accentPaint.paint,
  });

  // --- sockets + attachment mounts (barrel-side mounts ride on the barrels) ---
  b.socket('muzzle', [0, BARREL_Y, MUZZLE_Z - 0.001]);
  b.socket('ejectPort', [0, 0.072, BREECH_Z], [-60, 0, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.054]);
  b.mount('optic', [0, RIB_TOP, BREECH_Z - 0.06], undefined, 'barrels');
  b.mount('muzzleDevice', [0, BARREL_Y, MUZZLE_Z - 0.001], undefined, 'barrels');
  b.mount('underbarrel', [0, 0.026, BREECH_Z - 0.15], undefined, 'barrels');
  b.mount('laser', [-0.0275, 0.04, BREECH_Z - 0.17], [0, 0, 90], 'barrels');
  b.mount('stock', [0, 0.045, 0.036]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('doublebarrel', def, built, glow, readoutSpec, readout);
};

export const DOUBLEBARREL_SIGHT_LINE = SIGHT_Y;
