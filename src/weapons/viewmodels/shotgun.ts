/**
 * SG-12 "Brecher" – heavy pump shotgun. Model content (meters, model space: origin = grip pivot,
 * barrel along −Z). Parts: pump (fore-end with action bars that slide into the receiver),
 * shell (hidden at rest, shown while being pushed into the loading port), trigger, ghost-ring
 * sight. Front bead and ghost ring share the sight line. A row of shell LEDs on the left side
 * shows the tube count; the vented heat shield glows after a few shots.
 */
import { BoxGeometry, SphereGeometry, TorusGeometry } from 'three';
import { VIEWMODEL_ART, VIEWMODELS } from '../../defs/viewmodels';
import { getWeaponDef } from '../../defs/weapons';
import { BODY, ModelBuilder } from './ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from './materials';
import {
  chamferRectProfile,
  cylinderZ,
  latheZ,
  profileX,
  profileZ,
  roundedBox,
  type ProfilePoint,
} from './shapes';
import {
  ProceduralWeaponModel,
  createReadout,
  ledUv,
  type ReadoutSpec,
  type WeaponViewmodelModel,
} from './WeaponModel';

const P = VIEWMODEL_ART.materials;

const SIGHT_Y = 0.092;
/** Front bead radius (sits on the front post, centered on the sight line). */
const BEAD_R = 0.0042;
const BARREL_Y = 0.058;
const TUBE_Y = 0.03;
const GRIP_TILT = -18;
const GRIP_TOP = { y: 0.006, z: 0.012 } as const;
/** One LED per shell, capped so the row fits the receiver flank. */
const MAX_LEDS = 8;
const DEFAULT_LEDS = 6;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

/** Upper half-ring cross-section (heat shield) around the origin. */
function archProfile(
  rOuter: number,
  rInner: number,
  fromDeg: number,
  toDeg: number,
  steps: number,
): ProfilePoint[] {
  const pts: ProfilePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    pts.push([Math.cos(a) * rOuter, Math.sin(a) * rOuter]);
  }
  for (let i = steps; i >= 0; i--) {
    const a = ((fromDeg + ((toDeg - fromDeg) * i) / steps) * Math.PI) / 180;
    pts.push([Math.cos(a) * rInner, Math.sin(a) * rInner]);
  }
  return pts;
}

