/**
 * HX-50 „Richtfeuer“ – bolt-action anti-materiel rifle. Model content (meters, model space: origin =
 * grip pivot, barrel along −Z). Round action in a skeleton chassis, a long fluted barrel whose flutes
 * glow with heat, a two-chamber brake, a bipod folded under the handguard and a rear monopod.
 * Parts: bolt (runs back out of the receiver) with its handle (child, lifts around the bolt axis),
 * 5-round magazine, trigger, and the scope (`sight`).
 *
 * The scope is a real sighting device: the ADS eye sits right behind the eyecup so the ocular fills
 * the view. A depth-only disk just in front of the glowing reticle (drawn first) hides the scope's
 * own interior and the gun behind it, so the ocular is a clean window onto the (zoomed) world.
 */
import { BoxGeometry, CylinderGeometry, MeshBasicMaterial, SphereGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { SNIPER_VIEWMODEL } from '../../../defs/viewmodelData/sniper';
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
  tubeZ,
} from '../shapes';
import { ProceduralWeaponModel, createReadout, ledUv, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

/** Bore = receiver axis. */
const BORE_Y = 0.058;
const RECV_R = 0.0185;
const RAIL_TOP = 0.0865;
/** Scope axis (sight line). */
const SIGHT_Y = 0.121;
/** Rear face of the eyecup; scope stations are measured forward from here. */
const SCOPE_REAR = 0.052;
/** Reticle plane (sight socket) and the depth mask just in front of it. */
const RETICLE_F = 0.014;
const MASK_F = 0.0165;
/** Inner radius of the ocular (the window onto the world). */
const OCULAR_R = 0.0206;
const GRIP_TILT = -12;
const MUZZLE_Z = -0.942;
/** One LED per round, capped. */
const MAX_LEDS = 6;
const DEFAULT_LEDS = 5;
/** Drawn before every other viewmodel mesh (depth only). */
const MASK_RENDER_ORDER = -1;

const grip = (s: number): [number, number, number] => tiltedAxisPoint(GRIP_TILT, 0.002, 0.012, s);
const sz = (f: number): number => SCOPE_REAR - f;

export const buildSniper: ViewmodelBuilder = (kit) => {
  const def = SNIPER_VIEWMODEL;
  const leds = Math.max(1, Math.min(MAX_LEDS, getWeaponDef('sniper')?.magazine ?? DEFAULT_LEDS));
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: leds };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.redDot, readout?.texture ?? null, def.glow);
  const scopeMask = new MeshBasicMaterial({ name: 'vm-scopemask', colorWrite: false });
  const b = new ModelBuilder('sniper', VIEWMODEL_ART.uvDensity);

  b.part('bolt', [0, BORE_Y, 0.06]);
  b.part('boltHandle', [0, BORE_Y, 0.062], { parent: 'bolt' });
  b.part('trigger', [0, 0.0, -0.032]);
  b.part('magazine', [0, 0.0, -0.105]);
  b.part('sight', [0, RAIL_TOP, -0.12]);

  // --- round action with chamfered ends, ejection port, rail ---
  b.add(
    BODY,
    'gunmetal',
    latheZHard(
      [
        [0, 0],
        [RECV_R - 0.002, 0],
        [RECV_R, 0.002],
        [RECV_R, 0.238],
        [RECV_R - 0.002, 0.24],
        [0, 0.24],
      ],
      24,
    ),
    { pos: [0, BORE_Y, 0.075], paint: P.gunmetal.paint },
  );
  b.add(BODY, 'bore', new BoxGeometry(0.004, 0.015, 0.072), { pos: [0.0172, BORE_Y + 0.002, -0.05] });
  // Handle notch at the rear right.
  b.add(BODY, 'bore', new BoxGeometry(0.004, 0.01, 0.014), { pos: [0.0172, BORE_Y - 0.006, 0.066] });
  b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.008, 0.52), {
    pos: [0, RAIL_TOP - 0.0085, -0.19],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 40; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.0035, 0.0062), {
      pos: [0, RAIL_TOP - 0.00175, 0.064 - i * 0.0128],
      paint: P.darkMetal.paint,
    });
  }

  // --- chassis: lower body + magwell, LED bezel, accent strip ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.112, 0.052],
        [0.172, 0.052],
        [0.172, 0.012],
        [0.145, 0.004],
        [0.142, -0.03],
        [0.07, -0.03],
        [0.068, 0.0],
        [-0.03, 0.0],
        [-0.112, 0.016],
      ],
      0.05,
      { bevel: 0.003 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.0016, 0.009, leds * 0.012 + 0.006, 0.0005), {
    pos: [-0.0254, 0.037, -0.1 - ((leds - 1) * 0.012) / 2],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < leds; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0012, 0.0045, 0.0072), {
      pos: [-0.0262, 0.037, -0.1 - i * 0.012],
      uv: ledUv(i, leds),
    });
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.24), { pos: [-0.0254, 0.047, -0.03] });
  // Trigger guard + trigger.
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.002],
        [0.068, 0.002],
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
            [0.01, -0.004],
            [0.062, -0.004],
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
  b.add(BODY, 'accentPaint', roundedBox(0.003, 0.008, 0.012, 0.001), {
    pos: [0.026, 0.012, -0.072],
    paint: P.accentPaint.paint,
  });

  // --- precision grip with a thumb shelf ---
  b.add(BODY, 'polymer', roundedBox(0.032, 0.112, 0.045, 0.008, 3), {
    pos: grip(0.052),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0342, 0.076, 0.037, 0.004), {
    pos: grip(0.058),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'polymer', roundedBox(0.012, 0.008, 0.03, 0.003), {
    pos: [-0.02, -0.012, 0.03],
    paint: P.polymer.paint,
  });

  // --- skeleton stock, adjustable cheek riser, butt pad, rear monopod ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        // Low wrist behind the action: the bolt runs back over it.
        [-0.105, 0.04],
        [-0.212, 0.04],
        [-0.238, 0.078],
        [-0.395, 0.078],
        [-0.405, 0.066],
        [-0.405, -0.062],
        [-0.39, -0.068],
        [-0.25, -0.04],
        [-0.105, 0.012],
      ],
      0.04,
      {
        bevel: 0.003,
        holes: [
          [
            [-0.262, 0.062],
            [-0.362, 0.062],
            [-0.362, -0.036],
            [-0.3, -0.024],
            [-0.262, -0.008],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.012, 0.15, 0.003), {
    pos: [0, 0.089, 0.315],
    paint: P.darkMetal.paint,
  });
  for (const z of [0.265, 0.365]) {
    b.add(BODY, 'gunmetal', cylinderZ(0.0035, 0.0035, 0.008, 10), { pos: [0, 0.08, z], rot: [90, 0, 0] });
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.002, 0.14), { pos: [-0.0203, 0.068, 0.32] });
  b.add(BODY, 'grip', roundedBox(0.046, 0.146, 0.022, 0.005), {
    pos: [0, 0.006, 0.415],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'darkMetal', new CylinderGeometry(0.0055, 0.0055, 0.05, 12), {
    pos: [0, -0.07, 0.33],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'grip', new CylinderGeometry(0.009, 0.0075, 0.012, 14), { pos: [0, -0.1, 0.33] });

  // --- free-float handguard, folded bipod ---
  b.add(
    BODY,
    'darkMetal',
    profileZ(chamferRectProfile(0.05, 0.05, 0.013, 0.013), 0.3, {
      bevel: 0.002,
      holes: [chamferRectProfile(0.036, 0.036, 0.009)],
    }),
    { pos: [0, BORE_Y, -0.32], paint: P.darkMetal.paint },
  );
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      b.add(BODY, 'bore', roundedBox(0.0012, 0.01, 0.045, 0.0005), {
        pos: [side * 0.0252, BORE_Y, -0.215 - i * 0.062],
      });
    }
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0022, 0.26), {
    pos: [-0.0205, BORE_Y + 0.0205, -0.32],
    rot: [0, 0, 45],
  });
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.012, 0.03, 0.003), {
    pos: [0, BORE_Y - 0.029, -0.44],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.011, 0.011]) {
    b.add(BODY, 'gunmetal', cylinderZ(0.0045, 0.0045, 0.22, 10), {
      pos: [x, BORE_Y - 0.036, -0.56],
      paint: 0.55,
    });
    b.add(BODY, 'grip', roundedBox(0.012, 0.009, 0.02, 0.003), { pos: [x, BORE_Y - 0.036, -0.675] });
  }

  // --- fluted barrel (flutes glow with heat), two-chamber brake ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0135, 0.0135, 0.7, 20), {
    pos: [0, BORE_Y, -0.52],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 6; i++) {
    const a = (i * 60 + 30) * (Math.PI / 180);
    const x = Math.cos(a) * 0.0128;
    const y = BORE_Y + Math.sin(a) * 0.0128;
    b.add(BODY, 'bore', new BoxGeometry(0.0024, 0.0036, 0.3), {
      pos: [x, y, -0.65],
      rot: [0, 0, i * 60 + 30],
    });
    b.add(BODY, 'heat', new BoxGeometry(0.0022, 0.0014, 0.29), {
      pos: [x * 1.02, BORE_Y + (y - BORE_Y) * 1.02, -0.65],
      rot: [0, 0, i * 60 + 30],
    });
  }
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0135, 0],
        [0.021, 0.004],
        [0.021, 0.074],
        [0.018, 0.08],
        [0.007, 0.08],
      ],
      24,
    ),
    { pos: [0, BORE_Y, -0.862], paint: P.darkMetal.paint },
  );
  for (const z of [-0.884, -0.918]) {
    b.add(BODY, 'bore', new BoxGeometry(0.0432, 0.022, 0.02), { pos: [0, BORE_Y, z] });
    b.add(BODY, 'heat', new BoxGeometry(0.036, 0.016, 0.002), { pos: [0, BORE_Y, z + 0.009] });
  }
  b.add(BODY, 'bore', new BoxGeometry(0.008, 0.043, 0.05), { pos: [0, BORE_Y + 0.005, -0.9] });
  b.add(BODY, 'bore', cylinderZ(0.0072, 0.0072, 0.0012, 16), { pos: [0, BORE_Y, MUZZLE_Z + 0.0005] });

  // --- bolt: body + shroud (runs back out of the action) ---
  b.add('bolt', 'darkMetal', cylinderZ(0.0105, 0.0105, 0.17, 18), {
    pos: [0, BORE_Y, -0.005],
    paint: 0.55,
  });
  b.add(
    'bolt',
    'darkMetal',
    latheZHard(
      [
        [0.0, 0.0],
        [0.011, 0.0],
        [0.0145, 0.006],
        [0.0145, 0.024],
        [0.0125, 0.026],
      ],
      18,
    ),
    { pos: [0, BORE_Y, 0.1], paint: P.darkMetal.paint },
  );
  // Handle: arm + knurled tactical knob, resting down-right in its notch.
  b.add('boltHandle', 'darkMetal', cylinderX(0.0042, 0.042, 10), {
    pos: [0.029, BORE_Y - 0.0105, 0.064],
    rot: [0, 0, -20],
    paint: P.darkMetal.paint,
  });
  b.add('boltHandle', 'grip', cylinderX(0.0105, 0.022, 16), {
    pos: [0.052, BORE_Y - 0.019, 0.064],
    rot: [0, 0, -20],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add('boltHandle', 'darkMetal', new SphereGeometry(0.0106, 14, 10), {
    pos: [0.0623, BORE_Y - 0.0228, 0.064],
    paint: P.darkMetal.paint,
  });

  // --- 5-round box ---
  b.add(
    'magazine',
    'polymer',
    profileX(
      [
        [0.073, 0.0],
        [0.139, 0.0],
        [0.141, -0.05],
        [0.07, -0.05],
      ],
      0.031,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  b.add('magazine', 'darkMetal', new BoxGeometry(0.0322, 0.003, 0.064), {
    pos: [0, -0.025, -0.106],
    paint: P.darkMetal.paint,
  });
  b.add('magazine', 'accentPaint', roundedBox(0.035, 0.009, 0.074, 0.003), {
    pos: [0, -0.052, -0.106],
    paint: P.accentPaint.paint,
  });

  // --- scope: rings, eyecup, ocular, tube, turrets, objective ---
  for (const f of [0.107, 0.252]) {
    b.add('sight', 'darkMetal', tubeZ(0.0192, 0.0156, 0.016, 24), {
      pos: [0, SIGHT_Y, sz(f) + 0.008],
      paint: P.darkMetal.paint,
    });
    b.add('sight', 'darkMetal', roundedBox(0.022, SIGHT_Y - 0.0185 - RAIL_TOP, 0.016, 0.002), {
      pos: [0, (SIGHT_Y - 0.0185 + RAIL_TOP) / 2, sz(f)],
      paint: P.darkMetal.paint,
    });
    b.add('sight', 'darkMetal', cylinderX(0.0028, 0.03, 8), { pos: [0, RAIL_TOP + 0.004, sz(f)] });
  }
  // Rubber eyecup (its rear face and inner wall frame the picture).
  b.add(
    'sight',
    'grip',
    latheZHard(
      [
        [OCULAR_R, 0.02],
        [OCULAR_R, 0.002],
        [OCULAR_R + 0.002, 0],
        [0.0258, 0],
        [0.0262, 0.004],
        [0.0262, 0.02],
        [OCULAR_R, 0.02],
      ],
      32,
    ),
    { pos: [0, SIGHT_Y, SCOPE_REAR], uvDensity: VIEWMODEL_ART.knurlDensity },
  );
  b.add(
    'sight',
    'darkMetal',
    latheZHard(
      [
        [0.0245, 0.02],
        [0.0245, 0.058],
        [0.0215, 0.068],
        [0.0158, 0.09],
        [0.0158, 0.3],
        [0.0262, 0.342],
        [0.0262, 0.394],
        [0.0246, 0.4],
        [0.0215, 0.4],
      ],
      32,
    ),
    { pos: [0, SIGHT_Y, SCOPE_REAR], paint: P.darkMetal.paint },
  );
  b.add('sight', 'accent', latheZHard([[0.0264, 0.36], [0.0264, 0.364]], 32), {
    pos: [0, SIGHT_Y, SCOPE_REAR],
  });
  b.add('sight', 'lens', cylinderZ(0.0215, 0.0215, 0.0004, 24), { pos: [0, SIGHT_Y, sz(0.398)] });
  b.add('sight', 'grip', cylinderZ(0.0212, 0.0212, 0.0004, 24), { pos: [0, SIGHT_Y, sz(0.388)] });
  // Elevation turret (top), windage (right), illuminated parallax knob (left, facing the shooter).
  const turretZ = sz(0.185);
  b.add('sight', 'darkMetal', new CylinderGeometry(0.0118, 0.0125, 0.016, 20), {
    pos: [0, SIGHT_Y + 0.0215, turretZ],
    paint: P.darkMetal.paint,
  });
  b.add('sight', 'grip', new CylinderGeometry(0.0132, 0.0132, 0.011, 24), {
    pos: [0, SIGHT_Y + 0.0345, turretZ],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add('sight', 'accent', new CylinderGeometry(0.0134, 0.0134, 0.0016, 24), {
    pos: [0, SIGHT_Y + 0.0292, turretZ],
  });
  b.add('sight', 'darkMetal', cylinderX(0.0105, 0.014, 18), {
    pos: [0.021, SIGHT_Y, turretZ],
    paint: P.darkMetal.paint,
  });
  b.add('sight', 'grip', cylinderX(0.0115, 0.009, 20), {
    pos: [0.031, SIGHT_Y, turretZ],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add('sight', 'darkMetal', cylinderX(0.0145, 0.012, 24), {
    pos: [-0.021, SIGHT_Y, turretZ],
    paint: P.darkMetal.paint,
  });
  b.add('sight', 'accent', cylinderX(0.0148, 0.0018, 24), { pos: [-0.0265, SIGHT_Y, turretZ] });
  b.add('sight', 'grip', cylinderX(0.0125, 0.004, 24), { pos: [-0.029, SIGHT_Y, turretZ] });

  // Ocular: lens tint, black edge vignette, reticle, then the depth mask (drawn first).
  b.add('sight', 'lens', cylinderZ(OCULAR_R, OCULAR_R, 0.0003, 32), { pos: [0, SIGHT_Y, sz(0.011)] });
  b.add('sight', 'grip', tubeZ(OCULAR_R, OCULAR_R - 0.0028, 0.0004, 32), {
    pos: [0, SIGHT_Y, sz(RETICLE_F - 0.0002)],
  });
  const rz = sz(RETICLE_F);
  const reticle = (w: number, h: number, x: number, y: number): void => {
    b.add('sight', 'sight', new BoxGeometry(w, h, 0.0002), { pos: [x, SIGHT_Y + y, rz] });
  };
  const fine = 0.00016;
  const post = 0.0007;
  const inner = 0.0062;
  const edge = OCULAR_R - 0.0026;
  reticle(inner * 2, fine, 0, 0);
  reticle(fine, inner * 2, 0, 0);
  for (const s of [-1, 1]) {
    reticle(edge - inner, post, s * (inner + edge) / 2, 0);
    reticle(post, edge - inner, 0, s * (inner + edge) / 2);
  }
  // Holdover chevrons below the center.
  for (let i = 1; i <= 3; i++) reticle(0.0014 - i * 0.0002, fine * 1.3, 0, -i * 0.0014);
  b.add('sight', 'sight', cylinderZ(0.00042, 0.00042, 0.0002, 12), { pos: [0, SIGHT_Y, rz + 0.0001] });
  b.add('sight', 'scopeMask', cylinderZ(OCULAR_R, OCULAR_R, 0.0002, 32), { pos: [0, SIGHT_Y, sz(MASK_F)] });

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.02, BORE_Y + 0.002, -0.05], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, rz]);
  b.mount('optic', [0, RAIL_TOP, -0.12]);
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, BORE_Y - 0.025, -0.34]);
  b.mount('laser', [-0.025, BORE_Y, -0.43], [0, 0, 90]);
  b.mount('stock', [0, 0.05, 0.11]);

  const built = b.build({ ...kit.materials, ...glow, scopeMask });
  for (const mesh of built.meshes) if (mesh.material === scopeMask) mesh.renderOrder = MASK_RENDER_ORDER;
  return new ProceduralWeaponModel('sniper', def, built, glow, readoutSpec, readout, [scopeMask]);
};

export const SNIPER_SIGHT_LINE = SIGHT_Y;
