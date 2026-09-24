/**
 * VX-9 "Sentinel" – compact sci-fi sidearm. Model content (meters, model space: origin = grip
 * pivot, barrel along −Z). Parts: slide (with rear sight, serrations, charge LEDs), hammer,
 * trigger, magazine (tilted along the grip axis). Iron sights with tritium dots: the rear notch
 * and the front post top share the sight line, so the sight socket lines both up in ADS.
 */
import { BoxGeometry } from 'three';
import { VIEWMODEL_ART, VIEWMODELS } from '../../defs/viewmodels';
import { BODY, ModelBuilder } from './ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from './materials';
import { cylinderZ, profileX, roundedBox } from './shapes';
import {
  ProceduralWeaponModel,
  createReadout,
  ledUv,
  type ReadoutSpec,
  type WeaponViewmodelModel,
} from './WeaponModel';

const P = VIEWMODEL_ART.materials;

/** Sight line height: rear post tops = front post top. */
const SIGHT_Y = 0.052;
/** Rear notch depth and how far the tritium dots sit below the sight line. */
const NOTCH_DEPTH = 0.0048;
const DOT_DROP = 0.0022;
/** Grip axis tilt (deg, top forward) and the grip's top-center pivot [y, z]. */
const GRIP_TILT = -17;
const GRIP_TOP = { y: 0, z: 0.01 } as const;
const LEDS = 3;

/** Point `s` meters down the grip axis from the grip's top center. */
function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

