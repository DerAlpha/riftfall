/**
 * GL-6 „Donnerkeil“ – six-shot revolver grenade launcher (M5). Model content (meters, model
 * space: origin = grip pivot, barrel along −Z). A fat fluted drum between two frame plates (the
 * rear face shows the brass bases of the six rounds), a short heavy barrel with a ribbed
 * handguard and front grip, amber arming lights round the muzzle, a folding skeleton stock and a
 * flip-up reflex sight with stacked range bars. Parts: drum (indexes 60° per shot / per loaded
 * grenade), shells (the round being loaded, hidden at rest), trigger, sight. Six round LEDs on
 * the left frame plate face the shooter.
 */
import { BoxGeometry, PlaneGeometry, TorusGeometry } from 'three';
import { GRENADELAUNCHER_VIEWMODEL } from '../../../defs/viewmodelData/grenadelauncher';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials, type WeaponMaterialKit } from '../materials';
import {
  chamferRectProfile,
  cylinderX,
  cylinderZ,
  latheZHard,
  profileX,
  profileZ,
  roundedBox,
  tubeZ,
} from '../shapes';
import { createReadout, ledUv, type ReadoutSpec, type WeaponViewmodelModel } from '../WeaponModel';
import type { ViewmodelBuilder } from '../index';
import { EnergyWeaponModel, circleProfile, createEnergyMaterial } from './energyKit';

const P = VIEWMODEL_ART.materials;

/** Drum axis (y) and chamber circle: the top chamber lines up with the barrel. */
const DRUM = { y: 0.0, chamberR: 0.036, bore: 0.0205, outer: 0.062, back: -0.05, front: -0.19 } as const;
const BORE_Y = DRUM.y + DRUM.chamberR;
/** Sight line: center of the reflex window. */
const SIGHT_Y = 0.136;
const GRIP_TILT = -18;
const GRIP_TOP = { y: 0.0, z: 0.03 } as const;
const LEDS = 6;
const BARREL = { back: DRUM.front - 0.006, front: -0.42, r: 0.027 } as const;
/** Loading gate: the chamber at 9 o'clock (seen from behind: the shooter-facing left). */
const GATE = { x: -DRUM.chamberR, y: DRUM.y } as const;

const AMBER = { accent: 0xffa21c, sight: 0xffb347 } as const;

function gripAxis(s: number): [number, number, number] {
  const a = (GRIP_TILT * Math.PI) / 180;
  return [0, GRIP_TOP.y - Math.cos(a) * s, GRIP_TOP.z - Math.sin(a) * s];
}

/** The six chamber centers (x, y) around the drum axis, top first. */
function chambers(): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / 3;
    out.push([Math.cos(a) * DRUM.chamberR, DRUM.y + Math.sin(a) * DRUM.chamberR]);
  }
  return out;
}

