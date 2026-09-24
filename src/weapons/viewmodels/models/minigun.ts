/**
 * RX-6 „Kreissäge“ – handheld rotary cannon. Model content (meters, model space: origin = grip pivot,
 * barrel along −Z). A rotor housing on top of the grip, the finned motor behind it (coil bands flare
 * with the spin), a ring of 12 ammo LEDs on the rear cap facing the shooter, a carry handle with a
 * compact tube sight, and the ammo box hanging on the left with its feed chute into the housing.
 * Parts: barrels (the whole spinning cluster: six barrels – one marked so the rotation always
 * reads –, the mid clamp and the toothed "saw" clamp at the front; its heat stripes glow under
 * sustained fire; spun by the `spin` driver), magazine (ammo box) with the chute (child), motor
 * lever, trigger.
 */
import { BoxGeometry, PlaneGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { MINIGUN_VIEWMODEL } from '../../../defs/viewmodelData/minigun';
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

/** Spin axis of the barrel cluster. */
const AXIS_Y = 0.048;
const HOUSING_R = 0.046;
const HOUSING_REAR = 0.035;
const HOUSING_FRONT = -0.125;
const MOTOR_REAR = 0.168;
const BARREL_RING = 0.022;
const BARREL_R = 0.0072;
const BARREL_REAR = -0.12;
const MUZZLE_Z = -0.585;
const SAW_Z = -0.53;
const SAW_TEETH = 6;
const HANDLE_TOP = 0.122;
/** Tube sight on the carry handle (sight line). */
const SIGHT_Y = 0.136;
const SIGHT_REAR = 0.052;
const SIGHT_LEN = 0.05;
const GRIP_TILT = -16;
const LEDS = 12;
const BOX: readonly [number, number, number] = [-0.078, -0.03, -0.035];
const BOX_SIZE: readonly [number, number, number] = [0.05, 0.1, 0.13];

const grip = (s: number): [number, number, number] => tiltedAxisPoint(GRIP_TILT, 0.004, 0.012, s);

/** Solid ring (annulus × length) around the Z axis: fins, bands, clamps. */
const ring = (rIn: number, rOut: number, len: number, segments: number) =>
  latheZHard(
    [
      [rIn, 0],
      [rOut, 0],
      [rOut, len],
      [rIn, len],
    ],
    segments,
  );

export const buildMinigun: ViewmodelBuilder = (kit) => {
  const def = MINIGUN_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.heat, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('minigun', VIEWMODEL_ART.uvDensity);
  const [bx, by, bz] = BOX;
  const [bw, bh, bd] = BOX_SIZE;

  b.part('barrels', [0, AXIS_Y, BARREL_REAR]);
  b.part('magazine', [bx, by + bh / 2, bz]);
  b.part('chute', [-0.062, 0.036, -0.07], { parent: 'magazine' });
  b.part('lever', [-0.0385, 0.078, -0.005]);
  b.part('trigger', [0, 0.004, -0.034]);

  // --- rotor housing (static), front lip glow ---
  b.add(
    BODY,
    'gunmetal',
    latheZHard(
      [
        [0, 0],
        [HOUSING_R - 0.003, 0],
        [HOUSING_R, 0.003],
        [HOUSING_R, HOUSING_REAR - HOUSING_FRONT - 0.008],
        [HOUSING_R - 0.006, HOUSING_REAR - HOUSING_FRONT],
        [0.036, HOUSING_REAR - HOUSING_FRONT],
        [0.036, HOUSING_REAR - HOUSING_FRONT - 0.006],
        [0, HOUSING_REAR - HOUSING_FRONT - 0.006],
      ],
      32,
    ),
    { pos: [0, AXIS_Y, HOUSING_REAR], paint: P.gunmetal.paint },
  );
  for (const z of [0.0, -0.075]) {
    b.add(BODY, 'darkMetal', ring(HOUSING_R, HOUSING_R + 0.0015, 0.012, 32), {
      pos: [0, AXIS_Y, z],
      paint: P.darkMetal.paint,
    });
  }
  b.add(
    BODY,
    'accent',
    latheZHard(
      [
        [0.0398, 0],
        [0.037, 0],
      ],
      32,
    ),
    { pos: [0, AXIS_Y, HOUSING_FRONT - 0.0002] },
  );
  // Side access panels with bolts.
  for (const side of [-1, 1]) {
    b.add(BODY, 'darkMetal', roundedBox(0.004, 0.03, 0.05, 0.0012), {
      pos: [side * (HOUSING_R + 0.0005), AXIS_Y, -0.04],
      paint: P.darkMetal.paint,
    });
  }

  // --- motor: finned drum, glowing coil bands, rear cap with the LED ring ---
  b.add(BODY, 'darkMetal', cylinderZ(0.033, 0.033, MOTOR_REAR - HOUSING_REAR, 28), {
    pos: [0, AXIS_Y, (MOTOR_REAR + HOUSING_REAR) / 2],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 9; i++) {
    b.add(BODY, 'darkMetal', ring(0.033, 0.0395, 0.004, 28), {
      pos: [0, AXIS_Y, HOUSING_REAR + 0.012 + i * 0.013],
      paint: P.darkMetal.paint,
    });
  }
  for (let i = 0; i < 3; i++) {
    b.add(BODY, 'accent', ring(0.033, 0.0342, 0.005, 28), {
      pos: [0, AXIS_Y, HOUSING_REAR + 0.047 + i * 0.026],
    });
  }
  b.add(
    BODY,
    'gunmetal',
    latheZHard(
      [
        [0.0, 0],
        [0.03, 0],
        [0.036, 0.006],
        [0.036, 0.008],
      ],
      28,
    ),
    { pos: [0, AXIS_Y, MOTOR_REAR + 0.008], paint: P.gunmetal.paint },
  );
  for (let i = 0; i < LEDS; i++) {
    const a = -Math.PI / 2 - (i * 2 * Math.PI) / LEDS;
    b.add(BODY, 'readout', new BoxGeometry(0.0045, 0.0045, 0.0012), {
      pos: [Math.cos(a) * 0.026, AXIS_Y + Math.sin(a) * 0.026, MOTOR_REAR + 0.0086],
      rot: [0, 0, (a * 180) / Math.PI],
      uv: ledUv(i, LEDS),
    });
  }
  b.add(BODY, 'darkMetal', cylinderZ(0.012, 0.012, 0.008, 20), {
    pos: [0, AXIS_Y, MOTOR_REAR + 0.01],
    paint: P.darkMetal.paint,
  });

  // --- grip frame, guard, trigger, grip ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.03, 0.012],
        [0.075, 0.012],
        [0.075, 0.0],
        [0.066, -0.004],
        [-0.03, -0.004],
      ],
      0.036,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.0],
        [0.066, 0.0],
        [0.066, -0.026],
        [0.058, -0.034],
        [0.008, -0.034],
        [-0.004, -0.024],
      ],
      0.013,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, -0.005],
            [0.06, -0.005],
            [0.06, -0.023],
            [0.054, -0.029],
            [0.012, -0.029],
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
        [0.037, 0.0],
        [0.038, -0.01],
        [0.035, -0.02],
        [0.03, -0.023],
        [0.032, -0.012],
      ],
      0.007,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'polymer', roundedBox(0.034, 0.112, 0.047, 0.008, 3), {
    pos: grip(0.052),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0362, 0.076, 0.039, 0.004), {
    pos: grip(0.058),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- carry handle with a compact tube sight ---
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-0.09, AXIS_Y + 0.036],
        [-0.08, HANDLE_TOP],
        [0.07, HANDLE_TOP],
        [0.08, AXIS_Y + 0.036],
        [0.064, AXIS_Y + 0.036],
        [0.058, HANDLE_TOP - 0.012],
        [-0.068, HANDLE_TOP - 0.012],
        [-0.074, AXIS_Y + 0.036],
      ],
      0.016,
      { bevel: 0.002 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.019, 0.007, 0.1, 0.0025), {
    pos: [0, HANDLE_TOP - 0.006, 0.0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0172, 0.0016, 0.1), { pos: [0, HANDLE_TOP - 0.0125, 0.0] });
  b.add(BODY, 'darkMetal', roundedBox(0.018, 0.006, 0.05, 0.0015), {
    pos: [0, HANDLE_TOP + 0.003, SIGHT_REAR - SIGHT_LEN / 2],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'gunmetal',
    profileZ(chamferRectProfile(0.026, 0.022, 0.005, 0.002), SIGHT_LEN, {
      bevel: 0.0012,
      holes: [chamferRectProfile(0.019, 0.015, 0.003, 0.001)],
    }),
    { pos: [0, SIGHT_Y, SIGHT_REAR - SIGHT_LEN / 2], paint: P.gunmetal.paint },
  );
  b.add(BODY, 'lens', new PlaneGeometry(0.019, 0.015), {
    pos: [0, SIGHT_Y, SIGHT_REAR - SIGHT_LEN + 0.002],
    uv: 'keep',
  });
  const rz = SIGHT_REAR - SIGHT_LEN + 0.0025;
  b.add(BODY, 'sight', cylinderZ(0.0008, 0.0008, 0.0003, 12), { pos: [0, SIGHT_Y, rz] });
  for (const s of [-1, 1]) {
    b.add(BODY, 'sight', new BoxGeometry(0.003, 0.0004, 0.0003), { pos: [s * 0.0032, SIGHT_Y, rz] });
  }
  b.add(BODY, 'sight', new BoxGeometry(0.0004, 0.003, 0.0003), { pos: [0, SIGHT_Y - 0.0032, rz] });

  // --- barrel cluster (spins): collar, spindle, six barrels, mid clamp, saw clamp, hub ---
  b.add('barrels', 'darkMetal', cylinderZ(0.034, 0.034, 0.012, 28), {
    pos: [0, AXIS_Y, BARREL_REAR - 0.004],
    paint: P.darkMetal.paint,
  });
  b.add('barrels', 'gunmetal', cylinderZ(0.009, 0.009, BARREL_REAR - SAW_Z, 14), {
    pos: [0, AXIS_Y, (SAW_Z + BARREL_REAR) / 2],
    paint: 0.6,
  });
  const barrelLen = BARREL_REAR - MUZZLE_Z;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    const x = Math.cos(a) * BARREL_RING;
    const y = AXIS_Y + Math.sin(a) * BARREL_RING;
    b.add('barrels', 'darkMetal', cylinderZ(BARREL_R, BARREL_R, barrelLen, 14), {
      pos: [x, y, (BARREL_REAR + MUZZLE_Z) / 2],
      paint: P.darkMetal.paint,
    });
    b.add('barrels', 'bore', cylinderZ(0.0042, 0.0042, 0.001, 12), { pos: [x, y, MUZZLE_Z - 0.0004] });
    // Heat stripe on the outside of each barrel.
    const ox = Math.cos(a) * (BARREL_RING + BARREL_R);
    const oy = AXIS_Y + Math.sin(a) * (BARREL_RING + BARREL_R);
    b.add('barrels', 'heat', new BoxGeometry(0.0012, 0.0034, 0.3), {
      pos: [ox, oy, -0.39],
      rot: [0, 0, (a * 180) / Math.PI],
    });
  }
  // The marked barrel: one accent band breaks the six-fold symmetry.
  b.add('barrels', 'accent', ring(BARREL_R, BARREL_R + 0.0008, 0.008, 14), {
    pos: [0, AXIS_Y + BARREL_RING, -0.46],
  });
  b.add(
    'barrels',
    'gunmetal',
    latheZHard(
      [
        [0.0, 0],
        [0.035, 0],
        [0.035, 0.012],
        [0.03, 0.016],
        [0.0, 0.016],
      ],
      28,
    ),
    {
      pos: [0, AXIS_Y, -0.3],
      paint: 0.55,
    },
  );
  b.add(
    'barrels',
    'darkMetal',
    latheZHard(
      [
        [0.0, 0],
        [0.03, 0],
        [0.036, 0.004],
        [0.036, 0.014],
        [0.032, 0.018],
        [0.0, 0.018],
      ],
      28,
    ),
    { pos: [0, AXIS_Y, SAW_Z + 0.009], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < SAW_TEETH; i++) {
    const a = (i * 2 * Math.PI) / SAW_TEETH + Math.PI / SAW_TEETH;
    b.add(
      'barrels',
      'darkMetal',
      profileZ(
        [
          [0.0, 0.0],
          [0.013, 0.0],
          [0.0, 0.017],
        ],
        0.012,
        { bevel: 0.0008 },
      ),
      {
        pos: [Math.cos(a) * 0.034, AXIS_Y + Math.sin(a) * 0.034, SAW_Z],
        rot: [0, 0, (a * 180) / Math.PI - 90],
        paint: 0.5,
      },
    );
  }
  b.add('barrels', 'accent', ring(0.036, 0.0368, 0.0016, 28), { pos: [0, AXIS_Y, SAW_Z + 0.001] });
  b.add(
    'barrels',
    'gunmetal',
    latheZHard(
      [
        [0.009, 0],
        [0.011, 0.004],
        [0.011, 0.012],
        [0.0, 0.016],
      ],
      16,
    ),
    {
      pos: [0, AXIS_Y, SAW_Z - 0.009],
      paint: 0.6,
    },
  );
  b.add('barrels', 'accent', cylinderZ(0.0046, 0.0046, 0.001, 14), { pos: [0, AXIS_Y, SAW_Z - 0.0255] });

  // --- ammo box (left) with lid, hazard band, strap; feed chute into the housing ---
  b.add('magazine', 'polymer', roundedBox(bw, bh, bd, 0.004, 2), {
    pos: [bx, by, bz],
    paint: P.polymer.paint,
  });
  b.add('magazine', 'darkMetal', roundedBox(bw + 0.002, 0.008, bd + 0.002, 0.002), {
    pos: [bx, by + bh / 2 - 0.004, bz],
    paint: P.darkMetal.paint,
  });
  b.add('magazine', 'accentPaint', new BoxGeometry(bw + 0.0012, 0.012, bd + 0.0012), {
    pos: [bx, by - bh / 2 + 0.014, bz],
    paint: P.accentPaint.paint,
  });
  for (let i = 0; i < 4; i++) {
    b.add('magazine', 'darkMetal', new BoxGeometry(bw + 0.0016, 0.0035, 0.004), {
      pos: [bx, by - 0.015 + i * 0.016, bz + bd / 2],
      paint: P.darkMetal.paint,
    });
  }
  b.add('magazine', 'grip', roundedBox(0.004, 0.06, 0.024, 0.0015), {
    pos: [bx - bw / 2 - 0.001, by + 0.005, bz],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  // Mount bracket from the housing to the box.
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.01, 0.06, 0.002), {
    pos: [-0.052, 0.022, -0.035],
    rot: [0, 0, -30],
    paint: P.darkMetal.paint,
  });
  // Chute: segmented quarter arc from the box top into the housing's left flank.
  const cx0 = -0.046;
  const cy0 = 0.02;
  const cr = 0.03;
  for (let i = 0; i < 5; i++) {
    const a = Math.PI - (i / 4) * (Math.PI / 2) * 0.92;
    b.add('chute', 'darkMetal', roundedBox(0.02, 0.009, 0.024, 0.002), {
      pos: [cx0 + Math.cos(a) * cr, cy0 + Math.sin(a) * cr, -0.07],
      rot: [0, 0, (a * 180) / Math.PI - 90],
      paint: i % 2 === 0 ? P.darkMetal.paint : 0.7,
    });
  }

  // --- motor lever (left, behind the chute) ---
  b.add('lever', 'accentPaint', roundedBox(0.006, 0.007, 0.034, 0.002), {
    pos: [-0.04, 0.0795, 0.011],
    rot: [10, 0, 0],
    paint: P.accentPaint.paint,
  });
  b.add('lever', 'accentPaint', cylinderX(0.0045, 0.009, 10), { pos: [-0.0385, 0.078, -0.005], paint: 0.8 });

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, AXIS_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.04, 0.012, -0.05], [-70, -90, 0]);
  b.socket('sight', [0, SIGHT_Y, SIGHT_REAR - 0.002]);
  b.mount('optic', [0, HANDLE_TOP, 0.0]);
  b.mount('muzzleDevice', [0, AXIS_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, AXIS_Y - HOUSING_R, -0.08]);
  b.mount('laser', [HOUSING_R + 0.002, AXIS_Y, -0.04], [0, 0, -90]);
  b.mount('stock', [0, AXIS_Y, MOTOR_REAR + 0.014]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('minigun', def, built, glow, readoutSpec, readout);
};

export const MINIGUN_SIGHT_LINE = SIGHT_Y;
