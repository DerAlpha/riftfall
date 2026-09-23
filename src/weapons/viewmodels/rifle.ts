/**
 * KR-7 "Wächter" – full-auto assault rifle. Model content (meters, model space: origin = grip
 * pivot, barrel along −Z). Parts: reciprocating left-side charging handle (visible on every
 * shot), bolt behind the right ejection port with a spring-loaded dust cover, trigger, curved
 * magazine, and a tube red-dot sight whose dot sits on the sight line. A two-digit seven-segment
 * ammo counter faces the player from the left rear of the receiver; handguard vents glow with heat.
 */
import { BoxGeometry, PlaneGeometry } from 'three';
import { VIEWMODEL_ART, VIEWMODELS } from '../../defs/viewmodels';
import { BODY, ModelBuilder } from './ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from './materials';
import { chamferRectProfile, cylinderX, cylinderZ, latheZ, profileX, profileZ, roundedBox } from './shapes';
import {
  ProceduralWeaponModel,
  createReadout,
  type ReadoutSpec,
  type WeaponViewmodelModel,
} from './WeaponModel';

const P = VIEWMODEL_ART.materials;

/** Sight line: center of the red-dot tube. */
const SIGHT_Y = 0.1085;
const BORE_Y = 0.048;
const GRIP_TILT = -20;
const GRIP_TOP = { y: 0.002, z: 0.012 } as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

