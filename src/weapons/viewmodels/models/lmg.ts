/**
 * LM-60 „Bollwerk“ – belt-fed light machine gun. Model content (meters, model space: origin = grip
 * pivot, barrel along −Z). Long box receiver, a heat shield over the heavy barrel whose vents glow,
 * a canted carry handle, triangular fore-end, gas tube, folded bipod and a bird-cage flash hider.
 * Parts: feed cover (hinged at the rear, carries the rail and the armoured reflex sight, child
 * `sight`), magazine (the ammo box on the left with a 10-LED level gauge) with the belt (child: a
 * curved run of linked rounds from the box into the feed tray), charging handle (`bolt`, left), trigger.
 */
import { BoxGeometry, PlaneGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { LMG_VIEWMODEL } from '../../../defs/viewmodelData/lmg';
import type { ViewmodelBuilder } from '../index';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials } from '../materials';
import {
  arcBandProfile,
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

const BORE_Y = 0.055;
const COVER_HINGE: readonly [number, number, number] = [0, 0.083, 0.07];
const RAIL_TOP = 0.1015;
/** Window center of the armoured reflex sight (on the cover). */
const SIGHT_Y = 0.1245;
const SIGHT_REAR = -0.004;
const SIGHT_FRONT = -0.042;
const GRIP_TILT = -18;
const MUZZLE_Z = -0.676;
const FEED_Z = -0.115;
/** Ammo box (left, under the receiver). */
const BOX: readonly [number, number, number] = [-0.03, -0.047, -0.122];
const BOX_SIZE: readonly [number, number, number] = [0.056, 0.102, 0.1];
const LEDS = 10;
/** Belt run from the feed tray down into the box: round centers [x, y]. */
const BELT: readonly (readonly [number, number])[] = [
  [-0.011, 0.0875],
  [-0.0232, 0.0842],
  [-0.0334, 0.0778],
  [-0.0413, 0.069],
  [-0.047, 0.0584],
  [-0.0503, 0.0466],
  [-0.0516, 0.0344],
  [-0.0515, 0.0222],
  [-0.0505, 0.01],
];

const grip = (s: number): [number, number, number] => tiltedAxisPoint(GRIP_TILT, 0.004, 0.012, s);

export const buildLmg: ViewmodelBuilder = (kit) => {
  const def = LMG_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.redDot, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('lmg', VIEWMODEL_ART.uvDensity);
  const [bx, by, bz] = BOX;
  const [bw, bh, bd] = BOX_SIZE;

  b.part('cover', COVER_HINGE);
  b.part('sight', [0, RAIL_TOP, -0.024], { parent: 'cover' });
  b.part('bolt', [-0.03, 0.046, -0.17]);
  b.part('trigger', [0, 0.004, -0.034]);
  b.part('magazine', [bx, by + bh / 2, bz]);
  b.part('belt', [BELT[0]![0], BELT[0]![1], FEED_Z], { parent: 'magazine' });

  // --- receiver: long box, riveted flanks, belt entry, charging slot, feed tray ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.054, 0.062, 0.008, 0.005), 0.31, { bevel: 0.0022 }), {
    pos: [0, 0.05, -0.06],
    paint: P.gunmetal.paint,
  });
  for (const side of [-1, 1]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0018, 0.024, 0.2, 0.0008), {
      pos: [side * 0.0272, 0.036, -0.02],
      paint: P.darkMetal.paint,
    });
    for (let i = 0; i < 5; i++) {
      b.add(BODY, 'gunmetal', cylinderX(0.0022, 0.0026, 8), {
        pos: [side * 0.0284, 0.028, 0.06 - i * 0.045],
        paint: 0.6,
      });
    }
  }
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.016, 0.052), { pos: [-0.0272, 0.074, FEED_Z] });
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.007, 0.1), { pos: [-0.0272, 0.046, -0.16] });
  b.add(BODY, 'darkMetal', new BoxGeometry(0.046, 0.002, 0.07), {
    pos: [0, 0.0815, FEED_Z],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'bore', new BoxGeometry(0.044, 0.0006, 0.012), { pos: [0, 0.0826, FEED_Z] });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.13), { pos: [-0.0274, 0.058, 0.02] });

  // --- lower frame, box bracket, guard, trigger ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.095, 0.022],
        [0.215, 0.022],
        [0.215, 0.009],
        [0.18, 0.005],
        [0.06, 0.0],
        [-0.03, 0.0],
        [-0.095, 0.012],
      ],
      0.05,
      { bevel: 0.0025 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.058, 0.007, 0.104, 0.002), {
    pos: [bx + 0.002, 0.004, bz],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.002],
        [0.058, 0.002],
        [0.058, -0.024],
        [0.05, -0.032],
        [0.006, -0.032],
        [-0.004, -0.022],
      ],
      0.013,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.008, -0.004],
            [0.052, -0.004],
            [0.052, -0.021],
            [0.046, -0.027],
            [0.01, -0.027],
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
        [0.03, 0.0],
        [0.036, 0.0],
        [0.037, -0.009],
        [0.034, -0.019],
        [0.029, -0.022],
        [0.031, -0.011],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

  // --- grip + stock (skeleton, buffer tube inside, pad) ---
  b.add(BODY, 'polymer', roundedBox(0.032, 0.108, 0.045, 0.007, 3), {
    pos: grip(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0342, 0.072, 0.037, 0.004), {
    pos: grip(0.056),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.095, 0.08],
        [-0.33, 0.076],
        [-0.34, 0.066],
        [-0.34, -0.05],
        [-0.325, -0.058],
        [-0.2, -0.018],
        [-0.095, 0.014],
      ],
      0.04,
      {
        bevel: 0.003,
        holes: [
          [
            [-0.13, 0.064],
            [-0.3, 0.062],
            [-0.3, -0.004],
            [-0.2, 0.012],
            [-0.13, 0.03],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'gunmetal', cylinderZ(0.0105, 0.0105, 0.18, 16), { pos: [0, 0.047, 0.2], paint: 0.55 });
  b.add(BODY, 'accent', cylinderZ(0.0108, 0.0108, 0.003, 16), { pos: [0, 0.047, 0.16] });
  b.add(BODY, 'grip', roundedBox(0.044, 0.13, 0.02, 0.005), {
    pos: [0, 0.01, 0.35],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- heavy barrel, heat shield (glowing vents), canted carry handle, gas tube, fore-end ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0125, 0.0125, 0.42, 18), { pos: [0, BORE_Y, -0.425], paint: 0.55 });
  b.add(BODY, 'gunmetal', profileZ(arcBandProfile(0.0215, 0.018, 15, 165, 12), 0.27, { bevel: 0.001 }), {
    pos: [0, BORE_Y, -0.36],
    paint: P.gunmetal.paint,
  });
  for (let i = 0; i < 7; i++) {
    const z = -0.25 - i * 0.036;
    b.add(BODY, 'bore', roundedBox(0.014, 0.0014, 0.024, 0.0006), { pos: [0, BORE_Y + 0.0214, z] });
    b.add(BODY, 'heat', roundedBox(0.011, 0.0014, 0.02, 0.0005), { pos: [0, BORE_Y + 0.0219, z] });
  }
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [0.25, 0],
        [0.266, 0.022],
        [0.354, 0.022],
        [0.37, 0],
        [0.358, 0],
        [0.344, 0.015],
        [0.276, 0.015],
        [0.262, 0],
      ],
      0.01,
      { bevel: 0.0015 },
    ),
    // Rooted on the heat shield's upper-left, canted so it stays out of the sight picture.
    { pos: [-0.008, BORE_Y + 0.02, 0], rot: [0, 0, 22], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.013, 0.008, 0.07, 0.003), {
    pos: [-0.0155, BORE_Y + 0.0386, -0.31],
    rot: [0, 0, 22],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'darkMetal', cylinderZ(0.0065, 0.0065, 0.3, 12), {
    pos: [0, 0.031, -0.365],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'polymer',
    profileZ(
      [
        [0.027, 0.046],
        [0.027, 0.03],
        [0.012, 0.012],
        [-0.012, 0.012],
        [-0.027, 0.03],
        [-0.027, 0.046],
      ],
      0.19,
      { bevel: 0.002 },
    ),
    { pos: [0, 0, -0.31], paint: P.polymer.paint },
  );
  for (const side of [-1, 1]) {
    b.add(BODY, 'grip', roundedBox(0.002, 0.012, 0.12, 0.001), {
      pos: [side * 0.0272, 0.037, -0.31],
      rot: [0, 0, side * -10],
      uvDensity: VIEWMODEL_ART.knurlDensity,
    });
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0016, 0.15), { pos: [-0.0276, 0.043, -0.31] });
  // Folded bipod under the gas tube.
  b.add(BODY, 'darkMetal', roundedBox(0.026, 0.012, 0.022, 0.003), {
    pos: [0, 0.022, -0.51],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.009, 0.009]) {
    b.add(BODY, 'gunmetal', cylinderZ(0.0042, 0.0042, 0.15, 10), { pos: [x, 0.017, -0.59], paint: 0.55 });
    b.add(BODY, 'grip', roundedBox(0.011, 0.008, 0.016, 0.003), { pos: [x, 0.017, -0.668] });
  }
  // Bird-cage flash hider.
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0125, 0],
        [0.0148, 0.003],
        [0.0148, 0.043],
        [0.0132, 0.046],
        [0.0085, 0.046],
      ],
      20,
    ),
    { pos: [0, BORE_Y, MUZZLE_Z + 0.046], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 4; i++) {
    b.add(BODY, 'bore', new BoxGeometry(0.0034, 0.0302, 0.028), {
      pos: [0, BORE_Y, MUZZLE_Z + 0.02],
      rot: [0, 0, 22.5 + i * 45],
    });
  }
  b.add(BODY, 'bore', cylinderZ(0.0086, 0.0086, 0.001, 16), { pos: [0, BORE_Y, MUZZLE_Z + 0.0006] });

  // --- charging handle (left) ---
  b.add('bolt', 'darkMetal', cylinderX(0.0034, 0.018, 10), { pos: [-0.036, 0.046, -0.17], paint: 0.4 });
  b.add('bolt', 'accentPaint', roundedBox(0.012, 0.015, 0.017, 0.003), {
    pos: [-0.048, 0.046, -0.17],
    paint: P.accentPaint.paint,
  });

  // --- feed cover (hinged at the rear) with rail + latch ---
  b.add(
    'cover',
    'darkMetal',
    profileX(
      [
        [-0.07, 0.081],
        [0.19, 0.081],
        [0.19, 0.088],
        [0.172, 0.094],
        [-0.06, 0.094],
        [-0.07, 0.089],
      ],
      0.05,
      { bevel: 0.0018 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add('cover', 'darkMetal', new BoxGeometry(0.022, 0.004, 0.23), {
    pos: [0, RAIL_TOP - 0.0055, -0.055],
    paint: P.darkMetal.paint,
  });
  // Teeth from the sight base forward: nothing stair-steps under the aimed eye.
  for (let i = 0; i < 14; i++) {
    b.add('cover', 'darkMetal', new BoxGeometry(0.024, 0.0035, 0.0062), {
      pos: [0, RAIL_TOP - 0.00175, 0.0 - i * 0.0128],
      paint: P.darkMetal.paint,
    });
  }
  b.add('cover', 'darkMetal', roundedBox(0.024, 0.006, 0.01, 0.002), {
    pos: [0, 0.089, 0.074],
    paint: 0.45,
  });

  // --- armoured reflex sight (rides on the cover) with a post reticle ---
  b.add('sight', 'darkMetal', roundedBox(0.032, 0.006, 0.048, 0.002), {
    pos: [0, RAIL_TOP + 0.003, -0.024],
    paint: P.darkMetal.paint,
  });
  b.add(
    'sight',
    'darkMetal',
    profileZ(chamferRectProfile(0.042, 0.035, 0.011, 0.003), SIGHT_REAR - SIGHT_FRONT, {
      bevel: 0.0016,
      holes: [chamferRectProfile(0.027, 0.022, 0.006, 0.001)],
    }),
    { pos: [0, SIGHT_Y, (SIGHT_REAR + SIGHT_FRONT) / 2], paint: P.darkMetal.paint },
  );
  for (const side of [-1, 1]) {
    b.add('sight', 'darkMetal', roundedBox(0.004, 0.028, 0.03, 0.0012), {
      pos: [side * 0.0225, SIGHT_Y - 0.002, -0.026],
      rot: [0, 0, side * -8],
      paint: 0.35,
    });
  }
  b.add('sight', 'lens', new PlaneGeometry(0.027, 0.022), {
    pos: [0, SIGHT_Y, SIGHT_FRONT + 0.0015],
    uv: 'keep',
  });
  const rz = SIGHT_FRONT + 0.002;
  b.add('sight', 'sight', new BoxGeometry(0.0009, 0.0072, 0.0003), { pos: [0, SIGHT_Y - 0.0046, rz] });
  for (const s of [-1, 1]) {
    b.add('sight', 'sight', new BoxGeometry(0.0062, 0.00055, 0.0003), { pos: [s * 0.0048, SIGHT_Y, rz] });
  }
  b.add('sight', 'sight', cylinderZ(0.0006, 0.0006, 0.0003, 10), { pos: [0, SIGHT_Y, rz] });

  // --- ammo box (left) with lid, strap and a 10-LED level gauge ---
  b.add('magazine', 'polymer', roundedBox(bw, bh, bd, 0.004, 2), {
    pos: [bx, by, bz],
    paint: P.polymer.paint,
  });
  b.add('magazine', 'darkMetal', roundedBox(bw + 0.002, 0.008, bd + 0.002, 0.002), {
    pos: [bx, by + bh / 2 - 0.004, bz],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 3; i++) {
    b.add('magazine', 'darkMetal', new BoxGeometry(bw + 0.0016, 0.0035, 0.004), {
      pos: [bx, by - 0.02 + i * 0.022, bz + bd / 2],
      paint: P.darkMetal.paint,
    });
  }
  b.add('magazine', 'grip', roundedBox(0.004, 0.07, 0.022, 0.0015), {
    pos: [bx - bw / 2 - 0.001, by, bz - 0.028],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  const ledX = bx - bw / 2 - 0.0006;
  b.add('magazine', 'darkMetal', roundedBox(0.0014, LEDS * 0.0078 + 0.005, 0.01, 0.0005), {
    pos: [ledX, by - 0.004, bz + 0.02],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < LEDS; i++) {
    b.add('magazine', 'readout', new BoxGeometry(0.0012, 0.0052, 0.007), {
      pos: [ledX - 0.0006, by - 0.004 - ((LEDS - 1) * 0.0078) / 2 + i * 0.0078, bz + 0.02],
      uv: ledUv(i, LEDS),
    });
  }

  // --- belt: linked rounds (brass cases, dark tips) on a curve into the tray ---
  for (let i = 0; i < BELT.length; i++) {
    const [x, y] = BELT[i]!;
    b.add('belt', 'brass', cylinderZ(0.0042, 0.0042, 0.03, 10), { pos: [x, y, FEED_Z + 0.004], paint: 1 });
    b.add(
      'belt',
      'darkMetal',
      latheZHard(
        [
          [0.0036, 0],
          [0.0029, 0.007],
          [0.001, 0.014],
        ],
        10,
      ),
      { pos: [x, y, FEED_Z - 0.011], paint: 0.7 },
    );
    const next = BELT[i + 1];
    if (next) {
      const dx = next[0] - x;
      const dy = next[1] - y;
      const len = Math.hypot(dx, dy);
      for (const dz of [0.008, -0.004]) {
        b.add('belt', 'darkMetal', new BoxGeometry(len, 0.0026, 0.0035), {
          pos: [(x + next[0]) / 2, (y + next[1]) / 2, FEED_Z + dz],
          rot: [0, 0, (Math.atan2(dy, dx) * 180) / Math.PI],
          paint: 0.5,
        });
      }
    }
  }

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.029, 0.03, -0.04], [-60, -100, 0]);
  b.socket('sight', [0, SIGHT_Y, SIGHT_REAR + 0.001], undefined, 'cover');
  b.mount('optic', [0, RAIL_TOP, -0.024], undefined, 'cover');
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, 0.012, -0.34]);
  b.mount('laser', [-0.0272, 0.037, -0.36], [0, 0, 90]);
  b.mount('stock', [0, 0.05, 0.095]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('lmg', def, built, glow, readoutSpec, readout);
};

export const LMG_SIGHT_LINE = SIGHT_Y;