export function buildShotgun(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = VIEWMODELS.shotgun;
  const leds = Math.max(1, Math.min(MAX_LEDS, getWeaponDef('shotgun')?.magazine ?? DEFAULT_LEDS));
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: leds };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.heat, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('shotgun', VIEWMODEL_ART.uvDensity);

  b.part('pump', [0, TUBE_Y, -0.325]);
  b.part('shell', [0, 0.022, -0.07], { hidden: true });
  b.part('trigger', [0, 0.012, -0.032]);
  b.part('sight', [0, 0.08, 0.05]);

  // --- receiver ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.05, 0.066, 0.012, 0.006), 0.245, { bevel: 0.0025 }), {
    pos: [0, 0.047, -0.0375],
    paint: P.gunmetal.paint,
  });
  // Side plates with bolts (raised panels read as machined inserts).
  for (const side of [-1, 1]) {
    b.add(BODY, 'darkMetal', roundedBox(0.002, 0.03, 0.12, 0.0008), {
      pos: [side * 0.0254, 0.056, -0.05],
      paint: P.darkMetal.paint,
    });
  }
  // Loading port (below) and ejection port (right).
  b.add(BODY, 'bore', new BoxGeometry(0.022, 0.0012, 0.07), { pos: [0, 0.0138, -0.07] });
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.022, 0.06), { pos: [0.0266, 0.056, -0.05] });
  // Accent strip along the upper-left chamfer.
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0024, 0.2), {
    pos: [-0.0205, 0.0752, -0.04],
    rot: [0, 0, 45],
  });
  // Shell LEDs (left flank) in a bezel.
  const ledStep = 0.013;
  const ledStart = 0.02;
  b.add(BODY, 'darkMetal', roundedBox(0.0014, 0.009, leds * ledStep + 0.006, 0.0005), {
    pos: [-0.0266, 0.032, ledStart - ((leds - 1) * ledStep) / 2],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < leds; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0012, 0.0045, 0.0075), {
      pos: [-0.0273, 0.032, ledStart - i * ledStep],
      uv: ledUv(i, leds),
    });
  }

  // --- trigger group, guard, trigger ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.03, 0.016],
        [0.07, 0.016],
        [0.07, 0.009],
        [-0.03, 0.004],
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
        [-0.002, 0.012],
        [0.066, 0.012],
        [0.066, -0.01],
        [0.058, -0.02],
        [0.006, -0.02],
        [-0.004, -0.008],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, 0.008],
            [0.058, 0.008],
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
        [0.03, 0.012],
        [0.036, 0.012],
        [0.037, 0.003],
        [0.034, -0.007],
        [0.029, -0.01],
        [0.031, 0.0],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

  // --- grip ---
  b.add(BODY, 'polymer', roundedBox(0.031, 0.108, 0.044, 0.007, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0332, 0.072, 0.036, 0.004), {
    pos: gripAxis(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- stock ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.08, 0.078],
        [-0.3, 0.07],
        [-0.305, 0.058],
        [-0.305, -0.045],
        [-0.29, -0.05],
        [-0.08, 0.016],
      ],
      0.038,
      {
        bevel: 0.003,
        holes: [
          [
            [-0.13, 0.058],
            [-0.27, 0.054],
            [-0.27, -0.022],
            [-0.13, 0.026],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.04, 0.124, 0.018, 0.004), {
    pos: [0, 0.012, 0.314],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- barrel, heat shield, tube, clamp, breacher muzzle ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0118, 0.0118, 0.46, 20), {
    pos: [0, BARREL_Y, -0.39],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', profileZ(archProfile(0.0172, 0.0138, 10, 170, 10), 0.3, { bevel: 0.001 }), {
    pos: [0, BARREL_Y, -0.35],
    paint: P.gunmetal.paint,
  });
  for (let i = 0; i < 6; i++) {
    b.add(BODY, 'heat', roundedBox(0.009, 0.0012, 0.028, 0.0005), {
      pos: [0, BARREL_Y + 0.0174, -0.23 - i * 0.046],
    });
  }
  b.add(BODY, 'darkMetal', cylinderZ(0.0105, 0.0105, 0.4, 18), {
    pos: [0, TUBE_Y, -0.36],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    latheZ(
      [
        [0.0, 0.0],
        [0.0118, 0.0],
        [0.0122, 0.004],
        [0.0122, 0.022],
        [0.009, 0.026],
        [0.0, 0.026],
      ],
      18,
    ),
    { pos: [0, TUBE_Y, -0.56], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'gunmetal', roundedBox(0.028, 0.048, 0.016, 0.003), {
    pos: [0, (BARREL_Y + TUBE_Y) / 2, -0.572],
    paint: P.gunmetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    latheZ(
      [
        [0.0, 0.0],
        [0.0135, 0.0],
        [0.0148, 0.005],
        [0.0148, 0.036],
        [0.0122, 0.042],
        [0.0098, 0.042],
      ],
      8,
    ),
    { pos: [0, BARREL_Y, -0.62], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 2; i++) {
    b.add(BODY, 'bore', new BoxGeometry(0.031, 0.006, 0.009), { pos: [0, BARREL_Y, -0.632 - i * 0.014] });
  }
  b.add(BODY, 'bore', cylinderZ(0.0096, 0.0096, 0.0012, 16), { pos: [0, BARREL_Y, -0.6626] });

  // --- sights: front post + glowing bead, ghost ring with protective ears ---
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [0.586, BARREL_Y + 0.011],
        [0.606, BARREL_Y + 0.011],
        [0.601, SIGHT_Y - BEAD_R * 0.7],
        [0.593, SIGHT_Y - BEAD_R * 0.7],
      ],
      0.005,
      { bevel: 0.0008 },
    ),
    { paint: P.darkMetal.paint },
  );
  // Oversized glowing bead: it has to read inside the ghost ring from 0.8 m away.
  b.add(BODY, 'sight', new SphereGeometry(BEAD_R, 14, 10), { pos: [0, SIGHT_Y, -0.597] });
  b.add('sight', 'darkMetal', roundedBox(0.03, 0.006, 0.02, 0.0015), {
    pos: [0, 0.083, 0.05],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.0115, 0.0115]) {
    b.add('sight', 'darkMetal', roundedBox(0.004, 0.017, 0.012, 0.001), {
      pos: [x, SIGHT_Y, 0.05],
      paint: P.darkMetal.paint,
    });
  }
  b.add('sight', 'darkMetal', new TorusGeometry(0.0062, 0.0017, 8, 22), {
    pos: [0, SIGHT_Y, 0.05],
    paint: P.darkMetal.paint,
  });
  b.add('sight', 'darkMetal', new BoxGeometry(0.003, 0.004, 0.004), {
    pos: [0, SIGHT_Y - 0.0098, 0.05],
    paint: P.darkMetal.paint,
  });

  // --- pump: sleeve, knurled ribs, accent band, action bars ---
  b.add('pump', 'polymer', profileZ(chamferRectProfile(0.046, 0.04, 0.01, 0.008), 0.15, { bevel: 0.002 }), {
    pos: [0, TUBE_Y, -0.325],
    paint: P.polymer.paint,
  });
  for (let i = 0; i < 5; i++) {
    b.add(
      'pump',
      'grip',
      profileZ(chamferRectProfile(0.0486, 0.0426, 0.011, 0.009), 0.012, { bevel: 0.001 }),
      {
        pos: [0, TUBE_Y, -0.272 - i * 0.022],
        uvDensity: VIEWMODEL_ART.knurlDensity,
      },
    );
  }
  b.add(
    'pump',
    'accentPaint',
    profileZ(chamferRectProfile(0.0478, 0.0418, 0.0105, 0.0085), 0.01, { bevel: 0.001 }),
    {
      pos: [0, TUBE_Y, -0.392],
      paint: P.accentPaint.paint,
    },
  );
  for (const x of [-0.019, 0.019]) {
    b.add('pump', 'darkMetal', new BoxGeometry(0.002, 0.004, 0.09), {
      pos: [x, 0.021, -0.21],
      paint: P.darkMetal.paint,
    });
  }

  // --- shell (local frame, along −Z; hidden until a shellIn) ---
  b.add('shell', 'shellHull', cylinderZ(0.0104, 0.0104, 0.052, 16), {
    local: true,
    pos: [0, 0, -0.008],
    paint: 1,
  });
  b.add(
    'shell',
    'brass',
    latheZ(
      [
        [0.0, 0.0],
        [0.0112, 0.0],
        [0.0112, 0.002],
        [0.0106, 0.0026],
        [0.0106, 0.014],
        [0.0, 0.014],
      ],
      16,
    ),
    { local: true, pos: [0, 0, 0.032], paint: 1 },
  );

  // --- sockets ---
  b.socket('muzzle', [0, BARREL_Y, -0.664]);
  b.socket('ejectPort', [0.028, 0.056, -0.05], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, 0.047]);
  // Attachment mounts (M5): receiver top, breacher tip, under the pump (rides with it), left side of
  // the barrel clamp (+Y out of the surface), receiver rear.
  b.mount('optic', [0, 0.08, -0.04]);
  b.mount('muzzleDevice', [0, BARREL_Y, -0.664]);
  b.mount('underbarrel', [0, TUBE_Y - 0.02, -0.325], undefined, 'pump');
  b.mount('laser', [-0.014, (BARREL_Y + TUBE_Y) / 2, -0.572], [0, 0, 90]);
  b.mount('stock', [0, 0.047, 0.085]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('shotgun', def, built, glow, readoutSpec, readout);
}

export const SHOTGUN_SIGHT_LINE = SIGHT_Y;