export function buildRifle(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = VIEWMODELS.rifle;
  const readoutSpec: ReadoutSpec = { kind: 'segments' };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.redDot, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('rifle', VIEWMODEL_ART.uvDensity);

  b.part('bolt', [0.0236, 0.056, -0.035]);
  b.part('chargingHandle', [-0.024, 0.062, -0.18]);
  b.part('dustCover', [0.0245, 0.0455, -0.02]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('magazine', [0, 0.0, -0.0975]);
  b.part('sight', [0, 0.085, -0.042]);

  // --- upper receiver ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.046, 0.05, 0.008, 0.004), 0.33, { bevel: 0.002 }), {
    pos: [0, 0.052, -0.065],
    paint: P.gunmetal.paint,
  });
  // Top rail + teeth.
  b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.004, 0.2), {
    pos: [0, 0.079, -0.02],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 14; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.004, 0.0065), {
      pos: [0, 0.083, 0.07 - i * 0.013],
      paint: P.darkMetal.paint,
    });
  }
  // Charging-handle slot (left) and ejection port recess (right).
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.007, 0.072), { pos: [-0.0233, 0.062, -0.155] });
  b.add(BODY, 'bore', new BoxGeometry(0.0008, 0.018, 0.062), { pos: [0.0234, 0.0565, -0.02] });
  // Accent strips: receiver left flank + handguard upper-left chamfer.
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [-0.0233, 0.0705, -0.03] });
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0024, 0.17), {
    pos: [-0.0205, 0.0674, -0.335],
    rot: [0, 0, 45],
  });

  // --- ammo counter (left rear, angled towards the shooter) ---
  // The module sticks out of the flank so the whole angled face clears the receiver.
  b.add(BODY, 'darkMetal', roundedBox(0.006, 0.021, 0.029, 0.0015), {
    pos: [-0.0262, 0.056, 0.05],
    rot: [0, 25, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'readout', new PlaneGeometry(0.022, 0.0172), {
    pos: [-0.0293, 0.056, 0.0515],
    rot: [0, -65, 0],
    uv: 'keep',
  });

  // --- lower receiver, magwell, trigger guard ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.1, 0.029],
        [0.135, 0.029],
        [0.135, 0.012],
        [0.128, 0.004],
        [0.125, -0.022],
        [0.068, -0.022],
        [0.066, 0.0],
        [-0.03, 0.0],
        [-0.1, 0.012],
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
        [-0.002, 0.002],
        [0.066, 0.002],
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
            [0.01, -0.004],
            [0.06, -0.004],
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
        [0.032, 0.0],
        [0.038, 0.0],
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
  // Magazine release (accent) on the magwell.
  b.add(BODY, 'accentPaint', roundedBox(0.0026, 0.007, 0.009, 0.001), {
    pos: [0.0228, 0.012, -0.063],
    paint: P.accentPaint.paint,
  });

  // --- grip ---
  b.add(BODY, 'polymer', roundedBox(0.03, 0.105, 0.042, 0.007, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0322, 0.07, 0.034, 0.004), {
    pos: gripAxis(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- skeleton stock + butt pad ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.095, 0.072],
        [-0.33, 0.07],
        [-0.335, 0.06],
        [-0.335, -0.045],
        [-0.32, -0.05],
        [-0.095, 0.008],
      ],
      0.036,
      {
        bevel: 0.003,
        holes: [
          [
            [-0.14, 0.058],
            [-0.29, 0.056],
            [-0.29, -0.022],
            [-0.14, 0.022],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.038, 0.122, 0.016, 0.004), {
    pos: [0, 0.012, 0.343],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- handguard (hollow octagon) with heat vents ---
  b.add(
    BODY,
    'gunmetal',
    profileZ(chamferRectProfile(0.052, 0.05, 0.012), 0.21, {
      bevel: 0.002,
      holes: [chamferRectProfile(0.036, 0.034, 0.008)],
    }),
    { pos: [0, BORE_Y, -0.335], paint: P.gunmetal.paint },
  );
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const z = -0.262 - i * 0.034;
      b.add(BODY, 'darkMetal', new BoxGeometry(0.0012, 0.024, 0.013), {
        pos: [side * 0.0258, BORE_Y, z],
        rot: [30, 0, 0],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.019, 0.0075), {
        pos: [side * 0.0262, BORE_Y, z],
        rot: [30, 0, 0],
      });
    }
  }

  // --- barrel, gas block, muzzle brake ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0095, 0.0095, 0.37, 18), {
    pos: [0, BORE_Y, -0.305],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.022, 0.026, 0.02, 0.003), {
    pos: [0, BORE_Y + 0.003, -0.456],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    latheZ(
      [
        [0.0, 0.0],
        [0.0125, 0.0],
        [0.0138, 0.004],
        [0.0138, 0.058],
        [0.0118, 0.066],
        [0.0065, 0.066],
      ],
      22,
    ),
    { pos: [0, BORE_Y, -0.49], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 3; i++) {
    b.add(BODY, 'bore', new BoxGeometry(0.0285, 0.0052, 0.008), { pos: [0, BORE_Y, -0.505 - i * 0.015] });
    b.add(BODY, 'bore', new BoxGeometry(0.006, 0.0285, 0.006), { pos: [0, BORE_Y, -0.512 - i * 0.015] });
  }
  b.add(BODY, 'bore', cylinderZ(0.0058, 0.0058, 0.0012, 16), { pos: [0, BORE_Y, -0.5562] });

  // --- charging handle (left, reciprocating) ---
  b.add('chargingHandle', 'darkMetal', cylinderX(0.0028, 0.012, 10), {
    pos: [-0.03, 0.062, -0.18],
    paint: P.darkMetal.paint,
  });
  b.add('chargingHandle', 'accentPaint', roundedBox(0.012, 0.012, 0.015, 0.003), {
    pos: [-0.039, 0.062, -0.18],
    paint: P.accentPaint.paint,
  });

  // --- bolt (right port) + dust cover (hinged at the port's lower edge) ---
  b.add('bolt', 'gunmetal', roundedBox(0.0016, 0.012, 0.022, 0.0006), {
    pos: [0.0237, 0.0565, -0.035],
    paint: 0.5,
  });
  b.add('dustCover', 'gunmetal', roundedBox(0.0016, 0.0215, 0.064, 0.0006), {
    pos: [0.0247, 0.0567, -0.02],
    paint: P.gunmetal.paint,
  });

  // --- curved magazine ---
  b.add(
    'magazine',
    'polymer',
    profileX(
      [
        [0.074, 0.0],
        [0.121, 0.0],
        [0.124, -0.04],
        [0.133, -0.09],
        [0.15, -0.135],
        [0.108, -0.145],
        [0.094, -0.1],
        [0.082, -0.05],
      ],
      0.024,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  for (let i = 0; i < 3; i++) {
    b.add('magazine', 'darkMetal', new BoxGeometry(0.0252, 0.003, 0.03), {
      pos: [0, -0.03 - i * 0.03, -(0.1 + i * 0.008)],
      rot: [8 + i * 6, 0, 0],
      paint: P.darkMetal.paint,
    });
  }
  b.add('magazine', 'accentPaint', roundedBox(0.03, 0.009, 0.05, 0.003), {
    pos: [0, -0.1445, -0.129],
    rot: [13.4, 0, 0],
    paint: P.accentPaint.paint,
  });

  // --- red-dot sight (tube on the rail) ---
  b.add('sight', 'darkMetal', roundedBox(0.026, 0.009, 0.06, 0.002), {
    pos: [0, 0.0895, -0.042],
    paint: P.darkMetal.paint,
  });
  b.add(
    'sight',
    'gunmetal',
    profileZ(chamferRectProfile(0.036, 0.031, 0.006, 0.003), 0.06, {
      bevel: 0.0015,
      holes: [chamferRectProfile(0.028, 0.023, 0.004, 0.002)],
    }),
    { pos: [0, SIGHT_Y, -0.042], paint: P.gunmetal.paint },
  );
  b.add('sight', 'accent', new BoxGeometry(0.012, 0.0012, 0.04), { pos: [0, SIGHT_Y + 0.0156, -0.042] });
  b.add('sight', 'darkMetal', cylinderX(0.005, 0.008, 14), {
    pos: [0.021, SIGHT_Y - 0.004, -0.03],
    paint: P.darkMetal.paint,
  });
  b.add('sight', 'lens', new PlaneGeometry(0.029, 0.024), { pos: [0, SIGHT_Y, -0.068], uv: 'keep' });
  b.add('sight', 'sight', cylinderZ(0.0011, 0.0011, 0.0004, 12), { pos: [0, SIGHT_Y, -0.0675] });

  // --- sockets ---
  b.socket('muzzle', [0, BORE_Y, -0.558]);
  b.socket('ejectPort', [0.026, 0.0565, -0.02], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.011]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('rifle', def, built, glow, readoutSpec, readout);
}

export const RIFLE_SIGHT_LINE = SIGHT_Y;
