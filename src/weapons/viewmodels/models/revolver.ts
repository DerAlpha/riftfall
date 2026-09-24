/**
 * RM-44 „Richter“ – heavy six-shot revolver (M5). Model content (meters, model space: origin = grip
 * pivot, barrel along −Z). A low-bore-axis design: the barrel lines up with the BOTTOM chamber of a
 * flat-sided hex cylinder, under a long gauss shroud with glowing flanks and heat vents.
 *
 * Parts: crane (hinged low-left in front of the cylinder, swings the cylinder out to the left) →
 * cylinder (indexes 60° per shot) → rounds (six cartridges, ejected/loaded) and ejector (rod +
 * star); speedloader (hidden, rides the crane), hammer (spur, cocks and falls per shot), trigger.
 * Iron sights with tritium dots share the sight line; six chamber LEDs on an angled pod on the
 * left flank show the rounds left.
 */
import { BoxGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { REVOLVER_VIEWMODEL } from '../../../defs/viewmodelData/revolver';
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
  regularPolygonProfile,
  roundedBox,
  tiltedAxisPoint,
  type ProfilePoint,
} from '../shapes';
import { ProceduralWeaponModel, createReadout, ledUv, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

/** Bore axis = the bottom chamber; the cylinder axis sits one chamber radius above it. */
const BORE_Y = 0.024;
const CHAMBER_R = 0.0125;
const CYL_Y = BORE_Y + CHAMBER_R;
/** Hex cylinder: circumradius (corners at the sides), length, rear/front faces. */
const HEX_R = 0.0235;
const CYL_REAR = -0.019;
const CYL_FRONT = -0.065;
const CYL_Z = (CYL_REAR + CYL_FRONT) / 2;
const CYL_LEN = CYL_REAR - CYL_FRONT;
const CHAMBER_HOLE = 0.0056;
const FRAME_W = 0.032;
const FRAME_TOP = 0.066;
const SHROUD_FRONT = -0.214;
/** Sight line (rear notch ear tops = front post top). */
const SIGHT_Y = 0.0725;
const NOTCH_DEPTH = 0.0046;
const DOT_DROP = 0.0022;
const REAR_SIGHT_Z = 0.012;
const FRONT_SIGHT_Z = -0.188;
/** Crane hinge (front, low left): the cylinder swings out around it. */
const CRANE_PIVOT: readonly [number, number, number] = [-0.013, 0.0095, CYL_FRONT - 0.0025];
const GRIP_TILT = -20;
const GRIP_TOP = { y: -0.002, z: 0.024 } as const;
const LEDS = 6;
/** The LED pod on the left flank turns towards the shooter by this much (deg). */
const POD_YAW = 25;

function gripAxis(s: number): [number, number, number] {
  return tiltedAxisPoint(GRIP_TILT, GRIP_TOP.y, GRIP_TOP.z, s);
}

/** Chamber k center [x, y] (k = 0 is the bottom chamber in line with the barrel). */
function chamber(k: number): [number, number] {
  const a = ((270 + 60 * k) * Math.PI) / 180;
  return [Math.cos(a) * CHAMBER_R, CYL_Y + Math.sin(a) * CHAMBER_R];
}

function circleProfile(cx: number, cy: number, r: number, n: number): ProfilePoint[] {
  const pts: ProfilePoint[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

export const buildRevolver: ViewmodelBuilder = (kit) => {
  const def = REVOLVER_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.tritium, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('revolver', VIEWMODEL_ART.uvDensity);

  b.part('crane', CRANE_PIVOT);
  b.part('cylinder', [0, CYL_Y, CYL_Z], { parent: 'crane' });
  b.part('ejector', [0, CYL_Y, CYL_REAR], { parent: 'cylinder' });
  b.part('rounds', [0, CYL_Y, CYL_Z], { parent: 'cylinder' });
  b.part('speedloader', [0, CYL_Y, CYL_REAR], { parent: 'crane', hidden: true });
  b.part('hammer', [0, 0.03, 0.031]);
  b.part('trigger', [0, 0.0, -0.028]);

  // --- frame (side profile with the cylinder window) ---
  b.add(
    BODY,
    'gunmetal',
    profileX(
      [
        [-0.03, -0.006],
        [-0.044, 0.0],
        [-0.045, 0.036],
        [-0.036, 0.05],
        [-0.028, 0.062],
        [-0.02, FRAME_TOP],
        [0.08, FRAME_TOP],
        [0.08, 0.006],
        [0.068, 0.002],
        [0.03, 0.002],
        [0.0, -0.006],
      ],
      FRAME_W,
      {
        bevel: 0.0022,
        holes: [
          [
            [-CYL_REAR - 0.0025, 0.0135],
            [-CYL_FRONT + 0.004, 0.0135],
            [-CYL_FRONT + 0.004, 0.0585],
            [-CYL_REAR - 0.0025, 0.0585],
          ],
        ],
      },
    ),
    { paint: P.gunmetal.paint },
  );
  // Recoil shield: a darker face just behind the rims, with the firing-pin bushing.
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.044, 0.0016, 0.0005), {
    pos: [0, CYL_Y, CYL_REAR + 0.0022],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'brass', cylinderZ(0.0024, 0.0024, 0.0004, 12), { pos: [0, BORE_Y, CYL_REAR + 0.00125] });
  // Machined side plate (right; the LED pod sits on the left) and screws on both flanks.
  b.add(BODY, 'darkMetal', roundedBox(0.0016, 0.024, 0.034, 0.0006), {
    pos: [FRAME_W / 2 + 0.0002, 0.03, 0.02],
    paint: P.darkMetal.paint,
  });
  for (const side of [-1, 1]) {
    for (const [y, z] of [
      [0.018, 0.034],
      [0.052, 0.004],
    ] as const) {
      b.add(BODY, 'gunmetal', cylinderX(0.0019, 0.0012, 10), {
        pos: [side * (FRAME_W / 2 + 0.0011), y, z],
        paint: 0.9,
      });
    }
  }
  // Cylinder release latch (left, behind the cylinder) – accent paint.
  b.add(BODY, 'accentPaint', roundedBox(0.0032, 0.0065, 0.011, 0.001), {
    pos: [-FRAME_W / 2 - 0.0012, 0.047, -0.004],
    paint: P.accentPaint.paint,
  });

  // --- chamber LED pod (left flank, angled towards the shooter) ---
  const podCenter: [number, number, number] = [-FRAME_W / 2 - 0.0022, 0.036, 0.021];
  b.add(BODY, 'darkMetal', roundedBox(0.005, 0.018, 0.026, 0.0012), {
    pos: podCenter,
    rot: [0, POD_YAW, 0],
    paint: P.darkMetal.paint,
  });
  const yaw = (POD_YAW * Math.PI) / 180;
  // Outward normal and the in-plane "along" axis of the angled pod face.
  const nx = -Math.cos(yaw);
  const nz = Math.sin(yaw);
  const ax = Math.sin(yaw);
  const az = Math.cos(yaw);
  for (let i = 0; i < LEDS; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const u = (col - 1) * 0.0068;
    const v = row === 0 ? 0.0036 : -0.0036;
    b.add(BODY, 'readout', new BoxGeometry(0.0012, 0.0046, 0.0054), {
      pos: [podCenter[0] + nx * 0.0025 + ax * u, podCenter[1] + v, podCenter[2] + nz * 0.0025 + az * u],
      rot: [0, POD_YAW, 0],
      uv: ledUv(i, LEDS),
    });
  }

  // --- gauss shroud over the barrel ---
  const shroudLen = -SHROUD_FRONT - 0.074;
  const shroudZ = (SHROUD_FRONT - 0.074) / 2;
  const shroudBottom = BORE_Y - 0.015;
  const shroudH = FRAME_TOP - shroudBottom;
  b.add(
    BODY,
    'gunmetal',
    profileZ(chamferRectProfile(0.03, shroudH, 0.009, 0.007), shroudLen, { bevel: 0.002 }),
    { pos: [0, shroudBottom + shroudH / 2, shroudZ], paint: P.gunmetal.paint },
  );
  // Glowing flanks along the upper chamfers (lying flat on the 45° faces).
  for (const side of [-1, 1]) {
    b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0036, 0.118), {
      pos: [side * 0.0109, FRAME_TOP - 0.0041, shroudZ - 0.004],
      rot: [0, 0, side * 45],
    });
  }
  // Top rib: dark vent slots between the sights.
  for (let i = 0; i < 4; i++) {
    b.add(BODY, 'bore', new BoxGeometry(0.0075, 0.0012, 0.013), {
      pos: [0, FRAME_TOP + 0.0001, -0.092 - i * 0.022],
    });
  }
  // Heat vents on the lower flanks (slanted louvres).
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -0.1 - i * 0.026;
      b.add(BODY, 'darkMetal', new BoxGeometry(0.0012, 0.017, 0.011), {
        pos: [side * 0.0151, BORE_Y + 0.002, z],
        rot: [28, 0, 0],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.013, 0.006), {
        pos: [side * 0.0155, BORE_Y + 0.002, z],
        rot: [28, 0, 0],
      });
    }
  }
  // Muzzle: crowned barrel end, compensator ports on top of the shroud nose.
  b.add(
    BODY,
    'darkMetal',
    latheZ(
      [
        [0.0, 0.0],
        [0.0098, 0.0],
        [0.0098, 0.004],
        [0.0086, 0.006],
        [0.0055, 0.006],
      ],
      20,
    ),
    { pos: [0, BORE_Y, SHROUD_FRONT + 0.001], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'bore', cylinderZ(0.0054, 0.0054, 0.001, 16), { pos: [0, BORE_Y, SHROUD_FRONT - 0.0046] });
  for (let i = 0; i < 2; i++) {
    b.add(BODY, 'bore', new BoxGeometry(0.014, 0.0012, 0.005), {
      pos: [0, FRAME_TOP + 0.0001, SHROUD_FRONT + 0.006 + i * 0.008],
    });
  }
  // Underside: a dark rail strip (the laser mount sits on it).
  b.add(BODY, 'darkMetal', roundedBox(0.016, 0.004, 0.07, 0.0012), {
    pos: [0, shroudBottom - 0.0015, -0.16],
    paint: P.darkMetal.paint,
  });

  // --- sights: U-notch with two tritium dots, front post with one (all on the sight line) ---
  const notchFloor = SIGHT_Y - NOTCH_DEPTH;
  const dotY = SIGHT_Y - DOT_DROP;
  b.add(BODY, 'darkMetal', roundedBox(0.021, notchFloor - FRAME_TOP, 0.008, 0.0008), {
    pos: [0, (notchFloor + FRAME_TOP) / 2, REAR_SIGHT_Z],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.0056, 0.0056]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0063, NOTCH_DEPTH, 0.008, 0.0006), {
      pos: [x, notchFloor + NOTCH_DEPTH / 2, REAR_SIGHT_Z],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'sight', new BoxGeometry(0.0021, 0.0021, 0.0006), { pos: [x, dotY, REAR_SIGHT_Z + 0.0043] });
  }
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-FRONT_SIGHT_Z - 0.0022, FRAME_TOP - 0.001],
        [-FRONT_SIGHT_Z + 0.009, FRAME_TOP - 0.001],
        [-FRONT_SIGHT_Z + 0.0022, SIGHT_Y],
        [-FRONT_SIGHT_Z - 0.0022, SIGHT_Y],
      ],
      0.0036,
      { bevel: 0.0006 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'sight', new BoxGeometry(0.0021, 0.0021, 0.0006), { pos: [0, dotY, FRONT_SIGHT_Z + 0.0023] });

  // --- grip (raked), knurled panels, cap with an accent band ---
  b.add(BODY, 'polymer', roundedBox(0.031, 0.112, 0.047, 0.009, 3), {
    pos: gripAxis(0.052),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0335, 0.08, 0.039, 0.005), {
    pos: gripAxis(0.056),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.0325, 0.008, 0.049, 0.003), {
    pos: gripAxis(0.108),
    rot: [GRIP_TILT, 0, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accentPaint', roundedBox(0.0332, 0.0035, 0.049, 0.0012), {
    pos: gripAxis(0.1025),
    rot: [GRIP_TILT, 0, 0],
    paint: P.accentPaint.paint,
  });

  // --- trigger guard + trigger ---
  b.add(
    BODY,
    'gunmetal',
    profileX(
      [
        [-0.004, 0.003],
        [0.066, 0.003],
        [0.066, -0.019],
        [0.056, -0.033],
        [0.006, -0.035],
        [-0.006, -0.025],
      ],
      0.011,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.008, -0.004],
            [0.058, -0.004],
            [0.058, -0.017],
            [0.05, -0.028],
            [0.01, -0.029],
          ],
        ],
      },
    ),
    { paint: P.gunmetal.paint },
  );
  b.add(
    'trigger',
    'darkMetal',
    profileX(
      [
        [0.024, 0.0],
        [0.031, 0.0],
        [0.033, -0.009],
        [0.03, -0.02],
        [0.024, -0.024],
        [0.027, -0.012],
      ],
      0.0065,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

  // --- hammer (spur, at rest down on the frame) ---
  b.add(
    'hammer',
    'darkMetal',
    profileX(
      [
        [-0.024, 0.036],
        [-0.034, 0.034],
        [-0.043, 0.05],
        [-0.051, 0.059],
        [-0.049, 0.064],
        [-0.041, 0.061],
        [-0.03, 0.055],
        [-0.022, 0.048],
      ],
      0.0085,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );
  // Knurled thumb pad on the spur.
  b.add('hammer', 'grip', roundedBox(0.0092, 0.0032, 0.009, 0.0008), {
    pos: [0, 0.0628, 0.046],
    rot: [-20, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- crane: yoke arm from the hinge to the cylinder hub, hinge pin into the frame ---
  const [px, py, pz] = CRANE_PIVOT;
  const armLen = Math.hypot(-px, CYL_Y - py);
  const armDeg = (Math.atan2(CYL_Y - py, -px) * 180) / Math.PI;
  b.add('crane', 'gunmetal', roundedBox(armLen, 0.0085, 0.0035, 0.0012), {
    pos: [px / 2, (py + CYL_Y) / 2, pz + 0.0005],
    rot: [0, 0, armDeg],
    paint: P.gunmetal.paint,
  });
  b.add('crane', 'darkMetal', cylinderZ(0.0032, 0.0032, 0.03, 12), {
    pos: [px, py, pz - 0.013],
    paint: P.darkMetal.paint,
  });

  // --- cylinder: bevelled hex with six through-chambers, fluted flats with glowing inlays ---
  const holes: ProfilePoint[][] = [];
  for (let k = 0; k < 6; k++) {
    const [cx, cy] = chamber(k);
    holes.push(circleProfile(cx, cy - CYL_Y, CHAMBER_HOLE, 14));
  }
  b.add(
    'cylinder',
    'darkMetal',
    profileZ(regularPolygonProfile(HEX_R, 6), CYL_LEN, { bevel: 0.0016, holes, curveSegments: 2 }),
    { pos: [0, CYL_Y, CYL_Z], paint: P.darkMetal.paint },
  );
  const inradius = HEX_R * Math.cos(Math.PI / 6);
  for (let k = 0; k < 6; k++) {
    const deg = 270 + 60 * k;
    const a = (deg * Math.PI) / 180;
    const r = inradius + 0.0003;
    b.add('cylinder', 'accent', new BoxGeometry(0.0034, 0.0007, CYL_LEN * 0.62), {
      pos: [Math.cos(a) * r, CYL_Y + Math.sin(a) * r, CYL_Z],
      rot: [0, 0, deg - 90],
    });
  }

  // --- ejector: star on the rear face + rod through the cylinder, knurled head in front ---
  // Corners between the chambers, flats under the rims (like a real extractor).
  b.add('ejector', 'gunmetal', profileZ(regularPolygonProfile(0.0088, 6), 0.0008, { bevel: 0.0002 }), {
    pos: [0, CYL_Y, CYL_REAR - 0.0001],
    paint: 0.6,
  });
  b.add('ejector', 'darkMetal', cylinderZ(0.0024, 0.0024, CYL_LEN + 0.012, 10), {
    pos: [0, CYL_Y, CYL_Z - 0.006],
    paint: P.darkMetal.paint,
  });

  // --- rounds: six cartridges (rim + primer at the rear, casing inside, nose at the front) ---
  for (let k = 0; k < 6; k++) {
    const [cx, cy] = chamber(k);
    b.add('rounds', 'brass', cylinderZ(0.0062, 0.0062, 0.0014, 14), { pos: [cx, cy, CYL_REAR + 0.0003] });
    b.add('rounds', 'darkMetal', cylinderZ(0.0019, 0.0019, 0.0004, 10), { pos: [cx, cy, CYL_REAR + 0.0011] });
    b.add('rounds', 'brass', cylinderZ(0.0051, 0.0053, 0.034, 10), { pos: [cx, cy, CYL_REAR - 0.0167] });
    b.add(
      'rounds',
      'brass',
      latheZ(
        [
          [0.0, 0.0],
          [0.0047, 0.0],
          [0.0045, 0.004],
          [0.0032, 0.0085],
          [0.0012, 0.0105],
          [0.0, 0.011],
        ],
        10,
      ),
      { pos: [cx, cy, CYL_REAR - 0.0337] },
    );
  }

  // --- speedloader: hex plate + knurled knob behind the rims (hidden until the magIn) ---
  b.add(
    'speedloader',
    'polymer',
    profileZ(regularPolygonProfile(0.021, 6), 0.0055, { bevel: 0.0012, curveSegments: 2 }),
    { pos: [0, CYL_Y, CYL_REAR + 0.0045], paint: P.polymer.paint },
  );
  b.add('speedloader', 'grip', cylinderZ(0.0068, 0.0072, 0.011, 16), {
    pos: [0, CYL_Y, CYL_REAR + 0.0125],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add('speedloader', 'accentPaint', cylinderZ(0.0074, 0.0074, 0.0025, 16), {
    pos: [0, CYL_Y, CYL_REAR + 0.0165],
    paint: P.accentPaint.paint,
  });

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, SHROUD_FRONT - 0.005]);
  // No casings fly (a revolver keeps them): the port sits at the cylinder gap for completeness.
  b.socket('ejectPort', [FRAME_W / 2 + 0.006, CYL_Y, CYL_REAR], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, REAR_SIGHT_Z]);
  b.mount('optic', [0, FRAME_TOP, -0.045]);
  b.mount('muzzleDevice', [0, BORE_Y, SHROUD_FRONT - 0.005]);
  b.mount('laser', [0, shroudBottom - 0.0035, -0.16], [0, 0, 180]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('revolver', def, built, glow, readoutSpec, readout);
};

/** Exposed for tests: the sight line height the model was built with. */
export const REVOLVER_SIGHT_LINE = SIGHT_Y;
