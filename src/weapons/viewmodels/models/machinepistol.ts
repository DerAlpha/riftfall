/**
 * MP-3 „Hornisse“ – full-auto machine pistol (M5). Model content (meters, model space: origin =
 * grip pivot, barrel along −Z). A stretched sidearm frame: long slide with twin barrel windows and
 * a ported compensator nose (the ports glow with heat), a fold-down front paddle grip, a selector
 * lever and a 20-round extended magazine with hornet stripes hanging out of the grip.
 *
 * Parts: slide (with the sights, comp and a two-digit ammo counter on its rear face), trigger,
 * magazine (tilted along the grip axis). Three-dot iron sights share the sight line.
 */
import { BoxGeometry, PlaneGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { MACHINEPISTOL_VIEWMODEL } from '../../../defs/viewmodelData/machinepistol';
import type { ViewmodelBuilder } from '../index';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials } from '../materials';
import { cylinderX, cylinderZ, latheZ, profileX, roundedBox, tiltedAxisPoint } from '../shapes';
import { ProceduralWeaponModel, createReadout, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.027;
/** Sight line: rear ear tops = front post top. */
const SIGHT_Y = 0.054;
const NOTCH_DEPTH = 0.0048;
const DOT_DROP = 0.0022;
const SLIDE_TOP = 0.047;
const SLIDE_REAR = 0.048;
const SLIDE_FRONT = -0.191;
const SLIDE_W = 0.028;
const REAR_SIGHT_Z = 0.03;
const FRONT_SIGHT_Z = -0.172;
const MUZZLE_Z = -0.197;
const GRIP_TILT = -17;
/** The deployed front paddle rakes forward (deg). */
const PADDLE_RAKE = 12;
const GRIP_TOP = { y: 0, z: 0.01 } as const;

function gripAxis(s: number): [number, number, number] {
  return tiltedAxisPoint(GRIP_TILT, GRIP_TOP.y, GRIP_TOP.z, s);
}

export const buildMachinepistol: ViewmodelBuilder = (kit) => {
  const def = MACHINEPISTOL_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'segments' };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.tritium, readout?.texture ?? null, def.glow);
  const b = new ModelBuilder('machinepistol', VIEWMODEL_ART.uvDensity);

  b.part('slide', [0, 0.029, 0]);
  b.part('trigger', [0, -0.003, -0.03]);
  b.part('magazine', [0, -0.004, 0.011], { rot: [GRIP_TILT, 0, 0] });

  // --- slide: long, twin windows onto the barrel, ported nose ---
  const fz = -SLIDE_FRONT;
  b.add(
    'slide',
    'gunmetal',
    profileX(
      [
        [-SLIDE_REAR, 0.012],
        [fz - 0.004, 0.012],
        [fz, 0.018],
        [fz, 0.036],
        [fz - 0.012, SLIDE_TOP - 0.001],
        [0.12, SLIDE_TOP],
        [-0.038, SLIDE_TOP],
        [-SLIDE_REAR, 0.039],
      ],
      SLIDE_W,
      {
        bevel: 0.0022,
        holes: [
          [
            [0.056, 0.02],
            [0.104, 0.02],
            [0.1, 0.032],
            [0.06, 0.032],
          ],
          [
            [0.132, 0.021],
            [0.168, 0.021],
            [0.164, 0.033],
            [0.136, 0.033],
          ],
        ],
      },
    ),
    { paint: P.gunmetal.paint },
  );
  // Slanted cocking serrations (proud of the flanks → dark grooves).
  for (let i = 0; i < 5; i++) {
    b.add('slide', 'darkMetal', new BoxGeometry(SLIDE_W + 0.0008, 0.022, 0.0016), {
      pos: [0, 0.029, 0.041 - i * 0.0052],
      rot: [-14, 0, 0],
      paint: P.darkMetal.paint,
    });
  }
  // Compensator ports across the nose top: dark when cold, glowing after a burst.
  for (let i = 0; i < 3; i++) {
    b.add('slide', 'heat', new BoxGeometry(0.012, 0.0012, 0.0052), {
      pos: [0, SLIDE_TOP - 0.0003, -0.142 - i * 0.0105],
    });
  }
  // Ejection port with a glimpse of brass.
  b.add('slide', 'bore', new BoxGeometry(0.001, 0.009, 0.026), {
    pos: [SLIDE_W / 2 + 0.0002, 0.039, -0.022],
  });
  b.add('slide', 'brass', new BoxGeometry(0.0006, 0.0045, 0.012), {
    pos: [SLIDE_W / 2 + 0.0008, 0.039, -0.024],
  });
  // Accent strips under the windows and a chevron on the nose (both flanks).
  for (const side of [-1, 1]) {
    const x = side * (SLIDE_W / 2 + 0.0001);
    b.add('slide', 'accent', new BoxGeometry(0.0008, 0.0018, 0.105), { pos: [x, 0.0158, -0.078] });
    b.add('slide', 'accent', new BoxGeometry(0.0008, 0.0016, 0.018), {
      pos: [x, 0.037, -0.121],
      rot: [28, 0, 0],
    });
    b.add('slide', 'accent', new BoxGeometry(0.0008, 0.0016, 0.018), {
      pos: [x, 0.037, -0.179],
      rot: [-28, 0, 0],
    });
  }
  // Two-digit ammo counter on the rear face, in a bezel.
  b.add('slide', 'darkMetal', roundedBox(0.025, 0.0195, 0.0014, 0.0005), {
    pos: [0, 0.0285, SLIDE_REAR + 0.0002],
    paint: P.darkMetal.paint,
  });
  b.add('slide', 'readout', new PlaneGeometry(0.021, 0.0162), {
    pos: [0, 0.0285, SLIDE_REAR + 0.001],
    uv: 'keep',
  });
  // Three-dot sights: the rear notch on the slide, the front post on the comp.
  const notchFloor = SIGHT_Y - NOTCH_DEPTH;
  const dotY = SIGHT_Y - DOT_DROP;
  b.add('slide', 'darkMetal', roundedBox(0.022, notchFloor - SLIDE_TOP + 0.0005, 0.008, 0.0008), {
    pos: [0, (notchFloor + SLIDE_TOP - 0.0005) / 2, REAR_SIGHT_Z],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.0058, 0.0058]) {
    b.add('slide', 'darkMetal', roundedBox(0.0064, NOTCH_DEPTH, 0.008, 0.0006), {
      pos: [x, notchFloor + NOTCH_DEPTH / 2, REAR_SIGHT_Z],
      paint: P.darkMetal.paint,
    });
    b.add('slide', 'sight', new BoxGeometry(0.0021, 0.0021, 0.0006), {
      pos: [x, dotY, REAR_SIGHT_Z + 0.0043],
    });
  }
  b.add(
    'slide',
    'darkMetal',
    profileX(
      [
        [-FRONT_SIGHT_Z - 0.0022, SLIDE_TOP - 0.001],
        [-FRONT_SIGHT_Z + 0.007, SLIDE_TOP - 0.001],
        [-FRONT_SIGHT_Z + 0.0022, SIGHT_Y],
        [-FRONT_SIGHT_Z - 0.0022, SIGHT_Y],
      ],
      0.0034,
      { bevel: 0.0006 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add('slide', 'sight', new BoxGeometry(0.0021, 0.0021, 0.0006), {
    pos: [0, dotY, FRONT_SIGHT_Z + 0.0023],
  });

  // --- barrel: visible through both windows (hot sections glow), threaded tip past the comp ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0068, 0.0068, -MUZZLE_Z - 0.02, 18), {
    pos: [0, BORE_Y, (MUZZLE_Z - 0.02) / 2],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'heat', cylinderZ(0.007, 0.007, 0.046, 18), { pos: [0, BORE_Y, -0.08] });
  b.add(BODY, 'heat', cylinderZ(0.007, 0.007, 0.034, 18), { pos: [0, BORE_Y, -0.15] });
  b.add(
    BODY,
    'darkMetal',
    latheZ(
      [
        [0.0, 0.0],
        [0.0074, 0.0],
        [0.0074, 0.005],
        [0.0064, 0.0062],
        [0.0044, 0.0062],
      ],
      18,
    ),
    { pos: [0, BORE_Y, SLIDE_FRONT + 0.0002], paint: 0.7 },
  );
  b.add(BODY, 'bore', cylinderZ(0.0044, 0.0044, 0.001, 14), { pos: [0, BORE_Y, MUZZLE_Z + 0.0002] });

  // --- frame: dust cover with rail, fold-down front paddle grip ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.05, 0.004],
        [0.13, 0.0],
        [0.144, 0.004],
        [0.148, 0.0125],
        [-0.05, 0.0125],
      ],
      0.025,
      { bevel: 0.002 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'polymer', roundedBox(0.016, 0.006, 0.044, 0.0015), {
    pos: [0, -0.002, -0.094],
    paint: P.polymer.paint,
  });
  for (let i = 0; i < 3; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.0166, 0.0024, 0.003), {
      pos: [0, -0.0035, -0.078 - i * 0.014],
      paint: P.darkMetal.paint,
    });
  }
  b.add(BODY, 'darkMetal', roundedBox(0.015, 0.009, 0.014, 0.002), {
    pos: [0, -0.006, -0.128],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', cylinderX(0.0028, 0.018, 10), { pos: [0, -0.009, -0.128], paint: 0.7 });
  b.add(BODY, 'polymer', roundedBox(0.013, 0.064, 0.019, 0.0045, 2), {
    pos: [0, -0.042, -0.136],
    rot: [PADDLE_RAKE, 0, 0],
    paint: P.polymer.paint,
  });
  // Hornet bands `d` below the paddle center, along its forward-raked axis.
  const rake = (PADDLE_RAKE * Math.PI) / 180;
  for (const d of [0.01, 0.022]) {
    b.add(BODY, 'accentPaint', roundedBox(0.0138, 0.0045, 0.0198, 0.0012), {
      pos: [0, -0.042 - Math.cos(rake) * d, -0.136 - Math.sin(rake) * d],
      rot: [PADDLE_RAKE, 0, 0],
      paint: P.accentPaint.paint,
    });
  }
  // Selector lever (left, hornet orange) and slide stop.
  b.add(BODY, 'darkMetal', cylinderX(0.0032, 0.0014, 12), {
    pos: [-0.0132, 0.0072, 0.034],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accentPaint', roundedBox(0.0024, 0.0042, 0.013, 0.0009), {
    pos: [-0.0138, 0.0078, 0.028],
    rot: [-18, 0, 0],
    paint: P.accentPaint.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.0024, 0.0045, 0.02, 0.0008), {
    pos: [-0.0132, 0.0085, -0.03],
    paint: P.darkMetal.paint,
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
  b.add(BODY, 'polymer', roundedBox(0.024, 0.006, 0.028, 0.0025), {
    pos: [0, 0.0085, 0.051],
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

  // --- extended magazine (local frame: −Y runs down the grip axis), hornet-striped sleeve ---
  b.add('magazine', 'darkMetal', new BoxGeometry(0.021, 0.112, 0.031), {
    local: true,
    pos: [0, -0.056, 0],
    paint: P.darkMetal.paint,
  });
  b.add('magazine', 'polymer', roundedBox(0.0245, 0.046, 0.035, 0.003), {
    local: true,
    pos: [0, -0.133, 0.0005],
    paint: P.polymer.paint,
  });
  for (let i = 0; i < 3; i++) {
    b.add('magazine', 'accentPaint', roundedBox(0.0251, 0.0048, 0.0356, 0.0012), {
      local: true,
      pos: [0, -0.12 - i * 0.012, 0.0005],
      paint: P.accentPaint.paint,
    });
  }
  b.add('magazine', 'darkMetal', roundedBox(0.03, 0.009, 0.046, 0.003), {
    local: true,
    pos: [0, -0.16, 0.001],
    paint: P.darkMetal.paint,
  });

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [SLIDE_W / 2 + 0.0015, 0.04, -0.022], [-40, -110, 0]);
  b.socket('sight', [0, SIGHT_Y, REAR_SIGHT_Z + 0.0043]);
  b.mount('optic', [0, SLIDE_TOP, 0.004], undefined, 'slide');
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('laser', [0.0135, 0.004, -0.098], [0, 0, -90]);
  // Shoulder stock clips onto the back of the grip (+Z out of the backstrap).
  const heel = gripAxis(0.02);
  b.mount('stock', [0, heel[1] + 0.0064, heel[2] + 0.021], [GRIP_TILT, 0, 0]);

  const built = b.build({ ...kit.materials, ...glow });
  return new ProceduralWeaponModel('machinepistol', def, built, glow, readoutSpec, readout);
};

/** Exposed for tests: the sight line height the model was built with. */
export const MACHINEPISTOL_SIGHT_LINE = SIGHT_Y;
