/**
 * FW-4 „Inferno“ – flamethrower (M5). Model content (meters, model space: origin = grip pivot,
 * barrel along −Z). Industrial brute: a red pressurised fuel tank hangs on the shooter-facing left
 * flank (hazard band, glowing fuel sight glass, an LED fuel gauge on its rear cap, a braided hose to
 * the regulator), a long heat-shielded wand whose vent slots glow while it burns, and a flared nozzle
 * with swirl vanes and a pilot burner whose small blue-orange flame never stops flickering.
 * Parts: tank (the magazine), nozzle, swirl (vanes, spin with the beam), flare (tongue that pushes
 * out of the bell with the beam), pilot (flame), trigger, sight (rear notch).
 */
import { BoxGeometry, CylinderGeometry, TorusGeometry } from 'three';
import { FLAMETHROWER_VIEWMODEL } from '../../../defs/viewmodelData/flamethrower';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import { cylinderX, cylinderZ, latheZ, latheZHard, profileX, roundedBox, tubeZ } from '../shapes';
import { createReadout, ledUv, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import { EnergyWeaponModel, bentTube, createEnergyMaterial } from './energyKit';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.05;
/** Sight line: rear notch floor = front post top. */
const SIGHT_Y = 0.113;
const GRIP_TILT = -17;
const GRIP_TOP = { y: 0.004, z: 0.012 } as const;
const LEDS = 8;
/** Heat-shield wand and the nozzle bell (z), fuel tank on the left flank. */
const WAND = { back: -0.14, front: -0.45, r: 0.024 } as const;
const NOZZLE_Z = WAND.front;
const TANK = { x: -0.049, y: 0.014, back: -0.125, front: -0.3, r: 0.027 } as const;
const PILOT = { y: BORE_Y - 0.034, z: NOZZLE_Z - 0.052 } as const;

const FIRE = { accent: 0xff7a1c, sight: 0xffb04a } as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = FLAMETHROWER_VIEWMODEL;
  if (!def) throw new Error('flamethrower: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(FIRE.sight, readout?.texture ?? null, def.glow);
  glow.accent.emissive.set(FIRE.accent);
  const fuel = createEnergyMaterial('fire-fuel', {
    core: 0xffb347,
    rim: 0xff4a0a,
    rimPower: 1.5,
    noise: 0.8,
    noiseScale: 120,
    flow: [0, 0.8, 1.2],
  });
  const vents = createEnergyMaterial('fire-vents', {
    core: 0xffa040,
    rim: 0xff3a08,
    rimPower: 1,
    noise: 0.7,
    noiseScale: 90,
    flow: [0, 2.5, -1],
  });
  const pilotFlame = createEnergyMaterial('fire-pilot', {
    core: 0x6fa8ff,
    rim: 0xff8a2a,
    rimPower: 0.9,
    noise: 0.6,
    noiseScale: 300,
    flow: [0, 3, -8],
    additive: true,
    waveRate: 31,
    wavePin: 1,
    tip: 1,
  });
  const flareFlame = createEnergyMaterial('fire-flare', {
    core: 0xffd08a,
    rim: 0xff5a14,
    rimPower: 0.8,
    noise: 1,
    noiseScale: 140,
    flow: [0, 2, -12],
    additive: true,
    waveRate: 23,
    wavePin: 1,
    tip: 1,
  });
  const b = new ModelBuilder('flamethrower', VIEWMODEL_ART.uvDensity);

  b.part('tank', [TANK.x, TANK.y, (TANK.back + TANK.front) / 2]);
  b.part('nozzle', [0, BORE_Y, NOZZLE_Z]);
  b.part('swirl', [0, BORE_Y, NOZZLE_Z - 0.03], { parent: 'nozzle' });
  b.part('flare', [0, BORE_Y, NOZZLE_Z - 0.02], { parent: 'nozzle' });
  b.part('pilot', [0, PILOT.y, PILOT.z]);
  b.part('trigger', [0, 0.0, -0.034]);
  b.part('sight', [0, 0.083, 0.01]);

  // --- receiver ---
  b.add(
    BODY,
    'gunmetal',
    profileX(
      [
        [-0.085, 0.06],
        [-0.02, 0.08],
        [0.0, 0.083],
        [0.118, 0.083],
        [-WAND.back + 0.004, 0.074],
        [-WAND.back + 0.004, 0.02],
        [0.1, 0.012],
        [-0.03, 0.012],
        [-0.085, 0.03],
      ],
      0.054,
      { bevel: 0.004, bevelSegments: 2 },
    ),
    { paint: P.gunmetal.paint },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.058, 0.012, 0.2, 0.003), {
    pos: [0, 0.018, -0.04],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [-0.0272, 0.068, -0.03] });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.2), { pos: [0.0272, 0.068, -0.03] });
  // Hazard stripes on the receiver nose.
  for (let i = 0; i < 3; i++) {
    b.add(BODY, 'accentPaint', roundedBox(0.056, 0.006, 0.008, 0.0015), {
      pos: [0, 0.079, -0.1 - i * 0.014],
      rot: [0, 0, 0],
      paint: P.accentPaint.paint,
    });
  }
  // Regulator: brass valve wheel on the left, feeding the hose from the tank.
  b.add(BODY, 'darkMetal', cylinderX(0.009, 0.012, 16), { pos: [-0.032, 0.05, -0.105], paint: 0.4 });
  b.add(BODY, 'brass', new TorusGeometry(0.009, 0.0022, 6, 18), {
    pos: [-0.04, 0.05, -0.105],
    rot: [0, 90, 0],
    paint: 0.8,
  });
  b.add(BODY, 'brass', cylinderX(0.0024, 0.02, 8), {
    pos: [-0.04, 0.05, -0.105],
    rot: [0, 0, 90],
    paint: 0.8,
  });

  // --- heat-shield wand with glowing vent slots, front sight post ---
  const wandLen = WAND.back - WAND.front;
  b.add(BODY, 'darkMetal', cylinderZ(0.011, 0.011, wandLen, 14), {
    pos: [0, BORE_Y, (WAND.back + WAND.front) / 2],
    paint: 0.4,
  });
  b.add(BODY, 'gunmetal', tubeZ(WAND.r, WAND.r - 0.003, wandLen, 28), {
    pos: [0, BORE_Y, WAND.back],
    paint: P.gunmetal.paint,
  });
  for (let i = 0; i < 6; i++) {
    const z = WAND.back - 0.04 - i * 0.045;
    for (const a of [120, 150, 180]) {
      const r = (a * Math.PI) / 180;
      b.add(BODY, 'vents', roundedBox(0.0022, 0.0055, 0.028, 0.001), {
        pos: [Math.cos(r) * (WAND.r + 0.0003), BORE_Y + Math.sin(r) * (WAND.r + 0.0003), z],
        rot: [0, 0, a],
      });
    }
    b.add(BODY, 'darkMetal', tubeZ(WAND.r + 0.0022, WAND.r - 0.001, 0.006, 28), {
      pos: [0, BORE_Y, z + 0.021],
      paint: 0.4,
    });
  }
  b.add(
    BODY,
    'darkMetal',
    profileX(
      [
        [-WAND.front - 0.03, BORE_Y + WAND.r - 0.002],
        [-WAND.front - 0.008, BORE_Y + WAND.r - 0.002],
        [-WAND.front - 0.012, SIGHT_Y - 0.003],
        [-WAND.front - 0.018, SIGHT_Y - 0.003],
      ],
      0.005,
      { bevel: 0.0008 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'sight', new BoxGeometry(0.0042, 0.0042, 0.0042), {
    pos: [0, SIGHT_Y - 0.0021, WAND.front + 0.015],
  });
  // Tank brackets (hanging from the wand) and the front handle.
  for (const z of [TANK.back - 0.03, TANK.front + 0.03]) {
    b.add(BODY, 'darkMetal', roundedBox(0.03, 0.012, 0.016, 0.002), {
      pos: [-0.028, BORE_Y - 0.018, z],
      rot: [0, 0, 35],
      paint: P.darkMetal.paint,
    });
  }
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [0.32, BORE_Y - WAND.r + 0.002],
        [0.37, BORE_Y - WAND.r + 0.002],
        [0.36, -0.058],
        [0.345, -0.064],
        [0.33, -0.058],
      ],
      0.028,
      { bevel: 0.004, bevelSegments: 2 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.0292, 0.044, 0.032, 0.004), {
    pos: [0, -0.03, -0.345],
    rot: [-8, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- pilot burner under the nozzle (static) ---
  b.add(BODY, 'darkMetal', cylinderZ(0.0045, 0.0045, 0.06, 12), {
    pos: [0, PILOT.y, PILOT.z + 0.034],
    paint: 0.4,
  });
  b.add(
    BODY,
    'brass',
    latheZHard(
      [
        [0.003, 0],
        [0.0052, 0.002],
        [0.0052, 0.008],
        [0.0035, 0.01],
      ],
      12,
    ),
    {
      pos: [0, PILOT.y, PILOT.z + 0.004],
      paint: 0.8,
    },
  );
  b.add(BODY, 'darkMetal', roundedBox(0.006, BORE_Y - PILOT.y - 0.01, 0.008, 0.001), {
    pos: [0, (BORE_Y + PILOT.y) / 2 - 0.006, PILOT.z + 0.04],
    paint: 0.4,
  });

  // --- nozzle: flared bell, heat ring, swirl vanes inside ---
  b.add(
    'nozzle',
    'darkMetal',
    latheZHard(
      [
        [0.012, 0],
        [WAND.r + 0.002, 0],
        [WAND.r + 0.002, 0.012],
        [0.026, 0.028],
        [0.031, 0.05],
        [0.028, 0.054],
        [0.02, 0.03],
        [0.012, 0.014],
      ],
      28,
    ),
    { pos: [0, BORE_Y, NOZZLE_Z], paint: P.darkMetal.paint },
  );
  b.add(
    'nozzle',
    'heat',
    latheZ(
      [
        [0.0125, 0.016],
        [0.02, 0.032],
        [0.027, 0.052],
      ],
      24,
    ),
    { pos: [0, BORE_Y, NOZZLE_Z] },
  );
  b.add('nozzle', 'accentPaint', tubeZ(WAND.r + 0.0032, WAND.r + 0.001, 0.006, 28), {
    pos: [0, BORE_Y, NOZZLE_Z - 0.003],
    paint: P.accentPaint.paint,
  });
  for (let i = 0; i < 4; i++) {
    b.add('swirl', 'gunmetal', roundedBox(0.018, 0.002, 0.008, 0.0006), {
      pos: [0, BORE_Y, NOZZLE_Z - 0.03],
      rot: [0, 25, i * 45],
      paint: 0.6,
    });
  }
  // Flare tongue: hidden inside the bell at rest, pushed out by the beam driver.
  b.add('flare', 'flareFlame', latheZ(flameProfile(0.012, 0.07), 14), {
    pos: [0, BORE_Y, NOZZLE_Z - 0.012],
    uv: 'keep',
  });

  // --- pilot flame (hidden while the tank is dry) ---
  b.add('pilot', 'pilotFlame', latheZ(flameProfile(0.0042, 0.03), 12), {
    pos: [0, PILOT.y, PILOT.z - 0.001],
    uv: 'keep',
  });

  // --- grip, trigger guard, trigger ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.002, 0.014],
        [0.066, 0.014],
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
            [0.01, -0.002],
            [0.06, -0.002],
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
        [0.032, 0.004],
        [0.038, 0.004],
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
  b.add(BODY, 'polymer', roundedBox(0.032, 0.104, 0.044, 0.008, 3), {
    pos: gripAxis(0.05),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0342, 0.07, 0.035, 0.004), {
    pos: gripAxis(0.055),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- padded stock ---
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.08, 0.068],
        [-0.29, 0.062],
        [-0.3, 0.052],
        [-0.3, -0.036],
        [-0.288, -0.042],
        [-0.2, -0.012],
        [-0.08, 0.02],
      ],
      0.04,
      {
        bevel: 0.004,
        holes: [
          [
            [-0.12, 0.05],
            [-0.26, 0.048],
            [-0.26, -0.014],
            [-0.2, 0.004],
            [-0.12, 0.024],
          ],
        ],
      },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.044, 0.1, 0.016, 0.005), {
    pos: [0, 0.012, 0.306],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- fuel tank (left flank): red shell, hazard band, sight glass, gauge cap, hose ---
  const tankLen = TANK.back - TANK.front;
  const tankZ = (TANK.back + TANK.front) / 2;
  b.add('tank', 'shellHull', cylinderZ(TANK.r, TANK.r, tankLen - 0.02, 28), {
    pos: [TANK.x, TANK.y, tankZ],
    paint: 0.55,
  });
  for (const [z, flip] of [
    [TANK.front + 0.01, 180],
    [TANK.back - 0.01, 0],
  ] as const) {
    b.add(
      'tank',
      'gunmetal',
      latheZHard(
        [
          [TANK.r + 0.0012, 0],
          [TANK.r + 0.0012, 0.006],
          [TANK.r * 0.8, 0.013],
          [TANK.r * 0.45, 0.017],
          [0, 0.018],
        ],
        28,
      ),
      { pos: [TANK.x, TANK.y, z], rot: [0, flip, 0], paint: P.gunmetal.paint },
    );
  }
  b.add('tank', 'accentPaint', tubeZ(TANK.r + 0.0008, TANK.r - 0.001, 0.016, 28), {
    pos: [TANK.x, TANK.y, TANK.front + 0.05],
    paint: P.accentPaint.paint,
  });
  b.add('tank', 'darkMetal', tubeZ(TANK.r + 0.002, TANK.r - 0.001, 0.006, 28), {
    pos: [TANK.x, TANK.y, TANK.back - 0.03],
    paint: 0.4,
  });
  // Fuel sight glass on the upper outer side.
  const glassA = (150 * Math.PI) / 180;
  b.add('tank', 'darkMetal', roundedBox(0.004, 0.012, 0.09, 0.0015), {
    pos: [TANK.x + Math.cos(glassA) * TANK.r, TANK.y + Math.sin(glassA) * TANK.r, tankZ + 0.005],
    rot: [0, 0, 150],
    paint: 0.4,
  });
  b.add('tank', 'fuel', roundedBox(0.0026, 0.0068, 0.08, 0.001), {
    pos: [
      TANK.x + Math.cos(glassA) * (TANK.r + 0.0012),
      TANK.y + Math.sin(glassA) * (TANK.r + 0.0012),
      tankZ + 0.005,
    ],
    rot: [0, 0, 150],
  });
  // Gauge bezel on the rear cap, LED arc facing the shooter.
  const gaugeZ = TANK.back + 0.012;
  b.add('tank', 'darkMetal', cylinderZ(0.017, 0.017, 0.006, 24), {
    pos: [TANK.x, TANK.y, gaugeZ],
    paint: 0.4,
  });
  b.add('tank', 'bore', cylinderZ(0.0145, 0.0145, 0.001, 24), { pos: [TANK.x, TANK.y, gaugeZ + 0.0031] });
  for (let i = 0; i < LEDS; i++) {
    const a = ((200 - (i * 220) / (LEDS - 1)) * Math.PI) / 180;
    b.add('tank', 'readout', new BoxGeometry(0.0034, 0.0034, 0.0012), {
      pos: [TANK.x + Math.cos(a) * 0.0105, TANK.y + Math.sin(a) * 0.0105, gaugeZ + 0.0036],
      rot: [0, 0, (a * 180) / Math.PI],
      uv: ledUv(i, LEDS),
    });
  }
  b.add('tank', 'fuel', new CylinderGeometry(0.0022, 0.0022, 0.0012, 12), {
    pos: [TANK.x, TANK.y, gaugeZ + 0.0036],
    rot: [90, 0, 0],
  });
  // Braided hose: tank rear top → regulator.
  b.add(
    'tank',
    'darkMetal',
    bentTube(
      [
        [TANK.x + 0.004, TANK.y + TANK.r - 0.004, TANK.back - 0.006],
        [TANK.x + 0.002, TANK.y + TANK.r + 0.01, TANK.back + 0.004],
        [-0.042, 0.052, TANK.back + 0.012],
        [-0.037, 0.05, -0.105],
      ],
      0.0036,
      16,
      8,
    ),
    { paint: 0.5 },
  );

  // --- rear notch sight ---
  b.add('sight', 'darkMetal', roundedBox(0.022, SIGHT_Y - 0.0845, 0.008, 0.0012), {
    pos: [0, (SIGHT_Y + 0.0845) / 2 - 0.0026, 0.01],
    paint: P.darkMetal.paint,
  });
  for (const x of [-0.0065, 0.0065]) {
    b.add('sight', 'darkMetal', roundedBox(0.007, 0.0052, 0.008, 0.0008), {
      pos: [x, SIGHT_Y - 0.0026 + 0.0026, 0.01],
      paint: P.darkMetal.paint,
    });
    b.add('sight', 'sight', new BoxGeometry(0.002, 0.002, 0.0006), { pos: [x, SIGHT_Y - 0.0015, 0.0143] });
  }

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, NOZZLE_Z - 0.056]);
  // No casings: the regulator valve stands in for the ejection port.
  b.socket('ejectPort', [-0.04, 0.05, -0.105], [0, 90, 0]);
  b.socket('sight', [0, SIGHT_Y, 0.0145]);
  b.mount('optic', [0, 0.083, -0.04]);
  b.mount('laser', [WAND.r + 0.004, BORE_Y, WAND.back - 0.04]);
  b.mount('underbarrel', [0, BORE_Y - WAND.r, -0.24]);

  const built = b.build({ ...kit.materials, ...glow, fuel, vents, pilotFlame, flareFlame });
  return new EnergyWeaponModel('flamethrower', def, built, glow, readoutSpec, readout, [
    { material: fuel, intensity: 2.6, pulseRate: 1.1, pulseDepth: 0.15, boost: 1.2 },
    { material: vents, intensity: 0.05, heat: 4, boost: 3.2, flickerRate: 19, flickerDepth: 0.2 },
    {
      material: pilotFlame,
      intensity: 2.8,
      flickerRate: 27,
      flickerDepth: 0.35,
      boost: 1.5,
      wave: 0.0009,
      waveBoost: 0.0012,
    },
    {
      material: flareFlame,
      intensity: 1.2,
      flickerRate: 33,
      flickerDepth: 0.4,
      boost: 3,
      wave: 0.002,
      waveBoost: 0.003,
    },
  ]);
}

/** Flame teardrop along −Z (lathe [radius, forward]): fat at the base, licking out to a tip. */
function flameProfile(r: number, len: number): [number, number][] {
  return [
    [0, 0],
    [r * 0.7, len * 0.04],
    [r, len * 0.16],
    [r * 0.92, len * 0.36],
    [r * 0.62, len * 0.62],
    [r * 0.28, len * 0.86],
    [0, len],
  ];
}

export const buildFlamethrower: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const FLAMETHROWER_SIGHT_LINE = SIGHT_Y;
