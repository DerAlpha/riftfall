/**
 * SK-5 „Viper“ – compact submachine gun (M5). Model content (meters, model space: origin = grip
 * pivot, barrel along −Z). A boxy two-tone receiver on a full-length top rail, a vented handguard
 * with a bottom rail, a straight 30-round stick magazine and a twin-rod collapsible stock; the
 * "fang" muzzle brake has two teeth under the bore and glowing ports.
 *
 * Parts: bolt (the left-side cocking handle on the receiver nose, reciprocating per shot), trigger,
 * magazine. Ghost-ring rear sight and a hooded front post with a tritium dot share the sight line;
 * a two-digit counter on the receiver's rear face tilts up towards the eye.
 */
import { BoxGeometry, PlaneGeometry, TorusGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { SMG_VIEWMODEL } from '../../../defs/viewmodelData/smg';
import type { ViewmodelBuilder } from '../index';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials } from '../materials';
import {
  chamferRectProfile,
  cylinderX,
  cylinderZ,
  latheZ,
  profileX,
  profileZ,
  roundedBox,
  tiltedAxisPoint,
} from '../shapes';
import { ProceduralWeaponModel, createReadout, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.046;
const RAIL_TOP = 0.078;
/** Sight line: ghost-ring center = front post top. */
const SIGHT_Y = 0.095;
const REAR_SIGHT_Z = 0.062;
const FRONT_SIGHT_Z = -0.272;
const RECEIVER_REAR = 0.085;
const HANDGUARD_REAR = -0.15;
const HANDGUARD_FRONT = -0.285;
/** The handguard carries the rail on its top and a short rail underneath. */
const HG_TOP = RAIL_TOP - 0.006;
const HG_BOTTOM = BORE_Y - 0.021;
const MUZZLE_Z = -0.338;
const GRIP_TILT = -16;
const GRIP_TOP = { y: 0.002, z: 0.012 } as const;
/** The counter on the receiver's rear face tilts up towards the eye (deg). */
const COUNTER_TILT = -28;

function gripAxis(s: number): [number, number, number] {
  return tiltedAxisPoint(GRIP_TILT, GRIP_TOP.y, GRIP_TOP.z, s);
}

export const buildSmg: ViewmodelBuilder = (kit) => {
  const def = SMG_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'segments' };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.tritium, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('smg', VIEWMODEL_ART.uvDensity);

  b.part('bolt', [-0.0195, 0.064, -0.13]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('magazine', [0, 0.0, -0.08]);

  // --- upper receiver + full-length top rail ---
  const upperLen = RECEIVER_REAR - HANDGUARD_REAR + 0.01;
  b.add(
    BODY,
    'gunmetal',
    profileZ(chamferRectProfile(0.038, 0.034, 0.007, 0.003), upperLen, { bevel: 0.002 }),
    {
      pos: [0, 0.056, RECEIVER_REAR - upperLen / 2],
      paint: P.gunmetal.paint,
    },
  );
  const railRear = RECEIVER_REAR - 0.004;
  const railFront = FRONT_SIGHT_Z - 0.012;
  b.add(BODY, 'darkMetal', new BoxGeometry(0.02, 0.004, railRear - railFront), {
    pos: [0, RAIL_TOP - 0.004, (railRear + railFront) / 2],
    paint: P.darkMetal.paint,
  });
  const teeth = Math.floor((railRear - railFront) / 0.013);
  for (let i = 0; i < teeth; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.0035, 0.0065), {
      pos: [0, RAIL_TOP - 0.00175, railRear - 0.006 - i * 0.013],
      paint: P.darkMetal.paint,
    });
  }
  // Cocking-handle slot (left) and ejection port with a glimpse of brass (right).
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.006, 0.06), { pos: [-0.0192, 0.064, -0.112] });
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.015, 0.036), { pos: [0.0192, 0.054, -0.028] });
  b.add(BODY, 'brass', new BoxGeometry(0.0006, 0.006, 0.014), { pos: [0.0196, 0.054, -0.03] });
  // Accent strips: receiver left flank + handguard upper-left chamfer.
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.13), { pos: [-0.0192, 0.047, 0.005] });
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0034, 0.11), {
    pos: [-0.0154, HG_TOP - 0.0046, (HANDGUARD_REAR + HANDGUARD_FRONT) / 2 - 0.004],
    rot: [0, 0, -45],
  });

  // --- ammo counter on the receiver's rear face, tilted up at the eye ---
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.022, 0.006, 0.0015), {
    pos: [0, 0.057, RECEIVER_REAR + 0.002],
    rot: [COUNTER_TILT, 0, 0],
    paint: P.darkMetal.paint,
  });
  const tilt = (COUNTER_TILT * Math.PI) / 180;
  b.add(BODY, 'readout', new PlaneGeometry(0.023, 0.0178), {
    pos: [0, 0.057 - Math.sin(tilt) * 0.0032, RECEIVER_REAR + 0.002 + Math.cos(tilt) * 0.0032],
    rot: [COUNTER_TILT, 0, 0],
    uv: 'keep',
  });

  // --- lower receiver with the flared magwell ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-RECEIVER_REAR, 0.041],
        [0.13, 0.041],
        [0.13, 0.024],
        [0.11, 0.012],
        [0.106, -0.021],
        [0.057, -0.021],
        [0.057, 0.0],
        [-0.02, 0.0],
        [-0.06, 0.012],
        [-RECEIVER_REAR, 0.024],
      ],
      0.036,
      { bevel: 0.0025 },
    ),
    { paint: P.polymer.paint },
  );
  // Magazine release (right) and a darker magwell lip.
  b.add(BODY, 'accentPaint', roundedBox(0.0026, 0.007, 0.008, 0.001), {
    pos: [0.0187, 0.008, -0.052],
    paint: P.accentPaint.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.038, 0.004, 0.052, 0.0012), {
    pos: [0, -0.02, -0.0815],
    paint: P.darkMetal.paint,
  });
  // Trigger guard + trigger.
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.002],
        [0.058, 0.002],
        [0.058, -0.024],
        [0.05, -0.032],
        [0.008, -0.032],
        [-0.004, -0.022],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, -0.004],
            [0.052, -0.004],
            [0.052, -0.021],
            [0.046, -0.027],
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
        [0.03, 0.0],
        [0.036, 0.0],
        [0.037, -0.009],
        [0.034, -0.019],
        [0.029, -0.022],
        [0.031, -0.012],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

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

  // --- collapsible twin-rod stock + butt plate ---
  const buttZ = 0.238;
  for (const [x, y] of [
    [-0.012, 0.041],
    [0.012, 0.041],
    [0, 0.012],
  ] as const) {
    b.add(BODY, 'darkMetal', cylinderZ(0.0046, 0.0046, buttZ - RECEIVER_REAR, 12), {
      pos: [x, y, (buttZ + RECEIVER_REAR) / 2],
      paint: P.darkMetal.paint,
    });
  }
  b.add(BODY, 'darkMetal', roundedBox(0.036, 0.042, 0.012, 0.003), {
    pos: [0, 0.028, RECEIVER_REAR + 0.004],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-buttZ + 0.012, 0.066],
        [-buttZ - 0.004, 0.066],
        [-buttZ - 0.01, 0.056],
        [-buttZ - 0.01, -0.038],
        [-buttZ - 0.002, -0.046],
        [-buttZ + 0.012, 0.004],
      ],
      0.036,
      { bevel: 0.003 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.038, 0.102, 0.012, 0.004), {
    pos: [0, 0.01, buttZ + 0.014],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- handguard (hollow, chamfered) with heat vents and a bottom rail ---
  const hgLen = HANDGUARD_REAR - HANDGUARD_FRONT;
  const hgZ = (HANDGUARD_REAR + HANDGUARD_FRONT) / 2;
  b.add(
    BODY,
    'darkMetal',
    profileZ(chamferRectProfile(0.04, HG_TOP - HG_BOTTOM, 0.01, 0.008), hgLen, {
      bevel: 0.002,
      holes: [chamferRectProfile(0.028, 0.03, 0.006)],
    }),
    { pos: [0, (HG_TOP + HG_BOTTOM) / 2, hgZ], paint: P.darkMetal.paint },
  );
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = HANDGUARD_REAR - 0.03 - i * 0.026;
      b.add(BODY, 'gunmetal', new BoxGeometry(0.0012, 0.02, 0.012), {
        pos: [side * 0.0202, BORE_Y, z],
        rot: [30, 0, 0],
        paint: P.gunmetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.016, 0.0065), {
        pos: [side * 0.0206, BORE_Y, z],
        rot: [30, 0, 0],
      });
    }
  }
  const underRailY = HG_BOTTOM - 0.002;
  b.add(BODY, 'darkMetal', new BoxGeometry(0.016, 0.004, 0.08), {
    pos: [0, underRailY, hgZ - 0.008],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 6; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.018, 0.003, 0.0065), {
      pos: [0, underRailY - 0.0025, hgZ + 0.024 - i * 0.013],
      paint: P.darkMetal.paint,
    });
  }

  // --- barrel + fang brake ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0075, 0.0075, 0.22, 16), {
    pos: [0, BORE_Y, -0.2],
    paint: P.darkMetal.paint,
  });
  const brakeRear = HANDGUARD_FRONT - 0.012;
  b.add(
    BODY,
    'gunmetal',
    latheZ(
      [
        [0.0, 0.0],
        [0.0108, 0.0],
        [0.0118, 0.004],
        [0.0118, 0.034],
        [0.0098, 0.041],
        [0.0055, 0.041],
      ],
      8,
    ),
    { pos: [0, BORE_Y, brakeRear], paint: P.gunmetal.paint },
  );
  for (let i = 0; i < 2; i++) {
    b.add(BODY, 'heat', new BoxGeometry(0.0246, 0.0045, 0.0075), {
      pos: [0, BORE_Y + 0.002, brakeRear - 0.012 - i * 0.012],
    });
  }
  b.add(BODY, 'bore', cylinderZ(0.0054, 0.0054, 0.0012, 14), { pos: [0, BORE_Y, MUZZLE_Z + 0.0006] });
  // The fangs: two teeth raking forward-down under the bore.
  for (const x of [-0.0055, 0.0055]) {
    b.add(
      BODY,
      'darkMetal',
      profileX(
        [
          [-brakeRear + 0.02, BORE_Y - 0.008],
          [-MUZZLE_Z - 0.002, BORE_Y - 0.009],
          [-MUZZLE_Z + 0.009, BORE_Y - 0.021],
          [-MUZZLE_Z - 0.004, BORE_Y - 0.016],
          [-brakeRear + 0.02, BORE_Y - 0.0125],
        ],
        0.004,
        { bevel: 0.0008 },
      ),
      { pos: [x, 0, 0], paint: 0.55 },
    );
  }

  // --- sights: ghost ring on the rail, hooded front post with a tritium dot ---
  b.add(BODY, 'darkMetal', roundedBox(0.026, 0.006, 0.016, 0.0015), {
    pos: [0, RAIL_TOP + 0.002, REAR_SIGHT_Z],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.011, 0.011]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0036, SIGHT_Y - RAIL_TOP + 0.004, 0.01, 0.001), {
      pos: [x, (SIGHT_Y + RAIL_TOP) / 2 + 0.002, REAR_SIGHT_Z],
      paint: P.darkMetal.paint,
    });
  }
  b.add(BODY, 'darkMetal', new TorusGeometry(0.0058, 0.0016, 8, 22), {
    pos: [0, SIGHT_Y, REAR_SIGHT_Z],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', new BoxGeometry(0.003, SIGHT_Y - RAIL_TOP - 0.0075, 0.004), {
    pos: [0, (SIGHT_Y - 0.0074 + RAIL_TOP) / 2, REAR_SIGHT_Z],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.006, 0.014, 0.0015), {
    pos: [0, RAIL_TOP + 0.002, FRONT_SIGHT_Z],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.0078, 0.0078]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0026, SIGHT_Y - RAIL_TOP + 0.003, 0.009, 0.0008), {
      pos: [x, (SIGHT_Y + RAIL_TOP) / 2 + 0.0015, FRONT_SIGHT_Z],
      paint: P.darkMetal.paint,
    });
  }
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-FRONT_SIGHT_Z - 0.002, RAIL_TOP + 0.004],
        [-FRONT_SIGHT_Z + 0.005, RAIL_TOP + 0.004],
        [-FRONT_SIGHT_Z + 0.0018, SIGHT_Y],
        [-FRONT_SIGHT_Z - 0.0018, SIGHT_Y],
      ],
      0.0028,
      { bevel: 0.0005 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'sight', new BoxGeometry(0.0019, 0.0019, 0.0006), {
    pos: [0, SIGHT_Y - 0.0018, FRONT_SIGHT_Z + 0.0021],
  });

  // --- cocking handle (left nose, reciprocating) ---
  b.add('bolt', 'darkMetal', cylinderX(0.0026, 0.014, 10), {
    pos: [-0.0255, 0.064, -0.13],
    paint: P.darkMetal.paint,
  });
  b.add('bolt', 'accentPaint', roundedBox(0.012, 0.011, 0.014, 0.003), {
    pos: [-0.035, 0.066, -0.132],
    rot: [0, 0, -12],
    paint: P.accentPaint.paint,
  });

  // --- straight stick magazine, canted slightly forward ---
  b.add(
    'magazine',
    'polymer',
    profileX(
      [
        [0.064, 0.0],
        [0.097, 0.0],
        [0.106, -0.152],
        [0.073, -0.155],
      ],
      0.023,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  for (let i = 0; i < 4; i++) {
    b.add('magazine', 'darkMetal', new BoxGeometry(0.0242, 0.0028, 0.031), {
      pos: [0, -0.03 - i * 0.03, -(0.0805 + (0.03 + i * 0.03) * 0.056)],
      rot: [3.2, 0, 0],
      paint: P.darkMetal.paint,
    });
  }
  b.add('magazine', 'accentPaint', roundedBox(0.029, 0.009, 0.042, 0.003), {
    pos: [0, -0.157, -0.0895],
    rot: [3.2, 0, 0],
    paint: P.accentPaint.paint,
  });

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.021, 0.054, -0.028], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, REAR_SIGHT_Z - 0.003]);
  b.mount('optic', [0, RAIL_TOP, -0.02]);
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, underRailY - 0.004, hgZ - 0.008]);
  b.mount('laser', [-0.0205, BORE_Y, hgZ - 0.02], [0, 0, 90]);
  b.mount('stock', [0, 0.045, RECEIVER_REAR]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('smg', def, built, glow, readoutSpec, readout);
};

/** Exposed for tests: the sight line height the model was built with. */
export const SMG_SIGHT_LINE = SIGHT_Y;
