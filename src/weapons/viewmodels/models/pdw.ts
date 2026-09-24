/**
 * PDW-50 „Sturmwind“ – top-loaded bullpup personal defence weapon (M5). Model content (meters,
 * model space: origin = grip pivot, barrel along −Z). A sculpted polymer shell: rounded nose, a
 * big finger loop in front of the grip, a thumbhole behind it and the butt running back to the
 * shoulder. The 50-round magazine lies on top in a smoked translucent shell: the rounds inside
 * lie crosswise with glowing tips that go dark from the rear as it empties (the ammo readout).
 *
 * Parts: magazine (lifted off the top on a reload), bolt (the left charging handle), trigger.
 * An integrated reflex housing bridges the magazine; its ring reticle sits on the sight line.
 * Casings leave through the bottom of the butt (the ejection socket points down).
 */
import { BoxGeometry, MeshPhysicalMaterial, PlaneGeometry, TorusGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { PDW_VIEWMODEL } from '../../../defs/viewmodelData/pdw';
import type { ViewmodelBuilder } from '../index';
import { BODY, ModelBuilder } from '../ModelBuilder';
import { createGlowMaterials } from '../materials';
import {
  chamferRectProfile,
  cylinderX,
  cylinderZ,
  latheZ,
  profileX,
  profileZ,
  roundedBox,
  type ProfilePoint,
} from '../shapes';
import { ProceduralWeaponModel, createReadout, ledUv, type ReadoutSpec } from '../WeaponModel';

const P = VIEWMODEL_ART.materials;

const BORE_Y = 0.048;
const BODY_TOP = 0.074;
const BODY_W = 0.052;
/** Magazine on top: height, width and its front/rear ends. */
const MAG_Y = 0.087;
const MAG_H = 0.024;
const MAG_W = 0.05;
const MAG_FRONT = -0.17;
const MAG_REAR = 0.15;
/** Glowing round cells inside the magazine (one readout LED per two rounds). */
const CELLS = 25;
/** Reflex housing over the magazine: its window and ring reticle sit on the sight line. */
const SIGHT_Y = 0.115;
const HOUSING_FRONT = -0.095;
const HOUSING_REAR = -0.045;
const HOUSING_TOP = 0.131;
const NOSE_Z = -0.23;
const MUZZLE_Z = -0.26;
const BUTT_Z = 0.272;

/**
 * Smoked translucent polymer of the magazine shell (content: owned by the model). Satin, weak
 * specular: at the grazing hip angle a glossy shell mirrors the lights into a blown-out glare.
 */
const MAG_SHELL = {
  color: 0x16242a,
  opacity: 0.5,
  roughness: 0.42,
  specularIntensity: 0.45,
  clearcoat: 0.2,
  clearcoatRoughness: 0.4,
} as const;
/** Cartridge radius inside the magazine and their tarnish (darkens the brass sheen under the shell). */
const ROUND_R = 0.0033;
const ROUND_TARNISH = 0.4;

/** Side silhouette of the shell: nose, receiver bottom, thumbhole slope, butt. */
const BODY_OUTLINE: readonly ProfilePoint[] = [
  [0.212, BODY_TOP],
  [0.228, 0.063],
  [0.231, 0.034],
  [0.216, 0.021],
  [0.13, 0.017],
  [0.035, 0.012],
  [-0.045, 0.012],
  [-0.075, 0.0],
  [-0.125, -0.062],
  [-0.145, -0.098],
  [-0.2, -0.11],
  [-0.252, -0.106],
  [-BUTT_Z + 0.004, -0.086],
  [-BUTT_Z, 0.036],
  [-BUTT_Z + 0.01, 0.062],
  [-0.24, BODY_TOP],
];
/** Finger loop: a band from under the nose round to the bottom of the grip. */
const LOOP_OUTLINE: readonly ProfilePoint[] = [
  [0.206, 0.024],
  [0.2, -0.01],
  [0.185, -0.05],
  [0.16, -0.083],
  [0.12, -0.102],
  [0.06, -0.108],
  [0.0, -0.108],
  [0.004, -0.092],
  [0.06, -0.092],
  [0.108, -0.087],
  [0.142, -0.07],
  [0.162, -0.042],
  [0.172, -0.008],
  [0.175, 0.02],
];
const GRIP_OUTLINE: readonly ProfilePoint[] = [
  [0.014, 0.014],
  [0.018, -0.02],
  [0.013, -0.06],
  [0.006, -0.1],
  [-0.038, -0.104],
  [-0.033, -0.06],
  [-0.03, -0.02],
  [-0.034, 0.014],
];
const GRIP_PANEL: readonly ProfilePoint[] = [
  [0.012, -0.012],
  [0.014, -0.03],
  [0.009, -0.06],
  [0.003, -0.088],
  [-0.032, -0.093],
  [-0.029, -0.06],
  [-0.027, -0.03],
  [-0.029, -0.012],
];
/** Bar under the thumbhole, from the grip to the butt. */
const BAR_OUTLINE: readonly ProfilePoint[] = [
  [-0.02, -0.092],
  [-0.14, -0.09],
  [-0.16, -0.112],
  [-0.03, -0.113],
  [-0.012, -0.106],
];

/** Housing cross-section [x, y]: open at the bottom (the magazine tunnel). */
function housingProfile(): ProfilePoint[] {
  const x = 0.029;
  const tx = MAG_W / 2 + 0.0012;
  const ty = MAG_Y + MAG_H / 2 + 0.0025;
  return [
    [x, BODY_TOP],
    [x, HOUSING_TOP - 0.012],
    [x - 0.012, HOUSING_TOP],
    [-x + 0.012, HOUSING_TOP],
    [-x, HOUSING_TOP - 0.012],
    [-x, BODY_TOP],
    [-tx, BODY_TOP],
    [-tx, ty],
    [tx, ty],
    [tx, BODY_TOP],
  ];
}

export const buildPdw: ViewmodelBuilder = (kit) => {
  const def = PDW_VIEWMODEL;
  const readoutSpec: ReadoutSpec = { kind: 'leds', count: CELLS };
  const readout = createReadout(readoutSpec);
  const glow = createGlowMaterials(VIEWMODEL_ART.emissive.accent, readout?.texture ?? null, def.glow);
  const shell = new MeshPhysicalMaterial({
    name: 'vm-magshell',
    color: MAG_SHELL.color,
    metalness: 0,
    roughness: MAG_SHELL.roughness,
    specularIntensity: MAG_SHELL.specularIntensity,
    clearcoat: MAG_SHELL.clearcoat,
    clearcoatRoughness: MAG_SHELL.clearcoatRoughness,
    transparent: true,
    opacity: MAG_SHELL.opacity,
    depthWrite: false,
  });
  const b = new ModelBuilder('pdw', VIEWMODEL_ART.uvDensity);

  b.part('magazine', [0, MAG_Y, (MAG_FRONT + MAG_REAR) / 2]);
  b.part('bolt', [-BODY_W / 2 - 0.002, 0.061, -0.19]);
  b.part('trigger', [0, 0.012, -0.03]);

  // --- shell: body, finger loop, grip, thumbhole bar, butt pad ---
  b.add(BODY, 'polymer', profileX(BODY_OUTLINE, BODY_W, { bevel: 0.0065, bevelSegments: 3 }), {
    paint: P.polymer.paint,
  });
  b.add(BODY, 'polymer', profileX(LOOP_OUTLINE, 0.034, { bevel: 0.006, bevelSegments: 3 }), {
    paint: P.polymer.paint,
  });
  b.add(BODY, 'polymer', profileX(GRIP_OUTLINE, 0.03, { bevel: 0.006, bevelSegments: 3 }), {
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', profileX(GRIP_PANEL, 0.0326, { bevel: 0.002 }), {
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'polymer', profileX(BAR_OUTLINE, 0.034, { bevel: 0.006, bevelSegments: 2 }), {
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.05, 0.13, 0.01, 0.004), {
    pos: [0, -0.024, BUTT_Z + 0.004],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  // Gunmetal spine under the magazine (the receiver the shell wraps).
  b.add(BODY, 'gunmetal', profileZ(chamferRectProfile(0.046, 0.008, 0.003, 0.001), 0.36, { bevel: 0.0015 }), {
    pos: [0, BODY_TOP - 0.0035, -0.02],
    paint: P.gunmetal.paint,
  });
  // Gunmetal receiver plates along both flanks (two-tone shell) and knurled cheek panels on the butt.
  for (const side of [-1, 1]) {
    b.add(
      BODY,
      'gunmetal',
      profileX(
        [
          [0.2, 0.066],
          [0.21, 0.056],
          [0.205, 0.03],
          [0.12, 0.026],
          [-0.05, 0.024],
          [-0.07, 0.034],
          [-0.07, 0.066],
        ],
        0.0016,
        { bevel: 0.0005 },
      ),
      { pos: [side * (BODY_W / 2 + 0.0002), 0, 0], paint: P.gunmetal.paint },
    );
    b.add(BODY, 'grip', roundedBox(0.0016, 0.07, 0.1, 0.0006), {
      pos: [side * (BODY_W / 2 + 0.0001), -0.01, 0.205],
      uvDensity: VIEWMODEL_ART.knurlDensity,
    });
  }
  // Glowing seam along both flanks; ejection chute under the butt.
  for (const side of [-1, 1]) {
    b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.0018, 0.24), {
      pos: [side * (BODY_W / 2 + 0.0014), 0.046, -0.05],
    });
  }
  b.add(BODY, 'bore', new BoxGeometry(0.014, 0.0012, 0.03), { pos: [0, -0.1134, 0.085] });
  // Charging-handle slot (left).
  b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.006, 0.07), { pos: [-BODY_W / 2 - 0.0014, 0.061, -0.165] });
  // Heat vents on both nose flanks.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = -0.186 - i * 0.012;
      b.add(BODY, 'darkMetal', new BoxGeometry(0.0012, 0.02, 0.008), {
        pos: [side * (BODY_W / 2 + 0.0014), BORE_Y - 0.004, z],
        rot: [24, 0, 0],
        paint: P.darkMetal.paint,
      });
      b.add(BODY, 'heat', new BoxGeometry(0.0012, 0.016, 0.0045), {
        pos: [side * (BODY_W / 2 + 0.0018), BORE_Y - 0.004, z],
        rot: [24, 0, 0],
      });
    }
  }

  // --- muzzle: slotted flash hider out of the nose ---
  const hider = NOSE_Z - MUZZLE_Z;
  b.add(
    BODY,
    'darkMetal',
    latheZ(
      [
        [0.0, 0.0],
        [0.0104, 0.0],
        [0.0112, 0.004],
        [0.0098, hider],
        [0.0062, hider],
      ],
      12,
    ),
    { pos: [0, BORE_Y, NOSE_Z], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.add(BODY, 'bore', new BoxGeometry(0.0022, 0.0022, 0.016), {
      pos: [Math.cos(a) * 0.0096, BORE_Y + Math.sin(a) * 0.0096, MUZZLE_Z + 0.011],
      rot: [0, 0, (a * 180) / Math.PI],
    });
  }
  b.add(BODY, 'bore', cylinderZ(0.0058, 0.0058, 0.0012, 14), { pos: [0, BORE_Y, MUZZLE_Z + 0.0005] });

  // --- reflex housing bridging the magazine: window, lens, ring reticle ---
  const hLen = HOUSING_REAR - HOUSING_FRONT;
  const hZ = (HOUSING_REAR + HOUSING_FRONT) / 2;
  b.add(
    BODY,
    'gunmetal',
    profileZ(housingProfile(), hLen, {
      bevel: 0.0015,
      holes: [chamferRectProfile(0.034, 0.018, 0.004).map(([x, y]) => [x, y + SIGHT_Y] as const)],
    }),
    { pos: [0, 0, hZ], paint: P.gunmetal.paint },
  );
  b.add(BODY, 'accent', new BoxGeometry(0.012, 0.0012, 0.03), { pos: [0, HOUSING_TOP + 0.0002, hZ] });
  b.add(BODY, 'lens', new PlaneGeometry(0.034, 0.018), {
    pos: [0, SIGHT_Y, HOUSING_FRONT + 0.002],
    uv: 'keep',
  });
  b.add(BODY, 'sight', new TorusGeometry(0.0042, 0.00045, 6, 28), {
    pos: [0, SIGHT_Y, HOUSING_FRONT + 0.0025],
  });
  b.add(BODY, 'sight', cylinderZ(0.0006, 0.0006, 0.0003, 10), { pos: [0, SIGHT_Y, HOUSING_FRONT + 0.0026] });

  // --- trigger ---
  b.add(
    'trigger',
    'darkMetal',
    profileX(
      [
        [0.026, 0.012],
        [0.034, 0.012],
        [0.036, 0.0],
        [0.033, -0.012],
        [0.027, -0.016],
        [0.029, -0.004],
      ],
      0.007,
      { bevel: 0.001 },
    ),
    { paint: P.darkMetal.paint },
  );

  // --- charging handle (left, rides forward; locks back when empty) ---
  b.add('bolt', 'darkMetal', cylinderX(0.003, 0.012, 10), {
    pos: [-BODY_W / 2 - 0.005, 0.061, -0.19],
    paint: P.darkMetal.paint,
  });
  b.add('bolt', 'accentPaint', roundedBox(0.008, 0.013, 0.012, 0.0028), {
    pos: [-BODY_W / 2 - 0.012, 0.062, -0.19],
    paint: P.accentPaint.paint,
  });

  // --- magazine: smoked shell with the glowing round cells, rails, feed block and latch ---
  const magLen = MAG_REAR - MAG_FRONT;
  const magZ = (MAG_REAR + MAG_FRONT) / 2;
  b.add(
    'magazine',
    'magShell',
    profileZ(chamferRectProfile(MAG_W, MAG_H, 0.006, 0.003), magLen, { bevel: 0.002 }),
    {
      pos: [0, MAG_Y, magZ],
    },
  );
  // Rounds lie crosswise in the magazine; each readout cell is the glowing tip of one of them.
  const pitch = (magLen - 0.03) / CELLS;
  for (let i = 0; i < CELLS; i++) {
    const z = MAG_FRONT + 0.02 + (i + 0.5) * pitch;
    b.add('magazine', 'brass', cylinderX(ROUND_R, MAG_W - 0.018, 10), {
      pos: [0.003, MAG_Y + 0.001, z],
      paint: ROUND_TARNISH,
    });
    b.add('magazine', 'readout', new BoxGeometry(0.007, ROUND_R * 2.05, pitch * 0.6), {
      pos: [-(MAG_W / 2) + 0.0115, MAG_Y + 0.001, z],
      uv: ledUv(i, CELLS),
    });
  }
  for (const side of [-1, 1]) {
    b.add('magazine', 'darkMetal', new BoxGeometry(0.0035, 0.004, magLen - 0.01), {
      pos: [side * (MAG_W / 2 - 0.0012), MAG_Y - MAG_H / 2 + 0.0016, magZ],
      paint: P.darkMetal.paint,
    });
  }
  b.add('magazine', 'darkMetal', roundedBox(MAG_W + 0.001, MAG_H + 0.001, 0.016, 0.002), {
    pos: [0, MAG_Y, MAG_FRONT + 0.008],
    paint: P.darkMetal.paint,
  });
  b.add('magazine', 'darkMetal', roundedBox(MAG_W + 0.001, MAG_H + 0.001, 0.01, 0.002), {
    pos: [0, MAG_Y, MAG_REAR - 0.005],
    paint: P.darkMetal.paint,
  });
  b.add('magazine', 'accentPaint', roundedBox(0.022, 0.006, 0.012, 0.0015), {
    pos: [0, MAG_Y + MAG_H / 2 + 0.002, MAG_REAR - 0.004],
    paint: P.accentPaint.paint,
  });

  // --- sockets + attachment mounts ---
  b.socket('muzzle', [0, BORE_Y, MUZZLE_Z]);
  b.socket('ejectPort', [0, -0.116, 0.085], [-90, 0, 0]);
  b.socket('sight', [0, SIGHT_Y, HOUSING_REAR]);
  b.mount('optic', [0, HOUSING_TOP, hZ]);
  b.mount('muzzleDevice', [0, BORE_Y, MUZZLE_Z]);
  b.mount('underbarrel', [0, 0.017, -0.205]);
  b.mount('laser', [-BODY_W / 2 - 0.001, 0.036, -0.2], [0, 0, 90]);
  b.mount('stock', [0, -0.024, BUTT_Z + 0.009]);

  const built = b.build({ ...kit.materials, ...glow, magShell: shell });
  return new ProceduralWeaponModel('pdw', def, built, glow, readoutSpec, readout, [shell]);
};

/** Exposed for tests: the sight line height the model was built with. */
export const PDW_SIGHT_LINE = SIGHT_Y;
