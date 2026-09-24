/**
 * RG-9 „Lanze“ – charge railgun (M5). Model content (meters, model space: origin = grip pivot,
 * barrel along −Z). A lance silhouette: two long tapered rails grow out of an armoured collar,
 * a stack of copper coils with glowing field rings rides on a spine between them around a
 * glowing slug channel. Parts: rails (railL / railR spread with the charge), coils (brighten with
 * the charge), cell (capacitor pack in the magwell), primer (charging lever, right flank),
 * trigger, sight (holo projector with a crosshair reticle). Six shot LEDs on the receiver's left
 * top chamfer face the shooter; the vent louvres behind the collar glow with heat.
 */
import { BoxGeometry, PlaneGeometry, TorusGeometry } from 'three';
import { RAILGUN_VIEWMODEL } from '../../../defs/viewmodelData/railgun';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import { chamferRectProfile, cylinderX, cylinderZ, profileX, profileZ, roundedBox } from '../shapes';
import { createReadout, ledUv, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import { EnergyWeaponModel, createEnergyMaterial, helixZ } from './energyKit';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.052;
/** Sight line: center of the holo projector's window. */
const SIGHT_Y = 0.13;
const GRIP_TILT = -18;
const GRIP_TOP = { y: 0.002, z: 0.012 } as const;
const LEDS = 6;
/** Rail roots (inside the collar) and tips; rail centers sit ±RAIL_X off the bore. */
const RAIL_ROOT = 0.225;
const RAIL_TIP = 0.635;
const RAIL_X = 0.029;
const COIL_Z = [-0.275, -0.345, -0.415, -0.485] as const;

const ENERGY = {
  core: 0xe6fdff,
  rim: 0x28c4ff,
  cellRim: 0x1f9dff,
} as const;

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
  const coil = createEnergyMaterial('rail-coil', {
    core: ENERGY.core,
    rim: ENERGY.rim,
    rimPower: 1.6,
    noise: 0.35,
    noiseScale: 140,
    flow: [0, 0, -3],
  });
  const slug = createEnergyMaterial('rail-slug', {
    core: ENERGY.core,
    rim: ENERGY.rim,
    rimPower: 1.2,
    noise: 0.6,
    noiseScale: 90,
    flow: [0, 0, -9],
  });
  const cellGlow = createEnergyMaterial('rail-cell', {
    core: 0xbdf3ff,
    rim: ENERGY.cellRim,
    rimPower: 2,
    noise: 0.8,
    noiseScale: 110,
    flow: [0, 1.6, 0.4],
  });
  const b = new ModelBuilder('railgun', VIEWMODEL_ART.uvDensity);

  b.part('rails', [0, BORE_Y, -RAIL_ROOT]);
  b.part('railL', [-RAIL_X, BORE_Y, -RAIL_ROOT], { parent: 'rails' });
  b.part('railR', [RAIL_X, BORE_Y, -RAIL_ROOT], { parent: 'rails' });
  b.part('coils', [0, BORE_Y, -0.38]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('cell', [0, -0.012, -0.113]);
  b.part('primer', [0.028, 0.066, -0.022]);
  b.part('sight', [0, 0.09, -0.066]);

  // --- receiver ---
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.05, 0.068, 0.014, 0.006), 0.3, { bevel: 0.002 }), {
    pos: [0, 0.052, -0.07],
    paint: P.gunmetal.paint,
  });
  // Recessed flank panels and the accent line above them.
  for (const side of [-1, 1]) {
    b.add(BODY, 'darkMetal', roundedBox(0.002, 0.026, 0.15, 0.0008), {
      pos: [side * 0.0252, 0.046, -0.06],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [side * 0.0254, 0.0665, -0.07] });
  }
  // Top rail + teeth.
  b.add(BODY, 'darkMetal', new BoxGeometry(0.022, 0.004, 0.22), { pos: [0, 0.088, -0.06], paint: P.darkMetal.paint });
  for (let i = 0; i < 15; i++) {
    b.add(BODY, 'darkMetal', new BoxGeometry(0.024, 0.004, 0.0065), {
      pos: [0, 0.0915, 0.04 - i * 0.0135],
      paint: P.darkMetal.paint,
    });
  }
  // Priming-lever slot (right flank).
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.007, 0.068), { pos: [0.0253, 0.066, 0.006] });

  // Heat louvres behind the collar (both flanks).
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const z = -0.158 - i * 0.012;
      b.add(BODY, 'darkMetal', new BoxGeometry(0.0014, 0.03, 0.007), {
        pos: [side * 0.0256, 0.05, z],
        rot: [0, 0, 0],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.026, 0.004), { pos: [side * 0.0258, 0.05, z - 0.006] });
    }
  }

  // --- shot LEDs on the left top chamfer, facing the shooter ---
  b.add(BODY, 'darkMetal', roundedBox(0.013, 0.003, 0.058, 0.001), {
    pos: [-0.0172, 0.0795, 0.045],
    rot: [0, 0, 45],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0062, 0.0014, 0.0055), {
      pos: [-0.0182, 0.0806, 0.022 + i * 0.0092],
      rot: [0, 0, 45],
      uv: ledUv(LEDS - 1 - i, LEDS),
    });
  }

  // --- collar: armoured block the rails grow out of ---
  b.add(
    BODY,
    'gunmetal',
    profileZ(chamferRectProfile(0.084, 0.078, 0.018, 0.01), 0.058, { bevel: 0.003 }),
    { pos: [0, BORE_Y, -0.214], paint: P.gunmetal.paint },
  );
  b.add(BODY, 'darkMetal', profileZ(chamferRectProfile(0.07, 0.066, 0.014, 0.008), 0.008, { bevel: 0.001 }), {
    pos: [0, BORE_Y, -0.246],
    paint: P.darkMetal.paint,
  });
  // Glowing field emitter the slug channel leaves through.
  b.add(BODY, 'darkMetal', new TorusGeometry(0.012, 0.0035, 8, 24), { pos: [0, BORE_Y, -0.251], paint: 0.4 });
  b.add(BODY, 'coil', new TorusGeometry(0.009, 0.0016, 8, 24), { pos: [0, BORE_Y, -0.2525], uv: 'keep' });
  b.add(BODY, 'accent', new BoxGeometry(0.05, 0.0016, 0.0016), { pos: [0, BORE_Y + 0.0385, -0.2] });
  // Side rail for a laser module (right) and a short rail under the collar.
  b.add(BODY, 'darkMetal', roundedBox(0.004, 0.016, 0.044, 0.0012), {
    pos: [0.043, 0.046, -0.214],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.006, 0.07, 0.0015), {
    pos: [0, 0.011, -0.23],
    paint: P.darkMetal.paint,
  });

  // --- spine under the coil stack, muzzle crown ---
  b.add(BODY, 'darkMetal', roundedBox(0.018, 0.01, 0.34, 0.002), {
    pos: [0, 0.026, -0.41],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0014, 0.3), { pos: [0.0092, 0.028, -0.41] });
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0014, 0.3), { pos: [-0.0092, 0.028, -0.41] });
  b.add(BODY, 'darkMetal', new TorusGeometry(0.0125, 0.0038, 8, 24), { pos: [0, BORE_Y, -0.572], paint: 0.4 });
  b.add(BODY, 'darkMetal', roundedBox(0.012, 0.022, 0.012, 0.002), {
    pos: [0, 0.036, -0.572],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'coil', new TorusGeometry(0.0095, 0.0014, 8, 24), { pos: [0, BORE_Y, -0.5755], uv: 'keep' });
  // Slug channel: a thread of light down the bore.
  b.add(BODY, 'slug', cylinderZ(0.0022, 0.0022, 0.325, 10), { pos: [0, BORE_Y, -0.41] });

  // --- rails (tapered lance blades; the glowing inner faces show through the gap) ---
  const railProfile: [number, number][] = [
    [RAIL_ROOT - 0.01, 0.086],
    [0.56, 0.077],
    [RAIL_TIP - 0.004, 0.066],
    [RAIL_TIP, 0.058],
    [RAIL_TIP - 0.006, 0.047],
    [0.585, 0.034],
    [RAIL_ROOT - 0.01, 0.022],
  ];
  for (const [part, side] of [
    ['railL', -1],
    ['railR', 1],
  ] as const) {
    b.add(part, 'gunmetal', profileX(railProfile, 0.012, { bevel: 0.0016 }), {
      pos: [side * RAIL_X, 0, 0],
      paint: P.gunmetal.paint,
    });
    // Conductor strip on the inner face, accent line on the outer face.
    b.add(part, 'darkMetal', new BoxGeometry(0.0016, 0.02, 0.36), {
      pos: [side * (RAIL_X - 0.0062), BORE_Y, -0.415],
      paint: 0.5,
    });
    b.add(part, 'accent', new BoxGeometry(0.0008, 0.006, 0.34), { pos: [side * (RAIL_X - 0.0072), BORE_Y, -0.42] });
    b.add(part, 'accent', new BoxGeometry(0.0008, 0.0016, 0.3), {
      pos: [side * (RAIL_X + 0.0062), 0.068, -0.4],
      rot: [-1.3, 0, 0],
    });
    // Insulator blocks on the outer face.
    for (let i = 0; i < 4; i++) {
      b.add(part, 'polymer', roundedBox(0.004, 0.03, 0.022, 0.0012), {
        pos: [side * (RAIL_X + 0.0068), 0.049, -0.29 - i * 0.07],
        paint: P.polymer.paint,
      });
    }
  }

  // --- coil stack: copper windings between two field rings, standing on the spine ---
  for (const z of COIL_Z) {
    b.add('coils', 'brass', helixZ(0.0152, 0.0021, 0.028, 6), { pos: [0, BORE_Y, z], paint: 0.75 });
    b.add('coils', 'coil', new TorusGeometry(0.0158, 0.0027, 8, 28), { pos: [0, BORE_Y, z - 0.017], uv: 'keep' });
    b.add('coils', 'coil', new TorusGeometry(0.0158, 0.0027, 8, 28), { pos: [0, BORE_Y, z + 0.017], uv: 'keep' });
    b.add('coils', 'darkMetal', roundedBox(0.012, 0.008, 0.03, 0.0015), {
      pos: [0, BORE_Y - 0.021, z],
      paint: P.darkMetal.paint,
    });
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
    pos: [0.0238, 0.004, -0.063],
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
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0016, 0.16), { pos: [0.0185, 0.082, 0.2], rot: [-3, 0, 0] });
  b.add(BODY, 'grip', roundedBox(0.04, 0.126, 0.016, 0.004), {
    pos: [0, 0.015, 0.338],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- capacitor cell (magwell, drops out on magOut) ---
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
  // Glowing charge window (right face) and base plate.
  b.add('cell', 'cellGlow', new BoxGeometry(0.0012, 0.058, 0.04), { pos: [0.0172, -0.062, -0.113] });
  b.add('cell', 'bore', new BoxGeometry(0.0006, 0.062, 0.044), { pos: [0.0168, -0.062, -0.113] });
  b.add('cell', 'accentPaint', roundedBox(0.04, 0.01, 0.078, 0.003), {
    pos: [0, -0.108, -0.113],
    paint: P.accentPaint.paint,
  });

  // --- priming lever (right flank) ---
  b.add('primer', 'darkMetal', cylinderX(0.0028, 0.014, 10), { pos: [0.033, 0.066, -0.022], paint: 0.4 });
  b.add('primer', 'accentPaint', roundedBox(0.011, 0.012, 0.016, 0.003), {
    pos: [0.042, 0.066, -0.022],
    paint: P.accentPaint.paint,
  });

  // --- holo projector sight ---
  b.add('sight', 'darkMetal', roundedBox(0.024, 0.022, 0.046, 0.002), {
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
  b.socket('muzzle', [0, BORE_Y, -0.625]);
  // No casings: the vent louvres (right) stand in for the ejection port.
  b.socket('ejectPort', [0.027, 0.05, -0.17], [-30, -100, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.047]);
  b.mount('optic', [0, 0.0935, -0.066]);
  b.mount('laser', [0.045, 0.046, -0.214]);
  b.mount('underbarrel', [0, 0.008, -0.23]);

  const built = b.build({ ...kit.materials, ...glow, coil, slug, cellGlow });
  return new EnergyWeaponModel('railgun', def, built, glow, readoutSpec, readout, [
    { material: coil, intensity: 3.4, pulseRate: 2.1, pulseDepth: 0.14, flash: 7, heat: 2.5, boost: 10 },
    { material: slug, intensity: 2.2, pulseRate: 3.3, pulseDepth: 0.2, flash: 14, boost: 16 },
    { material: cellGlow, intensity: 2.6, pulseRate: 1.3, pulseDepth: 0.22 },
  ]);
}

export const buildRailgun: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const RAILGUN_SIGHT_LINE = SIGHT_Y;