function build(kit: WeaponMaterialKit): WeaponViewmodelModel {
  const def = GRENADELAUNCHER_VIEWMODEL;
  if (!def) throw new Error('grenadelauncher: no viewmodel def');
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: LEDS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(AMBER.sight, readout?.texture ?? null, def.glow);
  glow.accent.emissive.set(AMBER.accent);
  const tip = createEnergyMaterial('gl-tip', {
    core: 0xffc861,
    rim: 0xff6a10,
    rimPower: 1.6,
    noise: 0.3,
    noiseScale: 300,
    flow: [0, 0, -1],
  });
  const b = new ModelBuilder('grenadelauncher', VIEWMODEL_ART.uvDensity);

  b.part('drum', [0, DRUM.y, (DRUM.back + DRUM.front) / 2]);
  b.part('shells', [GATE.x, GATE.y, DRUM.back + 0.05], { hidden: true });
  b.part('trigger', [0, -0.03, -0.0]);
  b.part('sight', [0, 0.094, 0.0]);

  // --- drum: fluted cylinder with six through-chambers ---
  const drumLen = DRUM.back - DRUM.front;
  const drumZ = (DRUM.back + DRUM.front) / 2;
  const holes = chambers().map(([x, y]) => circleProfile(DRUM.bore, 20, x, y - DRUM.y));
  b.add('drum', 'gunmetal', profileZ(circleProfile(DRUM.outer, 48), drumLen, { bevel: 0.004, bevelSegments: 2, holes }), {
    pos: [0, DRUM.y, drumZ],
    paint: P.gunmetal.paint,
  });
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 2 + Math.PI / 6 + (i * Math.PI) / 3;
    b.add('drum', 'darkMetal', roundedBox(0.012, 0.004, drumLen - 0.03, 0.0015), {
      pos: [Math.cos(a) * (DRUM.outer - 0.0012), DRUM.y + Math.sin(a) * (DRUM.outer - 0.0012), drumZ],
      rot: [0, 0, (a * 180) / Math.PI - 90],
      paint: P.darkMetal.paint,
    });
  }
  // Loaded rounds: brass bases (rear) and glowing ogive tips (front) in every chamber.
  for (const [x, y] of chambers()) {
    b.add('drum', 'brass', latheZHard([[0, 0], [DRUM.bore - 0.0016, 0], [DRUM.bore - 0.0016, 0.012]], 20), {
      pos: [x, y, DRUM.back - 0.006],
      paint: 0.85,
    });
    b.add('drum', 'darkMetal', cylinderZ(0.004, 0.004, 0.002, 12), { pos: [x, y, DRUM.back - 0.0055], paint: 0.4 });
    b.add('drum', 'tip', latheZHard([[DRUM.bore - 0.003, 0], [0.012, 0.012], [0.004, 0.02], [0, 0.021]], 16), {
      pos: [x, y, DRUM.front + 0.012],
    });
  }
  // Drum axle caps.
  b.add('drum', 'darkMetal', cylinderZ(0.011, 0.011, drumLen + 0.006, 16), { pos: [0, DRUM.y, drumZ], paint: 0.4 });

  // --- frame: rear + front plates, top strap, axle bosses ---
  for (const [z, len] of [
    [DRUM.back + 0.011, 0.018],
    [DRUM.front - 0.011, 0.018],
  ] as const) {
    b.add(
      BODY,
      'darkMetal',
      profileZ(
        [
          [0.03, 0.066],
          [-0.03, 0.066],
          [-0.046, 0.046],
          [-0.046, -0.028],
          [-0.03, -0.044],
          [0.03, -0.044],
          [0.046, -0.028],
          [0.046, 0.046],
        ],
        len,
        { bevel: 0.002, holes: [circleProfile(0.017, 20, GATE.x - 0.0 + 0.0, 0)].slice(0, z > DRUM.back ? 1 : 0) },
      ),
      { pos: [0, DRUM.y, z], paint: P.darkMetal.paint },
    );
  }
  b.add(BODY, 'gunmetal', roundedBox(0.03, 0.012, drumLen + 0.04, 0.003), {
    pos: [0, DRUM.y + DRUM.outer + 0.009, drumZ],
    paint: P.gunmetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0016, drumLen), { pos: [-0.0152, DRUM.y + DRUM.outer + 0.009, drumZ] });
  // LED row on the left of the rear plate (facing the shooter).
  b.add(BODY, 'darkMetal', roundedBox(0.004, 0.012, 0.054, 0.0012), {
    pos: [-0.048, 0.05, DRUM.back + 0.014],
    rot: [0, 0, 0],
    paint: 0.4,
  });
  for (let i = 0; i < LEDS; i++) {
    b.add(BODY, 'readout', new BoxGeometry(0.0012, 0.006, 0.0058), {
      pos: [-0.0502, 0.05, DRUM.back + 0.036 - i * 0.0088],
      uv: ledUv(i, LEDS),
    });
  }

  // --- barrel, handguard, arming lights, front grip ---
  const barrelLen = BARREL.back - BARREL.front;
  b.add(BODY, 'darkMetal', tubeZ(BARREL.r, DRUM.bore + 0.001, barrelLen, 28), {
    pos: [0, BORE_Y, BARREL.back],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'polymer',
    profileZ(chamferRectProfile(0.068, 0.06, 0.018, 0.012), 0.15, {
      bevel: 0.003,
      holes: [circleProfile(BARREL.r + 0.001, 24, 0, 0)],
    }),
    { pos: [0, BORE_Y, BARREL.back - 0.09], paint: P.polymer.paint },
  );
  for (let i = 0; i < 5; i++) {
    b.add(BODY, 'darkMetal', roundedBox(0.07, 0.006, 0.008, 0.002), {
      pos: [0, BORE_Y + 0.006, BARREL.back - 0.035 - i * 0.026],
      paint: P.darkMetal.paint,
    });
  }
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [DRUM.bore + 0.001, 0],
        [BARREL.r + 0.004, 0],
        [BARREL.r + 0.006, 0.01],
        [BARREL.r + 0.006, 0.03],
        [BARREL.r + 0.002, 0.034],
        [DRUM.bore + 0.002, 0.034],
      ],
      28,
    ),
    { pos: [0, BORE_Y, BARREL.front + 0.034], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    b.add(BODY, 'accent', cylinderZ(0.0024, 0.0024, 0.002, 10), {
      pos: [Math.cos(a) * (BARREL.r + 0.003), BORE_Y + Math.sin(a) * (BARREL.r + 0.003), BARREL.front - 0.0005],
    });
  }
  b.add(BODY, 'accentPaint', tubeZ(BARREL.r + 0.0065, BARREL.r + 0.004, 0.008, 28), {
    pos: [0, BORE_Y, BARREL.front + 0.024],
    paint: P.accentPaint.paint,
  });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [0.29, BORE_Y - 0.028],
        [0.34, BORE_Y - 0.028],
        [0.33, -0.07],
        [0.315, -0.077],
        [0.3, -0.07],
      ],
      0.03,
      { bevel: 0.005, bevelSegments: 2 },
    ),
    { paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', roundedBox(0.0312, 0.05, 0.032, 0.004), {
    pos: [0, -0.04, -0.315],
    rot: [-8, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- receiver behind the drum: grip, trigger guard, trigger ---
  b.add(
    BODY,
    'gunmetal',
    profileX(
      [
        [-0.075, 0.06],
        [-DRUM.back - 0.02, 0.07],
        [-DRUM.back - 0.02, -0.03],
        [-0.02, -0.036],
        [-0.075, -0.012],
      ],
      0.046,
      { bevel: 0.004, bevelSegments: 2 },
    ),
    { paint: P.gunmetal.paint },
  );
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.1), { pos: [-0.0236, 0.05, 0.01] });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [-0.03, -0.03],
        [DRUM.back * -1 - 0.01, -0.03],
        [DRUM.back * -1 - 0.01, -0.058],
        [0.02, -0.066],
        [-0.024, -0.066],
        [-0.034, -0.056],
      ],
      0.012,
      {
        bevel: 0.0015,
        holes: [
          [
            [-0.022, -0.036],
            [0.03, -0.036],
            [0.03, -0.056],
            [0.018, -0.06],
            [-0.02, -0.06],
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
        [-0.002, -0.03],
        [0.004, -0.03],
        [0.005, -0.039],
        [0.002, -0.049],
        [-0.003, -0.052],
        [-0.001, -0.042],
      ],
      0.006,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );
  b.add(BODY, 'polymer', roundedBox(0.032, 0.11, 0.046, 0.008, 3), {
    pos: gripAxis(0.058),
    rot: [GRIP_TILT, 0, 0],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.0342, 0.074, 0.037, 0.004), {
    pos: gripAxis(0.062),
    rot: [GRIP_TILT, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });

  // --- folding skeleton stock ---
  b.add(BODY, 'darkMetal', cylinderX(0.006, 0.05, 12), { pos: [0, 0.04, 0.072], paint: 0.4 });
  for (const x of [-0.019, 0.019]) {
    b.add(
      BODY,
      'gunmetal',
      profileX(
        [
          [-0.07, 0.048],
          [-0.3, 0.046],
          [-0.3, 0.032],
          [-0.07, 0.032],
        ],
        0.008,
        { bevel: 0.0015 },
      ),
      { pos: [x, 0, 0], paint: P.gunmetal.paint },
    );
    b.add(
      BODY,
      'gunmetal',
      profileX(
        [
          [-0.08, 0.034],
          [-0.29, -0.03],
          [-0.3, -0.018],
          [-0.09, 0.046],
        ],
        0.007,
        { bevel: 0.0015 },
      ),
      { pos: [x, 0, 0], paint: P.gunmetal.paint },
    );
  }
  b.add(BODY, 'grip', roundedBox(0.05, 0.1, 0.018, 0.005), { pos: [0, 0.01, 0.305], uvDensity: VIEWMODEL_ART.knurlDensity });
  b.add(BODY, 'accentPaint', roundedBox(0.051, 0.012, 0.012, 0.002), { pos: [0, 0.054, 0.305], paint: P.accentPaint.paint });

  // --- flip-up reflex sight (on the top strap) ---
  b.add('sight', 'darkMetal', roundedBox(0.026, 0.01, 0.05, 0.002), { pos: [0, 0.098, -0.01], paint: 0.4 });
  b.add(
    'sight',
    'gunmetal',
    profileZ(chamferRectProfile(0.042, 0.04, 0.01, 0.003), 0.012, {
      bevel: 0.0012,
      holes: [chamferRectProfile(0.034, 0.03, 0.007, 0.002)],
    }),
    { pos: [0, SIGHT_Y - 0.004, -0.03], paint: P.gunmetal.paint },
  );
  b.add('sight', 'darkMetal', roundedBox(0.006, 0.03, 0.01, 0.0015), { pos: [-0.018, 0.113, -0.03], paint: 0.4 });
  b.add('sight', 'darkMetal', roundedBox(0.006, 0.03, 0.01, 0.0015), { pos: [0.018, 0.113, -0.03], paint: 0.4 });
  b.add('sight', 'lens', new PlaneGeometry(0.034, 0.03), { pos: [0, SIGHT_Y - 0.004, -0.036], uv: 'keep' });
  // Reticle: a chevron over stacked range bars (drop compensation for the grenade arc).
  const rz = -0.0363;
  b.add('sight', 'sight', new BoxGeometry(0.0045, 0.0005, 0.0003), { pos: [-0.002, SIGHT_Y + 0.0018, rz], rot: [0, 0, -35] });
  b.add('sight', 'sight', new BoxGeometry(0.0045, 0.0005, 0.0003), { pos: [0.002, SIGHT_Y + 0.0018, rz], rot: [0, 0, 35] });
  for (let i = 0; i < 3; i++) {
    b.add('sight', 'sight', new BoxGeometry(0.008 - i * 0.002, 0.00045, 0.0003), {
      pos: [0, SIGHT_Y - 0.0035 - i * 0.0035, rz],
    });
  }

  // --- the grenade being loaded (hidden at rest, behind the gate chamber) ---
  b.add('shells', 'brass', latheZHard([[0, 0], [DRUM.bore - 0.0018, 0], [DRUM.bore - 0.0018, 0.03]], 20), {
    pos: [GATE.x, GATE.y, DRUM.back + 0.07],
    paint: 0.85,
  });
  b.add('shells', 'darkMetal', tubeZ(DRUM.bore - 0.0012, DRUM.bore - 0.004, 0.006, 20), {
    pos: [GATE.x, GATE.y, DRUM.back + 0.036],
    paint: 0.5,
  });
  b.add('shells', 'gunmetal', latheZHard([[DRUM.bore - 0.0024, 0], [DRUM.bore - 0.0024, 0.012], [0.013, 0.024], [0, 0.036]], 20), {
    pos: [GATE.x, GATE.y, DRUM.back + 0.04],
    paint: P.gunmetal.paint,
  });
  b.add('shells', 'tip', new TorusGeometry(DRUM.bore - 0.0045, 0.0018, 6, 20), { pos: [GATE.x, GATE.y, DRUM.back + 0.024] });

  // --- sockets & mounts ---
  b.socket('muzzle', [0, BORE_Y, BARREL.front - 0.002]);
  // No casings: the loading gate stands in for the ejection port.
  b.socket('ejectPort', [GATE.x - 0.01, GATE.y, DRUM.back + 0.01], [0, 90, 0]);
  b.socket('sight', [0, SIGHT_Y, -0.018]);
  b.mount('optic', [0, 0.103, -0.01]);
  b.mount('laser', [0.036, BORE_Y, BARREL.back - 0.1]);
  b.mount('stock', [0, 0.04, 0.072]);

  const built = b.build({ ...kit.materials, ...glow, tip });
  return new EnergyWeaponModel('grenadelauncher', def, built, glow, readoutSpec, readout, [
    { material: tip, intensity: 2.6, pulseRate: 2.4, pulseDepth: 0.2, flash: 2 },
  ]);
}

export const buildGrenadelauncher: ViewmodelBuilder | null = build;

/** Exposed for tests: the sight line height the model was built with. */
export const GRENADELAUNCHER_SIGHT_LINE = SIGHT_Y;
