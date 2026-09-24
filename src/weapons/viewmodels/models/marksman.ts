/**
 * DM-8 „Falke“ – semi-auto marksman rifle. Model content (meters, model space: origin = grip pivot,
 * barrel along −Z). A flat-top receiver with a monolithic rail, a slim hexagonal handguard whose
 * swept "feather" vents glow with heat, a three-prong flash hider, an adjustable precision stock and a
 * straight 15-round box. Parts: bolt carrier behind the right ejection port with a spring-loaded dust
 * cover, bolt catch paddle (left, slapped on empty reloads), trigger, magazine and the compact 2.5×
 * prism optic (`sight`): amber chevron reticle with drop stadia, a glowing fibre on top and the
 * ammo counter on its left flank. Like the HX-50 scope, a depth-only disk behind the reticle keeps
 * the ocular a clean window onto the world.
 */
import { BoxGeometry, MeshBasicMaterial, PlaneGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { MARKSMAN_VIEWMODEL } from '../../../defs/viewmodelData/marksman';
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
  type ProfilePoint,
} from '../shapes';
import { ProceduralWeaponModel, createReadout, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

/** Amber of the chevron reticle and the fibre-optic collector (sRGB). */
const RETICLE_AMBER = 0xffa01e;
const BORE_Y = 0.05;
const RAIL_TOP = 0.087;
/** Optic axis (sight line). */
const SIGHT_Y = 0.1145;
/** Rear face of the ocular; the reticle plane and the depth mask sit just in front of it. */
const OCULAR_REAR = 0.005;
const RETICLE_Z = -0.001;
const MASK_Z = -0.003;
const OCULAR_R = 0.0128;
const GRIP_TILT = -18;
const MUZZLE_Z = -0.772;
const MASK_RENDER_ORDER = -1;

const grip = (s: number): [number, number, number] => tiltedAxisPoint(GRIP_TILT, 0.002, 0.012, s);

/** Slim hexagonal handguard section around the bore. */
const HANDGUARD: ProfilePoint[] = [
  [0.024, -0.01],
  [0.024, 0.012],
  [0.013, 0.027],
  [-0.013, 0.027],
  [-0.024, 0.012],
  [-0.024, -0.01],
  [-0.012, -0.025],
  [0.012, -0.025],
];

export const buildMarksman: ViewmodelBuilder = (kit) => {
  const def = MARKSMAN_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'segments' };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(RETICLE_AMBER, readout?.texture ?? null, def.glow);
  const scopeMask = new MeshBasicMaterial({ name: 'vm-scopemask', colorWrite: false });
  const b = new ModelBuilder('marksman', VIEWMODEL_ART.uvDensity);

  b.part('bolt', [0.0236, 0.056, -0.035]);
  b.part('dustCover', [0.0245, 0.0455, -0.02]);
  b.part('boltCatch', [-0.0232, 0.02, -0.05]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('magazine', [0, 0.0, -0.1]);
  b.part('sight', [0, RAIL_TOP, -0.06]);

  // --- upper receiver, forward assist, ports ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.046, 0.05, 0.009, 0.004), 0.3, { bevel: 0.002 }), {
    pos: [0, 0.052, -0.05],
    paint: P.gunmetal.paint,
  });
  b.add(BODY, 'bore', new BoxGeometry(0.0008, 0.018, 0.062), { pos: [0.0234, 0.0565, -0.02] });
  b.add(BODY, 'darkMetal', cylinderZ(0.0062, 0.0062, 0.024, 12), {
    pos: [0.0215, 0.068, 0.058],
    rot: [0, -14, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', cylinderZ(0.0075, 0.0075, 0.008, 14), {
    pos: [0.024, 0.068, 0.072],
    rot: [0, -14, 0],
    paint: 0.6,
  });
  // T charging handle under the rear of the rail.
  b.add(BODY, 'darkMetal', roundedBox(0.036, 0.007, 0.012, 0.002), {
    pos: [0, 0.073, 0.104],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accentPaint', roundedBox(0.008, 0.0075, 0.01, 0.002), {
    pos: [-0.018, 0.073, 0.104],
    paint: P.accentPaint.paint,
  });
  // Monolithic top rail (teeth stop short of the eye).
  b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.006, 0.6), {
    pos: [0, RAIL_TOP - 0.007, -0.2],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 40; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.0035, 0.0062), {
      pos: [0, RAIL_TOP - 0.00175, 0.004 - i * 0.0128],
      paint: P.darkMetal.paint,
    });
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0016, 0.16), { pos: [-0.0233, 0.068, -0.06] });

  // --- lower receiver, magwell, trigger guard, bolt catch ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.1, 0.029],
        [0.138, 0.029],
        [0.138, 0.012],
        [0.131, 0.004],
        [0.128, -0.025],
        [0.068, -0.025],
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
  b.add('boltCatch', 'accentPaint', roundedBox(0.003, 0.012, 0.02, 0.001), {
    pos: [-0.0235, 0.021, -0.058],
    paint: P.accentPaint.paint,
  });
  b.add(BODY, 'accentPaint', roundedBox(0.0026, 0.007, 0.009, 0.001), {
    pos: [0.0228, 0.012, -0.061],
    paint: P.accentPaint.paint,
  });

  // --- grip ---
  b.add(BODY, 'polymer', roundedBox(0.03, 0.105, 0.042, 0.007, 3), {
    pos: grip(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0322, 0.07, 0.034, 0.004), {
    pos: grip(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- precision stock: angular body, adjustable cheek riser, pad ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.1, 0.066],
        [-0.25, 0.066],
        [-0.27, 0.072],
        [-0.372, 0.072],
        [-0.382, 0.062],
        [-0.382, -0.055],
        [-0.367, -0.062],
        [-0.25, -0.03],
        [-0.1, 0.01],
      ],
      0.036,
      {
        bevel: 0.003,
        holes: [
          [
            [-0.16, 0.05],
            [-0.24, 0.05],
            [-0.3, 0.054],
            [-0.3, 0.0],
            [-0.24, 0.002],
            [-0.16, 0.022],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.028, 0.011, 0.14, 0.003), {
    pos: [0, 0.082, 0.3],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', new BoxGeometry(0.006, 0.01, 0.008), { pos: [0, 0.074, 0.26], paint: 0.6 });
  b.add(BODY, 'gunmetal', new BoxGeometry(0.006, 0.01, 0.008), { pos: [0, 0.074, 0.34], paint: 0.6 });
  b.add(BODY, 'accentPaint', cylinderX(0.006, 0.006, 14), {
    pos: [-0.021, 0.06, 0.3],
    paint: P.accentPaint.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.04, 0.128, 0.018, 0.004), {
    pos: [0, 0.006, 0.39],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.002, 0.12), { pos: [-0.0183, 0.045, 0.2] });

  // --- slim hexagonal handguard: swept vents (heat), lower slots, accent chamfer ---
  b.add(
    BODY,
    'gunmetal',
    profileZ(HANDGUARD, 0.3, {
      bevel: 0.0018,
      holes: [HANDGUARD.map(([x, y]) => [x * 0.74, y * 0.74] as const)],
    }),
    { pos: [0, BORE_Y, -0.35], paint: P.gunmetal.paint },
  );
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const z = -0.235 - i * 0.042;
      b.add(BODY, 'darkMetal', new BoxGeometry(0.0016, 0.019, 0.011), {
        pos: [side * 0.0242, BORE_Y + 0.001, z],
        rot: [42, 0, 0],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.015, 0.0055), {
        pos: [side * 0.0248, BORE_Y + 0.001, z],
        rot: [42, 0, 0],
      });
    }
    for (let i = 0; i < 3; i++) {
      b.add(BODY, 'bore', roundedBox(0.0012, 0.0075, 0.03, 0.0004), {
        pos: [side * 0.0182, BORE_Y - 0.0176, -0.27 - i * 0.07],
        rot: [0, 0, side * 50],
      });
    }
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0022, 0.27), {
    pos: [-0.0187, BORE_Y + 0.0195, -0.35],
    rot: [0, 0, 55],
  });
  // Underside rail section.
  b.add(BODY, 'darkMetal', new BoxGeometry(0.018, 0.005, 0.1), {
    pos: [0, BORE_Y - 0.0275, -0.43],
    paint: P.darkMetal.paint,
  });

  // --- barrel + three-prong flash hider ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0105, 0.0105, 0.52, 18), {
    pos: [0, BORE_Y, -0.46],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0105, 0],
        [0.0128, 0.003],
        [0.0128, 0.016],
        [0.0118, 0.018],
        [0.006, 0.018],
      ],
      18,
    ),
    { pos: [0, BORE_Y, -0.718], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 3; i++) {
    const a = ((90 + i * 120) * Math.PI) / 180;
    b.add(BODY, 'darkMetal', roundedBox(0.0045, 0.0045, 0.037, 0.001), {
      pos: [Math.cos(a) * 0.0088, BORE_Y + Math.sin(a) * 0.0088, MUZZLE_Z + 0.0185],
      rot: [0, 0, 90 + i * 120],
      paint: P.darkMetal.paint,
    });
  }
  b.add(BODY, 'bore', cylinderZ(0.006, 0.006, 0.001, 14), { pos: [0, BORE_Y, -0.7365] });

  // --- bolt carrier face + dust cover (right) ---
  b.add('bolt', 'gunmetal', roundedBox(0.0016, 0.012, 0.022, 0.0006), {
    pos: [0.0237, 0.0565, -0.035],
    paint: 0.5,
  });
  b.add('dustCover', 'gunmetal', roundedBox(0.0016, 0.0215, 0.064, 0.0006), {
    pos: [0.0247, 0.0567, -0.02],
    paint: P.gunmetal.paint,
  });

  // --- straight 15-round box ---
  b.add(
    'magazine',
    'polymer',
    profileX(
      [
        [0.074, 0.0],
        [0.126, 0.0],
        [0.13, -0.05],
        [0.137, -0.1],
        [0.093, -0.106],
        [0.086, -0.05],
      ],
      0.027,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  for (let i = 0; i < 2; i++) {
    b.add('magazine', 'darkMetal', new BoxGeometry(0.0282, 0.0028, 0.042), {
      pos: [0, -0.035 - i * 0.03, -(0.104 + i * 0.004)],
      rot: [5, 0, 0],
      paint: P.darkMetal.paint,
    });
  }
  b.add('magazine', 'accentPaint', roundedBox(0.031, 0.009, 0.05, 0.003), {
    pos: [0, -0.104, -0.116],
    rot: [7, 0, 0],
    paint: P.accentPaint.paint,
  });

  // --- 2.5x prism optic: mount, faceted housing, ocular, objective, fibre, counter ---
  b.add('sight', 'darkMetal', roundedBox(0.028, 0.01, 0.09, 0.002), {
    pos: [0, RAIL_TOP + 0.005, -0.06],
    paint: P.darkMetal.paint,
  });
  for (const z of [-0.035, -0.085]) {
    b.add('sight', 'accentPaint', roundedBox(0.005, 0.007, 0.012, 0.0015), {
      pos: [0.0165, RAIL_TOP + 0.004, z],
      paint: P.accentPaint.paint,
    });
  }
  b.add(
    'sight',
    'darkMetal',
    profileZ(
      [
        [0.0172, -0.0175],
        [0.0172, 0.006],
        [0.0098, 0.0182],
        [-0.0098, 0.0182],
        [-0.0172, 0.006],
        [-0.0172, -0.0175],
      ],
      0.08,
      { bevel: 0.0018 },
    ),
    { pos: [0, SIGHT_Y, -0.06], paint: P.darkMetal.paint },
  );
  // Ocular (hollow: its window is the picture) and the objective bell.
  b.add(
    'sight',
    'darkMetal',
    latheZHard(
      [
        [OCULAR_R, 0.012],
        [OCULAR_R, 0],
        [0.0163, 0],
        [0.0166, 0.003],
        [0.0156, 0.012],
        [0.0156, 0.027],
      ],
      28,
    ),
    { pos: [0, SIGHT_Y, OCULAR_REAR], paint: P.darkMetal.paint },
  );
  b.add(
    'sight',
    'darkMetal',
    latheZHard(
      [
        [0.0156, 0],
        [0.0178, 0.006],
        [0.0178, 0.024],
        [0.0164, 0.027],
        [0.0138, 0.027],
      ],
      28,
    ),
    { pos: [0, SIGHT_Y, -0.098], paint: P.darkMetal.paint },
  );
  b.add('sight', 'lens', cylinderZ(0.0139, 0.0139, 0.0003, 24), { pos: [0, SIGHT_Y, -0.1245] });
  b.add('sight', 'grip', cylinderZ(0.0136, 0.0136, 0.0003, 24), { pos: [0, SIGHT_Y, -0.118] });
  // Fibre-optic collector on top (glows with the reticle).
  b.add('sight', 'darkMetal', roundedBox(0.008, 0.005, 0.058, 0.0015), {
    pos: [0, SIGHT_Y + 0.0198, -0.06],
    paint: P.darkMetal.paint,
  });
  b.add('sight', 'sight', cylinderZ(0.0021, 0.0021, 0.052, 10), { pos: [0, SIGHT_Y + 0.0222, -0.06] });
  // Ammo counter on the left flank, angled towards the shooter.
  b.add('sight', 'readout', new PlaneGeometry(0.02, 0.0156), {
    pos: [-0.0182, SIGHT_Y - 0.002, -0.045],
    rot: [0, -65, 0],
    uv: 'keep',
  });
  // Ocular: tint, edge vignette, chevron + drop stadia, depth mask.
  b.add('sight', 'lens', cylinderZ(OCULAR_R, OCULAR_R, 0.0003, 28), {
    pos: [0, SIGHT_Y, OCULAR_REAR - 0.002],
  });
  b.add(
    'sight',
    'grip',
    latheZHard(
      [
        [OCULAR_R - 0.002, 0],
        [OCULAR_R, 0],
      ],
      28,
    ),
    { pos: [0, SIGHT_Y, RETICLE_Z + 0.0002] },
  );
  const reticle = (w: number, h: number, x: number, y: number, rotDeg = 0): void => {
    b.add('sight', 'sight', new BoxGeometry(w, h, 0.0002), {
      pos: [x, SIGHT_Y + y, RETICLE_Z],
      rot: [0, 0, rotDeg],
    });
  };
  const leg = 0.0024;
  const legAngle = 50;
  const dx = (Math.cos((legAngle * Math.PI) / 180) * leg) / 2;
  const dy = (Math.sin((legAngle * Math.PI) / 180) * leg) / 2;
  reticle(leg, 0.00034, dx, -dy, -legAngle);
  reticle(leg, 0.00034, -dx, -dy, legAngle);
  reticle(0.00018, 0.0068, 0, -0.0024 - 0.0034);
  for (let i = 0; i < 3; i++) reticle(0.0026 - i * 0.0005, 0.00018, 0, -0.0042 - i * 0.0019);
  b.add('sight', 'scopeMask', cylinderZ(OCULAR_R, OCULAR_R, 0.0002, 28), { pos: [0, SIGHT_Y, MASK_Z] });

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.026, 0.0565, -0.02], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, RETICLE_Z]);
  b.mount('optic', [0, RAIL_TOP, -0.06]);
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, BORE_Y - 0.03, -0.43]);
  b.mount('laser', [-0.0245, BORE_Y, -0.45], [0, 0, 90]);
  b.mount('stock', [0, 0.052, 0.1]);

  const built = b.build({ ...kit.materials, ...glow, scopeMask });
  for (const mesh of built.meshes) if (mesh.material === scopeMask) mesh.renderOrder = MASK_RENDER_ORDER;
  return new ProceduralWeaponModel('marksman', def, built, glow, readoutSpec, readout, [scopeMask]);
};

export const MARKSMAN_SIGHT_LINE = SIGHT_Y;