export function buildPistol(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = VIEWMODELS.pistol;
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.tritium, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('pistol', VIEWMODEL_ART.uvDensity);

  b.part('slide', [0, 0.028, 0]);
  b.part('hammer', [0, 0.017, 0.048]);
  b.part('trigger', [0, -0.003, -0.03]);
  b.part('magazine', [0, -0.004, 0.011], { rot: [GRIP_TILT, 0, 0] });

  // --- slide ---
  b.add(
    'slide',
    'gunmetal',
    profileX(
      [
        [-0.046, 0.011],
        [0.15, 0.011],
        [0.157, 0.018],
        [0.157, 0.034],
        [0.146, 0.045],
        [-0.036, 0.045],
        [-0.046, 0.037],
      ],
      0.027,
      {
        bevel: 0.0022,
        holes: [
          [
            [0.074, 0.019],
            [0.128, 0.019],
            [0.124, 0.031],
            [0.08, 0.031],
          ],
        ],
      },
    ),
    { paint: P.gunmetal.paint },
  );
  // Cocking serrations (slightly proud of the flanks → dark grooves).
  for (let i = 0; i < 6; i++) {
    b.add('slide', 'darkMetal', new BoxGeometry(0.0278, 0.021, 0.0017), {
      pos: [0, 0.028, 0.038 - i * 0.0048],
      paint: P.darkMetal.paint,
    });
  }
  // Ejection port with a glimpse of the chambered round.
  b.add('slide', 'bore', new BoxGeometry(0.001, 0.009, 0.03), { pos: [0.0133, 0.04, -0.02] });
  b.add('slide', 'brass', new BoxGeometry(0.0006, 0.0045, 0.014), { pos: [0.0139, 0.0402, -0.022] });
  // Accent strips along both flanks.
  for (const x of [-0.0137, 0.0137]) {
    b.add('slide', 'accent', new BoxGeometry(0.0007, 0.0018, 0.1), { pos: [x, 0.0158, -0.08] });
  }
  // Charge LEDs on the rear face (ammo fraction) in a dark bezel.
  b.add('slide', 'darkMetal', roundedBox(0.021, 0.0065, 0.0012, 0.0005), {
    pos: [0, 0.028, 0.0462],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < LEDS; i++) {
    b.add('slide', 'readout', new BoxGeometry(0.0038, 0.0034, 0.0012), {
      pos: [-0.007 + i * 0.007, 0.028, 0.0468],
      uv: ledUv(i, LEDS),
    });
  }
  // Three-dot iron sights: the rear post tops and the front post top lie on the sight line,
  // the notch floor sits NOTCH_DEPTH below it, so the front post fills the notch in ADS.
  const notchFloor = SIGHT_Y - NOTCH_DEPTH;
  const dotY = SIGHT_Y - DOT_DROP;
  b.add('slide', 'darkMetal', roundedBox(0.022, notchFloor - 0.045, 0.008, 0.0008), {
    pos: [0, (notchFloor + 0.045) / 2, 0.03],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.00575, 0.00575]) {
    b.add('slide', 'darkMetal', roundedBox(0.0065, NOTCH_DEPTH, 0.008, 0.0006), {
      pos: [x, notchFloor + NOTCH_DEPTH / 2, 0.03],
      paint: P.darkMetal.paint,
    });
    b.add('slide', 'sight', new BoxGeometry(0.0021, 0.0021, 0.0006), { pos: [x, dotY, 0.0343] });
  }
  b.add('slide', 'darkMetal', new BoxGeometry(0.0034, SIGHT_Y - 0.0445, 0.005), {
    pos: [0, (SIGHT_Y + 0.0445) / 2, -0.14],
    paint: P.darkMetal.paint,
  });
  b.add('slide', 'sight', new BoxGeometry(0.0021, 0.0021, 0.0006), { pos: [0, dotY, -0.1372] });

  // --- barrel (visible through the slide window and at the muzzle) ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0066, 0.0066, 0.17, 18), {
    pos: [0, 0.026, -0.07],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', cylinderZ(0.0069, 0.0069, 0.0012, 20), { pos: [0, 0.026, -0.1576] });
  b.add(BODY, 'bore', cylinderZ(0.0044, 0.0044, 0.0014, 16), { pos: [0, 0.026, -0.1584] });
  // Barrel section behind the slide window: glows with heat during rapid fire.
  b.add(BODY, 'heat', cylinderZ(0.0068, 0.0068, 0.05, 18), { pos: [0, 0.026, -0.101] });

  // --- frame ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.05, 0.004],
        [0.128, 0.0],
        [0.138, 0.004],
        [0.141, 0.0115],
        [-0.05, 0.0115],
      ],
      0.025,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  // Accessory rail under the dust cover.
  b.add(BODY, 'polymer', roundedBox(0.016, 0.006, 0.058, 0.0015), {
    pos: [0, -0.002, -0.104],
    paint: P.polymer.paint,
  });
  for (let i = 0; i < 4; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.0166, 0.0024, 0.003), {
      pos: [0, -0.0035, -0.082 - i * 0.014],
      paint: P.darkMetal.paint,
    });
  }
  // Slide stop lever (left) and takedown pin (right).
  b.add(BODY, 'darkMetal', roundedBox(0.0024, 0.0045, 0.02, 0.0008), {
    pos: [-0.0132, 0.0085, -0.028],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accentPaint', roundedBox(0.0022, 0.004, 0.006, 0.0008), {
    pos: [0.0131, 0.0075, -0.06],
    paint: P.accentPaint.paint,
  });

  // --- grip (tilted), knurled panels, beavertail ---
  b.add(BODY, 'polymer', roundedBox(0.029, 0.116, 0.044, 0.007, 3), {
    pos: gripAxis(0.054),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0316, 0.08, 0.036, 0.004), {
    pos: gripAxis(0.056),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'polymer', roundedBox(0.024, 0.006, 0.026, 0.0025), {
    pos: [0, 0.0085, 0.05],
    rot: [10, 0, 0],
    paint: P.polymer.paint,
  });

  // --- trigger guard + trigger ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.002],
        [0.058, -0.001],
        [0.058, -0.02],
        [0.05, -0.034],
        [0.004, -0.036],
        [-0.002, -0.028],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.012, -0.005],
            [0.052, -0.006],
            [0.052, -0.018],
            [0.046, -0.029],
            [0.014, -0.03],
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
        [0.028, -0.003],
        [0.034, -0.003],
        [0.035, -0.012],
        [0.032, -0.022],
        [0.027, -0.025],
        [0.029, -0.015],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

  // --- hammer (rest = cocked, leaning back) ---
  b.add(
    'hammer',
    'darkMetal',
    profileX(
      [
        [-0.046, 0.013],
        [-0.051, 0.013],
        [-0.057, 0.031],
        [-0.061, 0.034],
        [-0.057, 0.036],
        [-0.05, 0.028],
      ],
      0.008,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

  // --- magazine (local frame: −Y runs down the grip axis) ---
  b.add('magazine', 'darkMetal', new BoxGeometry(0.021, 0.104, 0.032), {
    local: true,
    pos: [0, -0.052, 0],
    paint: P.darkMetal.paint,
  });
  b.add('magazine', 'polymer', roundedBox(0.031, 0.009, 0.048, 0.003), {
    local: true,
    pos: [0, -0.1135, 0.001],
    paint: P.polymer.paint,
  });
  b.add('magazine', 'accentPaint', roundedBox(0.0316, 0.0045, 0.006, 0.0012), {
    local: true,
    pos: [0, -0.113, -0.021],
    paint: P.accentPaint.paint,
  });

  // --- sockets ---
  b.socket('muzzle', [0, 0.026, -0.159]);
  b.socket('ejectPort', [0.015, 0.041, -0.02], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, 0.0343]);
  // Attachment mounts (M5): the optic rides the slide (cut in front of the rear sight), the laser
  // hangs under the frame's accessory rail (+Y out of the rail surface, i.e. down).
  b.mount('optic', [0, 0.045, 0.004], undefined, 'slide');
  b.mount('muzzleDevice', [0, 0.026, -0.1584]);
  b.mount('laser', [0, -0.005, -0.104], [0, 0, 180]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('pistol', def, built, glow, readoutSpec, readout);
}

/** Exposed for tests: the sight line height the model was built with. */
export const PISTOL_SIGHT_LINE = SIGHT_Y;
