/**
 * RG-9 „Lanze“ – charge railgun (M5). Model content (meters, model space: origin = grip pivot,
 * barrel along −Z). A lance silhouette: two tapered rails run out of an armoured collar through a
 * stack of four accelerator rings whose inner edges glow, around a thread of light down the bore.
 * The shooter-facing left flank carries a caged capacitor bank that burns brighter with the
 * charge. Parts: rails (railL / railR part with the charge), coils (the ring stack), cell
 * (capacitor pack in the magwell), primer (charging lever, right flank), trigger, sight (holo
 * projector with a crosshair reticle). Six shot LEDs on the receiver's left top chamfer.
 */
import { BoxGeometry, PlaneGeometry, TorusGeometry } from 'three';
import { RAILGUN_VIEWMODEL } from '../../../defs/viewmodelData/railgun';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import { chamferRectProfile, cylinderX, cylinderZ, profileX, profileZ, roundedBox } from '../shapes';
import { createReadout, ledUv, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import { EnergyWeaponModel, createEnergyMaterial } from './energyKit';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.05;
/** Sight line: center of the holo projector's window. */
const SIGHT_Y = 0.132;
const GRIP_TILT = -18;
const GRIP_TOP = { y: 0.002, z: 0.012 } as const;
const LEDS = 6;
/** Rail roots (inside the collar) and tips (forward distance); rail centers sit ±RAIL_X off the bore. */
const RAIL_ROOT = 0.235;
const RAIL_TIP = 0.69;
const RAIL_X = 0.03;
/** Accelerator ring stations (z) and the ring frame / glowing inner edge sizes (w, h, chamfer). */
const RING_Z = [-0.292, -0.352, -0.412] as const;
const RING_OUTER = [0.104, 0.076, 0.018] as const;
const RING_INNER = [0.088, 0.06, 0.012] as const;
const RING_EDGE = [0.083, 0.055, 0.01] as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = RAILGUN_VIEWMODEL;
  if (!def) throw new Error('railgun: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(0x7ff4ff, readout?.texture ?? null, def.glow);
  const field = createEnergyMaterial('rail-field', {
    core: 0x9ff4ff,
    rim: 0x1a8dff,
    rimPower: 1.4,
    noise: 0.45,
    noiseScale: 120,
    flow: [0, 0, -4],
  });
  const slug = createEnergyMaterial('rail-slug', {
    core: 0xc8fbff,
    rim: 0x27b8ff,
    rimPower: 1.2,
    noise: 0.6,
    noiseScale: 90,
    flow: [0, 0, -9],
  });
  const sheet = createEnergyMaterial('rail-sheet', {
    core: 0x2a9dff,
    rim: 0x9ff4ff,
    rimPower: 1,
    noise: 1,
    noiseScale: 70,
    flow: [0, 0.6, -6],
    additive: true,
  });
  const cap = createEnergyMaterial('rail-cap', {
    core: 0x78e6ff,
    rim: 0x1670ff,
    rimPower: 1.8,
    noise: 0.75,
    noiseScale: 160,
    flow: [0, 2.2, 0],
  });
  const b = new ModelBuilder('railgun', VIEWMODEL_ART.uvDensity);

  b.part('rails', [0, BORE_Y, -RAIL_ROOT]);
  b.part('railL', [-RAIL_X, BORE_Y, -RAIL_ROOT], { parent: 'rails' });
  b.part('railR', [RAIL_X, BORE_Y, -RAIL_ROOT], { parent: 'rails' });
  b.part('coils', [0, BORE_Y, -0.43]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('cell', [0, -0.012, -0.113]);
  b.part('primer', [0.028, 0.064, -0.022]);
  b.part('sight', [0, 0.089, -0.066]);

  // --- receiver ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.052, 0.07, 0.014, 0.006), 0.28, { bevel: 0.002 }), {
    pos: [0, BORE_Y, -0.06],
    paint: P.gunmetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.22), { pos: [-0.0264, 0.0735, -0.08] });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.22), { pos: [0.0264, 0.0735, -0.08] });
  // Top rail + teeth.
  b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.004, 0.22), {
    pos: [0, 0.087, -0.06],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 15; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.004, 0.0065), {
      pos: [0, 0.0905, 0.04 - i * 0.0135],
      paint: P.darkMetal.paint,
    });
  }
  // Priming-lever slot (right flank).
  b.add(BODY, 'darkMetal', new BoxGeometry(0.0012, 0.007, 0.068), {
    pos: [0.0263, 0.064, 0.006],
    paint: 0.05,
  });

  // Capacitor tube on the left flank, facing the shooter behind a slotted cage.
  b.add(BODY, 'darkMetal', new BoxGeometry(0.0014, 0.024, 0.13), {
    pos: [-0.0262, 0.047, -0.08],
    paint: 0.05,
  });
  b.add(BODY, 'cap', cylinderZ(0.0085, 0.0085, 0.124, 16), { pos: [-0.0236, 0.047, -0.08] });
  for (const cz of [-0.017, -0.143]) {
    b.add(BODY, 'darkMetal', cylinderZ(0.0105, 0.0105, 0.008, 16), { pos: [-0.0236, 0.047, cz], paint: 0.4 });
  }
  for (const y of [0.0345, 0.0595]) {
    b.add(BODY, 'gunmetal', roundedBox(0.004, 0.0034, 0.134, 0.0012), {
      pos: [-0.0278, y, -0.08],
      paint: P.gunmetal.paint,
    });
  }
  for (let i = 0; i < 5; i++) {
    b.add(BODY, 'gunmetal', roundedBox(0.0036, 0.028, 0.0034, 0.0012), {
      pos: [-0.0296, 0.047, -0.03 - i * 0.025],
      rot: [0, 0, 0],
      paint: P.gunmetal.paint,
    });
  }

  // Heat louvres behind the collar (both flanks).
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = -0.163 - i * 0.011;
      b.add(BODY, 'darkMetal', new BoxGeometry(0.0014, 0.03, 0.006), {
        pos: [side * 0.0266, BORE_Y, z],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.026, 0.004), {
        pos: [side * 0.0268, BORE_Y, z - 0.0055],
      });
    }
  }

  // --- shot LEDs on the left top chamfer, facing the shooter ---
  b.add(BODY, 'darkMetal', roundedBox(0.013, 0.003, 0.058, 0.001), {
    pos: [-0.0172, 0.0805, 0.045],
    rot: [0, 0, 45],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0062, 0.0014, 0.0055), {
      pos: [-0.0182, 0.0816, 0.022 + i * 0.0092],
      rot: [0, 0, 45],
      uv: ledUv(LEDS - 1 - i, LEDS),
    });
  }

  // --- collar: armoured block the rails grow out of ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.092, 0.088, 0.022, 0.012), 0.062, { bevel: 0.003 }), {
    pos: [0, BORE_Y, -0.225],
    paint: P.gunmetal.paint,
  });
  b.add(BODY, 'darkMetal', profileZ(chamferRectProfile(0.078, 0.074, 0.016, 0.01), 0.008, { bevel: 0.001 }), {
    pos: [0, BORE_Y, -0.259],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.05, 0.0016, 0.0016), { pos: [0, BORE_Y + 0.0445, -0.21] });
  for (const side of [-1, 1]) {
    b.add(BODY, 'accent', new BoxGeometry(0.0016, 0.03, 0.0016), { pos: [side * 0.0465, BORE_Y, -0.21] });
  }
  // Laser rail (right) and a short rail under the collar.
  b.add(BODY, 'darkMetal', roundedBox(0.004, 0.016, 0.044, 0.0012), {
    pos: [0.048, 0.046, -0.225],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.006, 0.07, 0.0015), {
    pos: [0, 0.004, -0.24],
    paint: P.darkMetal.paint,
  });

  // --- spine under the ring stack, muzzle emitter ---
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.008, 0.38, 0.002), {
    pos: [0, 0.025, -0.44],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', new TorusGeometry(0.011, 0.0034, 8, 24), { pos: [0, BORE_Y, -0.64], paint: 0.4 });
  b.add(BODY, 'darkMetal', roundedBox(0.01, 0.018, 0.012, 0.002), { pos: [0, 0.034, -0.64], paint: 0.4 });
  b.add(BODY, 'field', new TorusGeometry(0.0085, 0.0013, 8, 24), { pos: [0, BORE_Y, -0.6435], uv: 'keep' });
  // Slug channel: a thread of light down the bore, and the field sheet between the bare rails.
  b.add(BODY, 'slug', cylinderZ(0.0021, 0.0021, 0.385, 10), { pos: [0, BORE_Y, -0.4475] });
  b.add(BODY, 'sheet', new PlaneGeometry(0.2, 0.03), {
    pos: [0, BORE_Y, -0.535],
    rot: [0, 90, 0],
    uv: 'keep',
  });

  // --- rails: tapered lance blades, glowing conductor faces towards the bore ---
  const railProfile: [number, number][] = [
    [RAIL_ROOT - 0.012, 0.072],
    [0.44, 0.072],
    [0.6, 0.081],
    [RAIL_TIP - 0.012, 0.086],
    [RAIL_TIP, 0.079],
    [RAIL_TIP - 0.004, 0.062],
    [RAIL_TIP - 0.03, 0.054],
    [RAIL_TIP - 0.03, 0.046],
    [RAIL_TIP - 0.004, 0.038],
    [RAIL_TIP, 0.022],
    [RAIL_TIP - 0.012, 0.014],
    [0.6, 0.019],
    [0.44, 0.028],
    [RAIL_ROOT - 0.012, 0.028],
  ];
  for (const [part, side] of [
    ['railL', -1],
    ['railR', 1],
  ] as const) {
    b.add(part, 'gunmetal', profileX(railProfile, 0.012, { bevel: 0.0016 }), {
      pos: [side * RAIL_X, 0, 0],
      paint: P.gunmetal.paint,
    });
    b.add(part, 'gunmetal', new BoxGeometry(0.0016, 0.022, 0.4), {
      pos: [side * (RAIL_X - 0.0062), BORE_Y, -0.44],
      paint: 0.12,
    });
    b.add(part, 'accent', new BoxGeometry(0.0008, 0.007, 0.38), {
      pos: [side * (RAIL_X - 0.0072), BORE_Y, -0.445],
    });
    b.add(part, 'accent', new BoxGeometry(0.0008, 0.0016, 0.36), {
      pos: [side * (RAIL_X + 0.0062), 0.064, -0.43],
    });
  }

  // --- accelerator rings: frame, glowing inner edge, clamp blocks and cable stubs ---
  for (const z of RING_Z) {
    b.add(
      'coils',
      'gunmetal',
      profileZ(chamferRectProfile(RING_OUTER[0], RING_OUTER[1], RING_OUTER[2]), 0.014, {
        bevel: 0.0018,
        holes: [chamferRectProfile(RING_INNER[0], RING_INNER[1], RING_INNER[2])],
      }),
      { pos: [0, BORE_Y, z], paint: P.gunmetal.paint },
    );
    b.add(
      'coils',
      'field',
      profileZ(chamferRectProfile(RING_INNER[0], RING_INNER[1], RING_INNER[2]), 0.008, {
        holes: [chamferRectProfile(RING_EDGE[0], RING_EDGE[1], RING_EDGE[2])],
      }),
      { pos: [0, BORE_Y, z] },
    );
    for (const side of [-1, 1]) {
      b.add('coils', 'darkMetal', roundedBox(0.012, 0.03, 0.02, 0.002), {
        pos: [side * 0.052, BORE_Y, z],
        paint: P.darkMetal.paint,
      });
      b.add('coils', 'brass', cylinderX(0.0034, 0.004, 10), {
        pos: [side * 0.059, BORE_Y + 0.008, z],
        paint: 0.8,
      });
    }
  }

  // --- magwell, trigger guard, trigger ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.08, 0.022],
        [0.165, 0.022],
        [0.165, -0.022],
        [0.158, -0.028],
        [0.068, -0.028],
        [0.064, 0.0],
        [-0.03, 0.0],
        [-0.08, 0.01],
      ],
      0.046,
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
        [0.064, 0.002],
        [0.064, -0.024],
        [0.056, -0.032],
        [0.008, -0.032],
        [-0.004, -0.022],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [0.01, -0.004],
            [0.058, -0.004],
            [0.058, -0.021],
            [0.052, -0.027],
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
  b.add(BODY, 'accentPaint', roundedBox(0.0026, 0.007, 0.01, 0.001), {
    pos: [-0.0238, 0.004, -0.063],
    paint: P.accentPaint.paint,
  });

  // --- grip ---
  b.add(BODY, 'polymer', roundedBox(0.031, 0.108, 0.044, 0.007, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0332, 0.072, 0.035, 0.004), {
    pos: gripAxis(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- stock with cheek riser (skeleton), butt pad ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.075, 0.084],
        [-0.2, 0.092],
        [-0.315, 0.086],
        [-0.33, 0.072],
        [-0.33, -0.042],
        [-0.315, -0.048],
        [-0.2, -0.004],
        [-0.075, 0.016],
      ],
      0.036,
      {
        bevel: 0.003,
        holes: [
          [
            [-0.12, 0.07],
            [-0.29, 0.07],
            [-0.29, -0.02],
            [-0.12, 0.026],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0016, 0.16), {
    pos: [-0.0185, 0.083, 0.2],
    rot: [-3, 0, 0],
  });
  b.add(BODY, 'grip', roundedBox(0.04, 0.126, 0.016, 0.004), {
    pos: [0, 0.015, 0.338],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- capacitor cell (magwell, drops out on magOut); charge window faces the shooter ---
  b.add('cell', 'darkMetal', roundedBox(0.034, 0.1, 0.07, 0.004, 2), {
    pos: [0, -0.056, -0.113],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 3; i++) {
    b.add('cell', 'gunmetal', roundedBox(0.0362, 0.004, 0.072, 0.001), {
      pos: [0, -0.034 - i * 0.022, -0.113],
      paint: P.gunmetal.paint,
    });
  }
  b.add('cell', 'darkMetal', new BoxGeometry(0.0006, 0.05, 0.036), {
    pos: [-0.0172, -0.064, -0.113],
    paint: 0.05,
  });
  b.add('cell', 'cap', new BoxGeometry(0.0012, 0.04, 0.026), { pos: [-0.0176, -0.064, -0.113] });
  b.add('cell', 'accentPaint', roundedBox(0.04, 0.01, 0.078, 0.003), {
    pos: [0, -0.108, -0.113],
    paint: P.accentPaint.paint,
  });

  // --- priming lever (right flank) ---
  b.add('primer', 'darkMetal', cylinderX(0.0028, 0.014, 10), { pos: [0.033, 0.064, -0.022], paint: 0.4 });
  b.add('primer', 'accentPaint', roundedBox(0.011, 0.012, 0.016, 0.003), {
    pos: [0.042, 0.064, -0.022],
    paint: P.accentPaint.paint,
  });

  // --- holo projector sight ---
  b.add('sight', 'darkMetal', roundedBox(0.024, 0.024, 0.046, 0.002), {
    pos: [0, 0.103, -0.068],
    paint: P.darkMetal.paint,
  });
  b.add(
    'sight',
    'gunmetal',
    profileZ(chamferRectProfile(0.038, 0.036, 0.009, 0.002), 0.044, {
      bevel: 0.0015,
      holes: [chamferRectProfile(0.03, 0.027, 0.006, 0.001)],
    }),
    { pos: [0, SIGHT_Y, -0.07], paint: P.gunmetal.paint },
  );
  b.add('sight', 'accent', new BoxGeometry(0.014, 0.0012, 0.03), { pos: [0, SIGHT_Y + 0.0182, -0.07] });
  b.add('sight', 'lens', new PlaneGeometry(0.03, 0.027), { pos: [0, SIGHT_Y, -0.0905], uv: 'keep' });
  const reticleZ = -0.0908;
  b.add('sight', 'sight', new TorusGeometry(0.0072, 0.00032, 4, 40), { pos: [0, SIGHT_Y, reticleZ] });
  for (const [x, y, w, h] of [
    [-0.0042, 0, 0.0036, 0.0005],
    [0.0042, 0, 0.0036, 0.0005],
    [0, -0.0042, 0.0005, 0.0036],
  ] as const) {
    b.add('sight', 'sight', new BoxGeometry(w, h, 0.0003), { pos: [x, SIGHT_Y + y, reticleZ] });
  }
  b.add('sight', 'sight', cylinderZ(0.0006, 0.0006, 0.0003, 10), { pos: [0, SIGHT_Y, reticleZ] });

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, -(RAIL_TIP - 0.012)]);
  // No casings: the vent louvres (right) stand in for the ejection port.
  b.socket('ejectPort', [0.028, BORE_Y, -0.17], [-30, -100, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.047]);
  b.mount('optic', [0, 0.0925, -0.066]);
  b.mount('laser', [0.05, 0.046, -0.225]);
  b.mount('underbarrel', [0, 0.001, -0.24]);
  // Stock kits (the defs' stock slot) join where the skeleton stock leaves the receiver.
  b.mount('stock', [0, 0.05, 0.08]);

  const built = b.build({ ...kit.materials, ...glow, field, slug, sheet, cap });
  return new EnergyWeaponModel('railgun', def, built, glow, readoutSpec, readout, [
    { material: field, intensity: 2.2, pulseRate: 2.1, pulseDepth: 0.14, flash: 7, heat: 2, boost: 8 },
    { material: slug, intensity: 1.8, pulseRate: 3.3, pulseDepth: 0.2, flash: 12, boost: 12 },
    { material: sheet, intensity: 0.35, pulseRate: 4.1, pulseDepth: 0.3, flash: 3, boost: 3.5 },
    { material: cap, intensity: 1.7, pulseRate: 1.3, pulseDepth: 0.22, flash: 3, boost: 6 },
  ]);
}

export const buildRailgun: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const RAILGUN_SIGHT_LINE = SIGHT_Y;
