/**
 * BR-3 „Triade“ – bullpup burst rifle. Model content (meters, model space: origin = grip pivot,
 * barrel along −Z). The action sits behind the grip: the curved magazine seats between grip and butt,
 * the ejection port (with the bolt face) is by the cheek, the charging handle runs forward on the
 * left. A sleek shroud carries the "triad" – three glowing slashes per side – and ends in a
 * three-port compensator whose ports glow when hot. The hexagonal holo sight shows a triangle
 * reticle around the dot. Two-digit counter on the left flank above the magwell.
 */
import { BoxGeometry, PlaneGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BURSTRIFLE_VIEWMODEL } from '../../../defs/viewmodelData/burstrifle';
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
  regularPolygonProfile,
  roundedBox,
  tiltedAxisPoint,
} from '../shapes';
import { ProceduralWeaponModel, createReadout, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.056;
const UPPER_TOP = 0.081;
const RAIL_TOP = 0.0885;
const SIGHT_Y = 0.1125;
const SIGHT_REAR = -0.004;
const SIGHT_FRONT = -0.038;
const GRIP_TILT = -14;
const MUZZLE_Z = -0.506;
/** Triangle reticle: circumradius of its corners (m). */
const TRIAD_R = 0.0042;

const grip = (s: number): [number, number, number] => tiltedAxisPoint(GRIP_TILT, 0.004, 0.012, s);

export const buildBurstrifle: ViewmodelBuilder = (kit) => {
  const def = BURSTRIFLE_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'segments' };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.redDot, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('burstrifle', VIEWMODEL_ART.uvDensity);

  b.part('bolt', [0.024, 0.06, 0.055]);
  b.part('chargingHandle', [-0.026, 0.066, -0.1]);
  b.part('trigger', [0, 0.004, -0.034]);
  b.part('magazine', [0, 0.0, 0.11]);
  b.part('sight', [0, RAIL_TOP, -0.021]);

  // --- upper receiver (runs back to the butt: cheek weld) ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.048, 0.046, 0.012, 0.004), 0.4, { bevel: 0.0022 }), {
    pos: [0, UPPER_TOP - 0.023, 0.06],
    paint: P.gunmetal.paint,
  });
  b.add(BODY, 'bore', new BoxGeometry(0.0008, 0.016, 0.06), { pos: [0.0242, 0.06, 0.055] });
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.0065, 0.1), { pos: [-0.0242, 0.066, -0.09] });
  // Rail only ahead of the eye; the cheek piece behind the sight stays smooth.
  b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.0045, 0.34), {
    pos: [0, UPPER_TOP + 0.00225, -0.14],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 24; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.0035, 0.0062), {
      pos: [0, RAIL_TOP - 0.00175, -0.04 - i * 0.0112],
      paint: P.darkMetal.paint,
    });
  }
  // Cheek pads on the flanks (flush: nothing rises under the aimed eye).
  for (const side of [-1, 1]) {
    b.add(BODY, 'grip', roundedBox(0.0022, 0.022, 0.12, 0.001), {
      pos: [side * 0.0242, 0.064, 0.18],
      uvDensity: VIEWMODEL_ART.knurlDensity,
    });
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.1), { pos: [-0.0243, 0.05, 0.03] });

  // --- lower shell: magwell behind the grip, butt ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.272, 0.042],
        [0.16, 0.042],
        [0.168, 0.03],
        [0.158, 0.012],
        [0.03, 0.004],
        [-0.058, 0.004],
        [-0.066, -0.022],
        [-0.152, -0.022],
        [-0.158, 0.0],
        [-0.2, 0.002],
        [-0.228, -0.052],
        [-0.25, -0.074],
        [-0.272, -0.074],
      ],
      0.05,
      { bevel: 0.003 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.052, 0.155, 0.018, 0.005), {
    pos: [0, 0.004, 0.276],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  // Magazine release paddle (behind the magwell) + sling cup.
  b.add(BODY, 'accentPaint', roundedBox(0.03, 0.006, 0.01, 0.002), {
    pos: [0, -0.004, 0.162],
    paint: P.accentPaint.paint,
  });
  b.add(BODY, 'darkMetal', cylinderX(0.006, 0.054, 12), { pos: [0, 0.018, 0.232], paint: P.darkMetal.paint });

  // --- ammo counter (left flank above the magwell, angled towards the shooter) ---
  b.add(BODY, 'darkMetal', roundedBox(0.006, 0.02, 0.03, 0.0015), {
    pos: [-0.0262, 0.024, 0.1],
    rot: [0, 25, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'readout', new PlaneGeometry(0.022, 0.0172), {
    pos: [-0.0294, 0.024, 0.1015],
    rot: [0, -65, 0],
    uv: 'keep',
  });

  // --- trigger guard, trigger, grip ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.004],
        [0.068, 0.004],
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
            [0.01, -0.002],
            [0.062, -0.002],
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
        [0.031, 0.0],
        [0.037, 0.0],
        [0.038, -0.009],
        [0.035, -0.019],
        [0.03, -0.022],
        [0.032, -0.011],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'polymer', roundedBox(0.031, 0.104, 0.043, 0.007, 3), {
    pos: grip(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0332, 0.07, 0.035, 0.004), {
    pos: grip(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- shroud with the triad slashes, bottom rail, side rail ---
  b.add(
    BODY,
    'polymer',
    profileZ(chamferRectProfile(0.05, 0.052, 0.016, 0.012), 0.2, {
      bevel: 0.003,
      holes: [chamferRectProfile(0.032, 0.034, 0.008)],
    }),
    { pos: [0, BORE_Y - 0.002, -0.24], paint: P.polymer.paint },
  );
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.add(BODY, 'bore', roundedBox(0.0014, 0.028, 0.0065, 0.0005), {
        pos: [side * 0.0251, BORE_Y - 0.004, -0.19 - i * 0.022],
        rot: [-32, 0, 0],
      });
      b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.022, 0.0028), {
        pos: [side * 0.0256, BORE_Y - 0.004, -0.19 - i * 0.022],
        rot: [-32, 0, 0],
      });
    }
    for (let i = 0; i < 4; i++) {
      b.add(BODY, 'heat', roundedBox(0.0012, 0.004, 0.016, 0.0005), {
        pos: [side * 0.0195, BORE_Y - 0.0215, -0.26 - i * 0.022],
        rot: [0, 0, -side * 45],
      });
    }
  }
  b.add(BODY, 'darkMetal', new BoxGeometry(0.018, 0.005, 0.08), {
    pos: [0, BORE_Y - 0.0305, -0.27],
    paint: P.darkMetal.paint,
  });

  // --- barrel + three-port compensator ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0098, 0.0098, 0.36, 18), { pos: [0, BORE_Y, -0.29], paint: 0.55 });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0098, 0],
        [0.0128, 0.003],
        [0.0128, 0.042],
        [0.0112, 0.046],
        [0.006, 0.046],
      ],
      20,
    ),
    { pos: [0, BORE_Y, MUZZLE_Z + 0.046], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 3; i++) {
    const z = MUZZLE_Z + 0.036 - i * 0.012;
    b.add(BODY, 'bore', roundedBox(0.009, 0.006, 0.0065, 0.001), { pos: [0, BORE_Y + 0.0112, z] });
    b.add(BODY, 'heat', new BoxGeometry(0.0072, 0.0012, 0.0045), { pos: [0, BORE_Y + 0.0132, z] });
  }
  b.add(BODY, 'bore', cylinderZ(0.006, 0.006, 0.001, 14), { pos: [0, BORE_Y, MUZZLE_Z + 0.0006] });

  // --- charging handle (left, forward) + bolt face (right, by the cheek) ---
  b.add('chargingHandle', 'darkMetal', cylinderX(0.003, 0.012, 10), {
    pos: [-0.031, 0.066, -0.1],
    paint: P.darkMetal.paint,
  });
  b.add('chargingHandle', 'accentPaint', roundedBox(0.01, 0.012, 0.014, 0.003), {
    pos: [-0.039, 0.066, -0.1],
    paint: P.accentPaint.paint,
  });
  b.add('bolt', 'gunmetal', roundedBox(0.0016, 0.012, 0.022, 0.0006), {
    pos: [0.0243, 0.06, 0.055],
    paint: 0.5,
  });

  // --- curved 30-round magazine (behind the grip) ---
  b.add(
    'magazine',
    'polymer',
    profileX(
      [
        [-0.08, 0.0],
        [-0.134, 0.0],
        [-0.13, -0.05],
        [-0.12, -0.1],
        [-0.108, -0.138],
        [-0.064, -0.13],
        [-0.072, -0.09],
        [-0.078, -0.045],
      ],
      0.024,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  for (let i = 0; i < 3; i++) {
    b.add('magazine', 'darkMetal', new BoxGeometry(0.0252, 0.0028, 0.05), {
      pos: [0, -0.03 - i * 0.032, 0.105 - i * 0.004],
      rot: [-4 - i * 3, 0, 0],
      paint: P.darkMetal.paint,
    });
  }
  b.add('magazine', 'accentPaint', roundedBox(0.03, 0.009, 0.05, 0.003), {
    pos: [0, -0.136, 0.086],
    rot: [-10, 0, 0],
    paint: P.accentPaint.paint,
  });

  // --- hexagonal holo sight with the triangle reticle ---
  b.add('sight', 'darkMetal', roundedBox(0.03, 0.006, 0.046, 0.002), {
    pos: [0, RAIL_TOP + 0.003, -0.021],
    paint: P.darkMetal.paint,
  });
  b.add(
    'sight',
    'gunmetal',
    profileZ(regularPolygonProfile(0.0215, 6, 0), SIGHT_REAR - SIGHT_FRONT, {
      bevel: 0.0014,
      holes: [regularPolygonProfile(0.0162, 6, 0)],
    }),
    { pos: [0, SIGHT_Y, (SIGHT_REAR + SIGHT_FRONT) / 2], paint: P.gunmetal.paint },
  );
  b.add('sight', 'accent', new BoxGeometry(0.012, 0.0012, 0.02), { pos: [0, SIGHT_Y + 0.0188, -0.021] });
  b.add('sight', 'lens', new PlaneGeometry(0.028, 0.028), {
    pos: [0, SIGHT_Y, SIGHT_FRONT + 0.0015],
    uv: 'keep',
  });
  const rz = SIGHT_FRONT + 0.002;
  b.add('sight', 'sight', cylinderZ(0.00055, 0.00055, 0.0003, 10), { pos: [0, SIGHT_Y, rz] });
  for (let i = 0; i < 3; i++) {
    const a0 = ((90 + i * 120) * Math.PI) / 180;
    const a1 = ((90 + (i + 1) * 120) * Math.PI) / 180;
    const x0 = Math.cos(a0) * TRIAD_R;
    const y0 = Math.sin(a0) * TRIAD_R;
    const x1 = Math.cos(a1) * TRIAD_R;
    const y1 = Math.sin(a1) * TRIAD_R;
    const len = Math.hypot(x1 - x0, y1 - y0);
    b.add('sight', 'sight', new BoxGeometry(len * 0.62, 0.00032, 0.0003), {
      pos: [(x0 + x1) / 2, SIGHT_Y + (y0 + y1) / 2, rz],
      rot: [0, 0, (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI],
    });
    b.add('sight', 'sight', cylinderZ(0.00045, 0.00045, 0.0003, 8), { pos: [x0, SIGHT_Y + y0, rz] });
  }

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.026, 0.06, 0.055], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, SIGHT_REAR + 0.002]);
  b.mount('optic', [0, RAIL_TOP, -0.021]);
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, BORE_Y - 0.033, -0.27]);
  b.mount('laser', [-0.026, BORE_Y + 0.004, -0.29], [0, 0, 90]);
  b.mount('stock', [0, 0.02, 0.285]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('burstrifle', def, built, glow, readoutSpec, readout);
};

export const BURSTRIFLE_SIGHT_LINE = SIGHT_Y;
