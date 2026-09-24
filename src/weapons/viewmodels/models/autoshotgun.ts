/**
 * AS-20 „Mahlstrom“ – drum-fed automatic shotgun. Model content (meters, model space: origin = grip
 * pivot, barrel along −Z). Boxy receiver in line with a skeleton stock that shows the recoil spring,
 * a perforated barrel shroud whose slots glow with heat, a flared brake and a mini reflex sight with a
 * pellet-ring reticle. Parts: magazine (the heavy 16-round drum; its left face carries a ring of shell
 * LEDs and a window) with the rotor (`drum`, child) that turns one chamber per shot behind the glass,
 * bolt face in the right port, charging handle (left, racked on empty reloads), trigger, sight.
 */
import { BoxGeometry, PlaneGeometry, TorusGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { AUTOSHOTGUN_VIEWMODEL } from '../../../defs/viewmodelData/autoshotgun';
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

const BARREL_Y = 0.058;
const RAIL_TOP = 0.0955;
const SIGHT_Y = 0.1135;
const SIGHT_REAR = -0.024;
const SIGHT_FRONT = -0.05;
const GRIP_TILT = -18;
const MUZZLE_Z = -0.546;
/** Drum: axis along X under the magwell. */
const DRUM_C: readonly [number, number, number] = [0, -0.07, -0.098];
const DRUM_R = 0.062;
const DRUM_W = 0.056;
const WINDOW_R = 0.038;
const LEDS = 8;
const ROTOR_BLADES = 16;
/** Swirl of the rotor blades off the radial direction (deg). */
const BLADE_SWIRL = 24;
const SHROUD_R = 0.0215;

const grip = (s: number): [number, number, number] => tiltedAxisPoint(GRIP_TILT, 0.004, 0.012, s);

export const buildAutoshotgun: ViewmodelBuilder = (kit) => {
  const def = AUTOSHOTGUN_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.tritium, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('autoshotgun', VIEWMODEL_ART.uvDensity);
  const [cx, cy, cz] = DRUM_C;
  const faceX = cx - DRUM_W / 2;

  b.part('bolt', [0.028, 0.06, -0.05]);
  b.part('chargingHandle', [-0.029, 0.071, -0.125]);
  b.part('trigger', [0, 0.004, -0.034]);
  b.part('magazine', [0, 0.012, -0.098]);
  b.part('drum', [cx, cy, cz], { parent: 'magazine' });
  b.part('sight', [0, RAIL_TOP, -0.036]);

  // --- receiver: tall box with ribbed flanks, ports, rail ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.056, 0.072, 0.012, 0.006), 0.3, { bevel: 0.0025 }), {
    pos: [0, 0.05, -0.055],
    paint: P.gunmetal.paint,
  });
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.add(BODY, 'darkMetal', roundedBox(0.0022, 0.005, 0.2, 0.0009), {
        pos: [side * 0.0282, 0.028 + i * 0.009, -0.03],
        paint: P.darkMetal.paint,
      });
    }
  }
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.02, 0.066), { pos: [0.0281, 0.06, -0.05] });
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.007, 0.11), { pos: [-0.0281, 0.071, -0.14] });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [-0.0284, 0.058, -0.03] });
  b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.006, 0.23), {
    pos: [0, RAIL_TOP - 0.0065, -0.09],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 18; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.026, 0.0035, 0.0062), {
      pos: [0, RAIL_TOP - 0.00175, 0.018 - i * 0.0128],
      paint: P.darkMetal.paint,
    });
  }
  // Lower frame + magwell lip, trigger guard, trigger.
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.095, 0.02],
        [0.2, 0.02],
        [0.2, 0.006],
        [0.14, 0.004],
        [0.136, -0.012],
        [0.06, -0.012],
        [0.058, 0.0],
        [-0.03, 0.0],
        [-0.095, 0.01],
      ],
      0.05,
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
        [0.056, 0.002],
        [0.056, -0.024],
        [0.048, -0.032],
        [0.006, -0.032],
        [-0.004, -0.022],
      ],
      0.013,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.008, -0.004],
            [0.05, -0.004],
            [0.05, -0.021],
            [0.044, -0.027],
            [0.01, -0.027],
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
  b.add(BODY, 'accentPaint', roundedBox(0.012, 0.004, 0.012, 0.001), {
    pos: [0, -0.012, -0.146],
    paint: P.accentPaint.paint,
  });

  // --- grip ---
  b.add(BODY, 'polymer', roundedBox(0.032, 0.108, 0.045, 0.007, 3), {
    pos: grip(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0342, 0.072, 0.037, 0.004), {
    pos: grip(0.056),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- in-line skeleton stock with the recoil spring inside ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.095, 0.086],
        [-0.33, 0.082],
        [-0.34, 0.07],
        [-0.34, -0.048],
        [-0.325, -0.056],
        [-0.2, -0.02],
        [-0.095, 0.012],
      ],
      0.042,
      {
        bevel: 0.003,
        holes: [
          [
            [-0.13, 0.07],
            [-0.3, 0.068],
            [-0.3, -0.002],
            [-0.2, 0.012],
            [-0.13, 0.028],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'gunmetal', cylinderZ(0.0035, 0.0035, 0.17, 10), { pos: [0, 0.048, 0.215], paint: 0.6 });
  for (let i = 0; i < 11; i++) {
    b.add(BODY, 'gunmetal', new TorusGeometry(0.0095, 0.0016, 6, 16), {
      pos: [0, 0.048, 0.14 + i * 0.015],
      rot: [0, 8, 0],
      paint: 0.7,
    });
  }
  b.add(BODY, 'grip', roundedBox(0.046, 0.132, 0.02, 0.005), {
    pos: [0, 0.015, 0.35],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0022, 0.17), { pos: [-0.0213, 0.077, 0.215] });

  // --- perforated barrel shroud (slots glow with heat), handguard, flared brake ---
  b.add(BODY, 'darkMetal', cylinderZ(0.012, 0.012, 0.33, 18), { pos: [0, BARREL_Y, -0.37], paint: 0.55 });
  b.add(BODY, 'gunmetal', tubeZ(SHROUD_R, SHROUD_R - 0.003, 0.27, 24), {
    pos: [0, BARREL_Y, -0.19],
    paint: P.gunmetal.paint,
  });
  for (const side of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const a = (90 - side * 42) * (Math.PI / 180);
      const x = Math.cos(a) * SHROUD_R;
      const y = BARREL_Y + Math.sin(a) * SHROUD_R;
      const z = -0.225 - i * 0.04;
      b.add(BODY, 'bore', roundedBox(0.0014, 0.0075, 0.026, 0.0006), {
        pos: [x, y, z],
        rot: [0, 0, 90 - side * 42],
      });
      b.add(BODY, 'heat', roundedBox(0.0014, 0.0045, 0.021, 0.0005), {
        pos: [x * 1.02, BARREL_Y + (y - BARREL_Y) * 1.02, z],
        rot: [0, 0, 90 - side * 42],
      });
    }
  }
  b.add(
    BODY,
    'polymer',
    profileZ(
      [
        [0.026, 0.05],
        [0.026, 0.034],
        [0.02, 0.025],
        [-0.02, 0.025],
        [-0.026, 0.034],
        [-0.026, 0.05],
        [-0.019, 0.05],
        [-0.019, 0.036],
        [0.019, 0.036],
        [0.019, 0.05],
      ],
      0.2,
      { bevel: 0.002 },
    ),
    { pos: [0, 0, -0.3], paint: P.polymer.paint },
  );
  for (const side of [-1, 1]) {
    b.add(BODY, 'grip', roundedBox(0.002, 0.013, 0.13, 0.001), {
      pos: [side * 0.0262, 0.038, -0.3],
      uvDensity: VIEWMODEL_ART.knurlDensity,
    });
  }
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0016, 0.17), { pos: [-0.0266, 0.0475, -0.3] });
  b.add(BODY, 'darkMetal', new BoxGeometry(0.018, 0.005, 0.09), {
    pos: [0, 0.0225, -0.33],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.012, 0],
        [0.019, 0.004],
        [0.021, 0.03],
        [0.0245, 0.04],
        [0.0215, 0.046],
        [0.0115, 0.046],
      ],
      24,
    ),
    { pos: [0, BARREL_Y, MUZZLE_Z + 0.046], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 4; i++) {
    b.add(BODY, 'bore', new BoxGeometry(0.004, 0.049, 0.018), {
      pos: [0, BARREL_Y, MUZZLE_Z + 0.024],
      rot: [0, 0, 45 * i],
    });
  }
  b.add(BODY, 'bore', cylinderZ(0.0112, 0.0112, 0.001, 18), { pos: [0, BARREL_Y, MUZZLE_Z + 0.0006] });

  // --- charging handle (left) + bolt face (right port) ---
  b.add('chargingHandle', 'darkMetal', cylinderX(0.0034, 0.016, 10), {
    pos: [-0.036, 0.071, -0.125],
    paint: P.darkMetal.paint,
  });
  b.add('chargingHandle', 'accentPaint', roundedBox(0.011, 0.014, 0.016, 0.003), {
    pos: [-0.047, 0.071, -0.125],
    paint: P.accentPaint.paint,
  });
  b.add('bolt', 'gunmetal', roundedBox(0.0018, 0.015, 0.03, 0.0006), {
    pos: [0.0278, 0.06, -0.05],
    paint: 0.5,
  });

  // --- drum magazine: feed tower, body (axis X), rims, left face with LED ring + window ---
  b.add('magazine', 'polymer', roundedBox(0.032, 0.034, 0.062, 0.004), {
    pos: [0, -0.004, -0.098],
    paint: P.polymer.paint,
  });
  b.add(
    'magazine',
    'polymer',
    latheZHard(
      [
        [0, 0],
        [DRUM_R - 0.004, 0],
        [DRUM_R, 0.004],
        [DRUM_R, DRUM_W - 0.004],
        [DRUM_R - 0.004, DRUM_W],
        [WINDOW_R, DRUM_W],
        [WINDOW_R, DRUM_W - 0.006],
        [0, DRUM_W - 0.006],
      ],
      40,
    ),
    { pos: [cx + DRUM_W / 2, cy, cz], rot: [0, 90, 0], paint: P.polymer.paint },
  );
  for (const x of [cx - DRUM_W / 2 + 0.008, cx + DRUM_W / 2 - 0.008]) {
    b.add(
      'magazine',
      'darkMetal',
      latheZHard(
        [
          [DRUM_R + 0.0012, 0],
          [DRUM_R + 0.0012, 0.005],
        ],
        40,
      ),
      {
        pos: [x + 0.0025, cy, cz],
        rot: [0, 90, 0],
        paint: P.darkMetal.paint,
      },
    );
  }
  // Bezel ring of the window + LED ring (a gauge draining around the face).
  b.add('magazine', 'darkMetal', tubeZ(WINDOW_R + 0.0035, WINDOW_R, 0.0016, 40), {
    pos: [faceX, cy, cz],
    rot: [0, 90, 0],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < LEDS; i++) {
    const a = 90 - (i * 360) / LEDS;
    const r = (WINDOW_R + DRUM_R) / 2 + 0.002;
    const ar = (a * Math.PI) / 180;
    b.add('magazine', 'readout', new BoxGeometry(0.0012, 0.0055, 0.0095), {
      pos: [faceX - 0.0006, cy + Math.sin(ar) * r, cz + Math.cos(ar) * r],
      rot: [90 - a, 0, 0],
      uv: ledUv(i, LEDS),
    });
  }
  b.add('magazine', 'lens', cylinderX(WINDOW_R, 0.0004, 40), { pos: [faceX + 0.0012, cy, cz] });

  // --- rotor behind the window: 16 swirl blades around a glowing hub ---
  const plateX = faceX + 0.006;
  for (let i = 0; i < ROTOR_BLADES; i++) {
    const a = (i * 360) / ROTOR_BLADES;
    const ar = (a * Math.PI) / 180;
    const r = 0.022;
    b.add('drum', 'gunmetal', new BoxGeometry(0.0016, 0.028, 0.0034), {
      pos: [plateX - 0.0012, cy + Math.sin(ar) * r, cz + Math.cos(ar) * r],
      rot: [90 - a + BLADE_SWIRL, 0, 0],
      paint: 0.75,
    });
  }
  b.add('drum', 'darkMetal', cylinderX(0.0105, 0.003, 20), { pos: [plateX - 0.0018, cy, cz], paint: 0.4 });
  b.add('drum', 'accent', cylinderX(0.0068, 0.0012, 20), { pos: [plateX - 0.0036, cy, cz] });

  // --- mini reflex sight with a pellet-ring reticle ---
  b.add('sight', 'darkMetal', roundedBox(0.03, 0.007, 0.042, 0.002), {
    pos: [0, RAIL_TOP + 0.0035, -0.036],
    paint: P.darkMetal.paint,
  });
  b.add(
    'sight',
    'gunmetal',
    profileZ(chamferRectProfile(0.033, 0.026, 0.007, 0.002), SIGHT_REAR - SIGHT_FRONT, {
      bevel: 0.0012,
      holes: [chamferRectProfile(0.026, 0.019, 0.005, 0.001)],
    }),
    { pos: [0, SIGHT_Y, (SIGHT_REAR + SIGHT_FRONT) / 2], paint: P.gunmetal.paint },
  );
  b.add('sight', 'lens', new PlaneGeometry(0.026, 0.019), {
    pos: [0, SIGHT_Y, SIGHT_FRONT + 0.0015],
    uv: 'keep',
  });
  const rz = SIGHT_FRONT + 0.002;
  b.add('sight', 'sight', cylinderZ(0.0006, 0.0006, 0.0003, 10), { pos: [0, SIGHT_Y, rz] });
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    b.add('sight', 'sight', cylinderZ(0.00042, 0.00042, 0.0003, 8), {
      pos: [Math.cos(a) * 0.0046, SIGHT_Y + Math.sin(a) * 0.0046, rz],
    });
  }

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BARREL_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0.03, 0.06, -0.05], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, SIGHT_REAR + 0.002]);
  b.mount('optic', [0, RAIL_TOP, -0.036]);
  b.mount('muzzleDevice', [0, BARREL_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, 0.02, -0.33]);
  b.mount('laser', [-0.0272, 0.04, -0.37], [0, 0, 90]);
  b.mount('stock', [0, 0.05, 0.095]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('autoshotgun', def, built, glow, readoutSpec, readout);
};

export const AUTOSHOTGUN_SIGHT_LINE = SIGHT_Y;
