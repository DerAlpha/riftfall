/**
 * KV-9 „Kolibri“ – high-rate, low-recoil submachine gun (M5). Model content (meters, model space:
 * origin = grip pivot, barrel along −Z). The recoil-mitigating layout: a long flat-top upper with
 * the bore high over the hand, a deep lower receiver whose slanted "beak" drops from the shroud to
 * the magwell in front of the trigger guard (glowing seams run along it), a skeleton folding stock.
 *
 * Parts: bolt (the counter-mass carrier, seen through a window in the left flank of the lower:
 * it jumps down with every shot), magazine, trigger. A peep aperture and a hooded front post
 * share the sight line; ten LEDs in a column on the magwell's left side show the rounds left.
 */
import { BoxGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { VECTOR_VIEWMODEL } from '../../../defs/viewmodelData/vector';
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
  type ProfilePoint,
} from '../shapes';
import { ProceduralWeaponModel, createReadout, ledUv, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.048;
const RAIL_TOP = 0.078;
/** Sight line: peep hole center = front post top. */
const SIGHT_Y = 0.093;
const REAR_SIGHT_Z = 0.056;
/** Peep aperture radius: large enough to frame the front post at arm's length. */
const PEEP_R = 0.0047;
const FRONT_SIGHT_Z = -0.274;
const RECEIVER_REAR = 0.075;
const SHROUD_REAR = -0.2;
const SHROUD_FRONT = -0.29;
const SHROUD_BOTTOM = BORE_Y - 0.016;
const MUZZLE_Z = -0.326;
const LOWER_W = 0.036;
const GRIP_TILT = -12;
const GRIP_TOP = { y: 0.002, z: 0.014 } as const;
/** The beak: the lower receiver's slanted front edge from the magwell up to the shroud. */
const BEAK_BOTTOM: readonly [number, number] = [0.112, -0.024];
const BEAK_TOP: readonly [number, number] = [0.19, 0.027];
const MAGWELL_Z = -0.085;
const LEDS = 10;
/** The LED column on the magwell turns towards the shooter by this much (deg). */
const LED_YAW = 22;

function gripAxis(s: number): [number, number, number] {
  return tiltedAxisPoint(GRIP_TILT, GRIP_TOP.y, GRIP_TOP.z, s);
}

function circle(r: number, n: number, cy = 0): ProfilePoint[] {
  const pts: ProfilePoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

export const buildVector: ViewmodelBuilder = (kit) => {
  const def = VECTOR_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.tritium, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('vector', VIEWMODEL_ART.uvDensity);

  b.part('bolt', [-LOWER_W / 2, 0.022, -0.028]);
  b.part('trigger', [0, 0.0, -0.032]);
  b.part('magazine', [0, -0.03, MAGWELL_Z]);

  // --- upper receiver + rail over receiver and shroud ---
  const upperLen = RECEIVER_REAR - SHROUD_REAR + 0.006;
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.034, 0.03, 0.005, 0.002), upperLen, { bevel: 0.002 }), {
    pos: [0, 0.057, RECEIVER_REAR - upperLen / 2],
    paint: P.gunmetal.paint,
  });
  const railRear = RECEIVER_REAR - 0.004;
  const railFront = FRONT_SIGHT_Z - 0.01;
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
  // Charging handle (left, static) + slot; ejection port with brass (right).
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.006, 0.05), { pos: [-0.0172, 0.06, -0.13] });
  b.add(BODY, 'accentPaint', roundedBox(0.011, 0.01, 0.013, 0.0028), {
    pos: [-0.0225, 0.06, -0.152],
    paint: P.accentPaint.paint,
  });
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.013, 0.034), { pos: [0.0172, 0.056, -0.02] });
  b.add(BODY, 'brass', new BoxGeometry(0.0006, 0.005, 0.013), { pos: [0.0176, 0.056, -0.022] });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.16), { pos: [-0.0172, 0.049, -0.03] });

  // --- lower receiver: grip frame, magwell, slanted beak ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-RECEIVER_REAR, 0.044],
        [-SHROUD_REAR + 0.006, 0.044],
        [-SHROUD_REAR + 0.006, 0.034],
        [BEAK_TOP[0], BEAK_TOP[1]],
        [BEAK_BOTTOM[0], BEAK_BOTTOM[1]],
        [0.104, -0.03],
        [0.064, -0.03],
        [0.06, 0.0],
        [-0.035, 0.004],
        [-RECEIVER_REAR, 0.022],
      ],
      LOWER_W,
      { bevel: 0.003 },
    ),
    { paint: P.polymer.paint },
  );
  // Glowing seams along the beak (both flanks), parallel to its slope, a little inside the edge.
  const dz = BEAK_TOP[0] - BEAK_BOTTOM[0];
  const dy = BEAK_TOP[1] - BEAK_BOTTOM[1];
  const len = Math.hypot(dz, dy);
  const slopeDeg = (Math.atan2(dy, dz) * 180) / Math.PI;
  const inset = 0.005;
  const midF = (BEAK_TOP[0] + BEAK_BOTTOM[0]) / 2 - (dy / len) * inset;
  const midU = (BEAK_TOP[1] + BEAK_BOTTOM[1]) / 2 + (dz / len) * inset;
  for (const side of [-1, 1]) {
    b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, len * 0.82), {
      pos: [side * (LOWER_W / 2 + 0.0002), midU, -midF],
      rot: [slopeDeg, 0, 0],
    });
  }
  // Carrier window (left flank): a raised bezel around the dark recess the counter-mass shows through.
  b.add(BODY, 'darkMetal', roundedBox(0.0016, 0.036, 0.054, 0.0006), {
    pos: [-LOWER_W / 2 - 0.0006, 0.021, -0.028],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.03, 0.046), { pos: [-LOWER_W / 2 - 0.0013, 0.021, -0.028] });
  // Takedown pins (both flanks).
  for (const side of [-1, 1]) {
    for (const [y, z] of [
      [0.036, 0.05],
      [0.03, -0.1],
    ] as const) {
      b.add(BODY, 'gunmetal', cylinderX(0.0022, 0.0014, 10), { pos: [side * (LOWER_W / 2 + 0.0004), y, z], paint: 0.9 });
    }
  }
  // Magazine release (right) and a darker magwell lip.
  b.add(BODY, 'accentPaint', roundedBox(0.0026, 0.007, 0.008, 0.001), {
    pos: [LOWER_W / 2 + 0.0008, -0.012, -0.058],
    paint: P.accentPaint.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(LOWER_W + 0.002, 0.004, 0.044, 0.0012), {
    pos: [0, -0.029, MAGWELL_Z + 0.001],
    paint: P.darkMetal.paint,
  });

  // --- ammo LEDs: a column on the magwell's left side, angled towards the shooter ---
  const ledCenter: [number, number, number] = [-LOWER_W / 2 - 0.0022, 0.004, MAGWELL_Z + 0.004];
  b.add(BODY, 'darkMetal', roundedBox(0.0045, 0.062, 0.012, 0.0012), {
    pos: ledCenter,
    rot: [0, LED_YAW, 0],
    paint: P.darkMetal.paint,
  });
  const yaw = (LED_YAW * Math.PI) / 180;
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0012, 0.0042, 0.0072), {
      pos: [ledCenter[0] - Math.cos(yaw) * 0.0023, -0.023 + i * 0.006, ledCenter[2] + Math.sin(yaw) * 0.0023],
      rot: [0, LED_YAW, 0],
      uv: ledUv(i, LEDS),
    });
  }

  // --- trigger guard + trigger ---
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
        [0.028, 0.0],
        [0.034, 0.0],
        [0.035, -0.009],
        [0.032, -0.019],
        [0.027, -0.022],
        [0.029, -0.012],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

  // --- grip (steep) ---
  b.add(BODY, 'polymer', roundedBox(0.03, 0.106, 0.042, 0.007, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0322, 0.072, 0.034, 0.004), {
    pos: gripAxis(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- skeleton folding stock: hinge block, frame, butt pad ---
  b.add(BODY, 'darkMetal', roundedBox(0.028, 0.03, 0.016, 0.003), {
    pos: [0, 0.04, RECEIVER_REAR + 0.006],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-RECEIVER_REAR - 0.01, 0.058],
        [-0.3, 0.056],
        [-0.306, 0.046],
        [-0.306, -0.036],
        [-0.294, -0.042],
        [-RECEIVER_REAR - 0.01, 0.02],
      ],
      0.024,
      {
        bevel: 0.0025,
        holes: [
          [
            [-0.12, 0.046],
            [-0.276, 0.044],
            [-0.276, -0.016],
            [-0.12, 0.028],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.03, 0.104, 0.012, 0.004), {
    pos: [0, 0.008, 0.312],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- barrel shroud (vented), slim ported compensator ---
  const shroudLen = SHROUD_REAR - SHROUD_FRONT;
  const shroudZ = (SHROUD_REAR + SHROUD_FRONT) / 2;
  const shroudTop = RAIL_TOP - 0.006;
  b.add(
    BODY,
    'gunmetal',
    profileZ(chamferRectProfile(0.03, shroudTop - SHROUD_BOTTOM, 0.007, 0.006), shroudLen, { bevel: 0.002 }),
    { pos: [0, (shroudTop + SHROUD_BOTTOM) / 2, shroudZ], paint: P.gunmetal.paint },
  );
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = SHROUD_REAR - 0.022 - i * 0.022;
      b.add(BODY, 'darkMetal', new BoxGeometry(0.0012, 0.022, 0.011), {
        pos: [side * 0.0152, BORE_Y + 0.004, z],
        rot: [26, 0, 0],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.018, 0.006), {
        pos: [side * 0.0156, BORE_Y + 0.004, z],
        rot: [26, 0, 0],
      });
    }
  }
  // Short rail under the shroud (underbarrel mount).
  b.add(BODY, 'darkMetal', new BoxGeometry(0.016, 0.004, 0.06), {
    pos: [0, SHROUD_BOTTOM - 0.0015, shroudZ],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', cylinderZ(0.0068, 0.0068, 0.03, 16), {
    pos: [0, BORE_Y, SHROUD_FRONT - 0.01],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    latheZ(
      [
        [0.0, 0.0],
        [0.0092, 0.0],
        [0.0096, 0.003],
        [0.0096, 0.024],
        [0.0084, 0.028],
        [0.0052, 0.028],
      ],
      10,
    ),
    { pos: [0, BORE_Y, MUZZLE_Z + 0.028], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 3; i++) {
    b.add(BODY, 'heat', new BoxGeometry(0.012, 0.0014, 0.0045), {
      pos: [0, BORE_Y + 0.0092, MUZZLE_Z + 0.02 - i * 0.0065],
    });
  }
  b.add(BODY, 'bore', cylinderZ(0.005, 0.005, 0.001, 14), { pos: [0, BORE_Y, MUZZLE_Z + 0.0004] });

  // --- sights: peep aperture plate on the rear rail, hooded post at the front ---
  b.add(BODY, 'darkMetal', roundedBox(0.022, 0.005, 0.014, 0.0012), {
    pos: [0, RAIL_TOP + 0.0015, REAR_SIGHT_Z],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    profileZ(
      [
        [0.0085, RAIL_TOP + 0.002 - SIGHT_Y],
        [0.0085, 0.0055],
        [0.0055, 0.0085],
        [-0.0055, 0.0085],
        [-0.0085, 0.0055],
        [-0.0085, RAIL_TOP + 0.002 - SIGHT_Y],
      ],
      0.004,
      { bevel: 0.0006, holes: [circle(PEEP_R, 18)] },
    ),
    { pos: [0, SIGHT_Y, REAR_SIGHT_Z], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.005, 0.012, 0.0012), {
    pos: [0, RAIL_TOP + 0.0015, FRONT_SIGHT_Z],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.0078, 0.0078]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0026, SIGHT_Y - RAIL_TOP + 0.003, 0.008, 0.0008), {
      pos: [x, (SIGHT_Y + RAIL_TOP) / 2 + 0.0015, FRONT_SIGHT_Z],
      paint: P.darkMetal.paint,
    });
  }
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-FRONT_SIGHT_Z - 0.002, RAIL_TOP + 0.003],
        [-FRONT_SIGHT_Z + 0.005, RAIL_TOP + 0.003],
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

  // --- counter-mass carrier behind the left window ---
  b.add('bolt', 'gunmetal', roundedBox(0.0018, 0.017, 0.03, 0.0006), {
    pos: [-LOWER_W / 2 - 0.0022, 0.022, -0.028],
    paint: 0.55,
  });
  b.add('bolt', 'accent', new BoxGeometry(0.0006, 0.0016, 0.026), {
    pos: [-LOWER_W / 2 - 0.0033, 0.027, -0.028],
  });

  // --- magazine (double stack, straight down out of the magwell) ---
  b.add('magazine', 'polymer', roundedBox(0.024, 0.142, 0.034, 0.003), {
    pos: [0, -0.1, MAGWELL_Z],
    paint: P.polymer.paint,
  });
  b.add('magazine', 'darkMetal', new BoxGeometry(0.0244, 0.1, 0.004), {
    pos: [0, -0.1, MAGWELL_Z - 0.0152],
    paint: P.darkMetal.paint,
  });
  b.add('magazine', 'accentPaint', roundedBox(0.03, 0.01, 0.042, 0.003), {
    pos: [0, -0.174, MAGWELL_Z - 0.001],
    paint: P.accentPaint.paint,
  });

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.0185, 0.056, -0.02], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, REAR_SIGHT_Z + 0.002]);
  b.mount('optic', [0, RAIL_TOP, -0.07]);
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, SHROUD_BOTTOM - 0.0035, shroudZ]);
  b.mount('laser', [-0.0155, BORE_Y + 0.004, shroudZ - 0.02], [0, 0, 90]);
  b.mount('stock', [0, 0.04, RECEIVER_REAR + 0.014]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('vector', def, built, glow, readoutSpec, readout);
};

/** Exposed for tests: the sight line height the model was built with. */
export const VECTOR_SIGHT_LINE = SIGHT_Y;
