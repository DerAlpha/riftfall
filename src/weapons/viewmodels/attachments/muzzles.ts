/**
 * Muzzle devices and barrels (mount space: origin at the barrel tip, −Z out of the muzzle). Each
 * reports its new muzzle point: the rig moves the muzzle socket there (flash, muzzle light,
 * tracer and projectile origins follow).
 */
import { BoxGeometry, TorusGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, type ModelBuilder } from '../ModelBuilder';
import { cylinderZ, latheZHard, profileZ, regularPolygonProfile, roundedBox, tubeZ } from '../shapes';
import type { AttachmentBuilder } from './types';

const P = VIEWMODEL_ART.materials;

/** Dark bore disc at the front face `z` (radius `r`). */
function bore(b: ModelBuilder, z: number, r: number): void {
  b.add(BODY, 'bore', cylinderZ(r, r, 0.0006, 14), { pos: [0, 0, z] });
}

export const buildSuppressor: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', cylinderZ(0.0105, 0.0105, 0.016, 20), {
    pos: [0, 0, -0.008],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0105, 0],
        [0.0166, 0.005],
        [0.0166, 0.15],
        [0.0138, 0.156],
        [0.0052, 0.156],
      ],
      28,
    ),
    { pos: [0, 0, -0.012], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'grip', tubeZ(0.0169, 0.0164, 0.032, 28), {
    pos: [0, 0, -0.03],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'accent', tubeZ(0.0168, 0.0164, 0.003, 28), { pos: [0, 0, -0.138] });
  bore(b, -0.1683, 0.0048);
  return { muzzle: [0, 0, -0.169] };
};

export const buildCompensator: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', profileZ(regularPolygonProfile(0.0118, 8, 22.5), 0.048, { bevel: 0.0008 }), {
    pos: [0, 0, -0.024],
    paint: P.darkMetal.paint,
  });
  for (const z of [-0.013, -0.024, -0.035]) {
    b.add(BODY, 'bore', new BoxGeometry(0.0085, 0.002, 0.0055), { pos: [0, 0.0105, z] });
    for (const s of [-1, 1]) {
      b.add(BODY, 'bore', new BoxGeometry(0.002, 0.005, 0.0055), { pos: [s * 0.0106, 0.003, z] });
    }
  }
  b.add(BODY, 'gunmetal', cylinderZ(0.0086, 0.0106, 0.004, 16), { pos: [0, 0, -0.05] });
  b.add(BODY, 'accent', tubeZ(0.0119, 0.0112, 0.002, 16), { pos: [0, 0, -0.004] });
  bore(b, -0.0521, 0.0045);
  return { muzzle: [0, 0, -0.053] };
};

export const buildMuzzleBrake: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', cylinderZ(0.011, 0.011, 0.012, 18), {
    pos: [0, 0, -0.006],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.034, 0.024, 0.062, 0.003), {
    pos: [0, 0, -0.043],
    paint: P.darkMetal.paint,
  });
  for (const z of [-0.024, -0.042, -0.06]) {
    for (const s of [-1, 1]) {
      b.add(BODY, 'bore', new BoxGeometry(0.0012, 0.016, 0.011), { pos: [s * 0.0172, 0, z] });
    }
  }
  b.add(BODY, 'bore', new BoxGeometry(0.02, 0.0012, 0.007), { pos: [0, 0.0121, -0.03] });
  b.add(BODY, 'gunmetal', roundedBox(0.036, 0.026, 0.006, 0.002), { pos: [0, 0, -0.075] });
  b.add(BODY, 'accent', new BoxGeometry(0.0344, 0.0244, 0.0015), { pos: [0, 0, -0.0135] });
  bore(b, -0.0782, 0.006);
  return { muzzle: [0, 0, -0.079] };
};

export const buildLongBarrel: AttachmentBuilder = (b) => {
  b.add(BODY, 'gunmetal', cylinderZ(0.0082, 0.0082, 0.11, 16), { pos: [0, 0, -0.055] });
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.022, 0.018, 0.002), {
    pos: [0, 0.004, -0.03],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', new BoxGeometry(0.004, 0.012, 0.006), { pos: [0, 0.0195, -0.03] });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0098, 0],
        [0.0098, 0.03],
        [0.0078, 0.032],
      ],
      18,
    ),
    { pos: [0, 0, -0.11], paint: P.darkMetal.paint },
  );
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * 360 + 45;
    const r = (a * Math.PI) / 180;
    b.add(BODY, 'bore', new BoxGeometry(0.002, 0.0012, 0.018), {
      pos: [Math.cos(r) * 0.0096, Math.sin(r) * 0.0096, -0.128],
      rot: [0, 0, a],
    });
  }
  b.add(BODY, 'accent', tubeZ(0.0084, 0.008, 0.002, 16), { pos: [0, 0, -0.07] });
  bore(b, -0.1425, 0.0052);
  return { muzzle: [0, 0, -0.143] };
};

export const buildShortBarrel: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', cylinderZ(0.0145, 0.0145, 0.034, 20), {
    pos: [0, 0, -0.017],
    paint: P.darkMetal.paint,
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * 360 + 30;
    const r = (a * Math.PI) / 180;
    b.add(BODY, 'bore', new BoxGeometry(0.0018, 0.004, 0.016), {
      pos: [Math.cos(r) * 0.0143, Math.sin(r) * 0.0143, -0.018],
      rot: [0, 0, a],
    });
  }
  b.add(BODY, 'gunmetal', tubeZ(0.0152, 0.009, 0.004, 20), { pos: [0, 0, -0.034] });
  b.add(BODY, 'accent', tubeZ(0.0148, 0.0145, 0.002, 20), { pos: [0, 0, -0.005] });
  bore(b, -0.0382, 0.006);
  return { muzzle: [0, 0, -0.039] };
};

export const buildChoke: AttachmentBuilder = (b) => {
  b.add(BODY, 'gunmetal', cylinderZ(0.0135, 0.0135, 0.04, 22), { pos: [0, 0, -0.02] });
  b.add(BODY, 'grip', tubeZ(0.0139, 0.0132, 0.014, 22), {
    pos: [0, 0, -0.005],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'accent', tubeZ(0.0138, 0.0134, 0.0022, 22), { pos: [0, 0, -0.03] });
  bore(b, -0.0405, 0.0092);
  return { muzzle: [0, 0, -0.041] };
};

/** Energy weapons: an emitter ring with three prongs around a glowing focusing lens. */
export const buildFocusLens: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', cylinderZ(0.012, 0.0145, 0.012, 20), {
    pos: [0, 0, -0.006],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', new TorusGeometry(0.019, 0.0034, 8, 32), { pos: [0, 0, -0.014] });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    b.add(BODY, 'darkMetal', new BoxGeometry(0.004, 0.004, 0.036), {
      pos: [Math.cos(a) * 0.019, Math.sin(a) * 0.019, -0.03],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'accent', new BoxGeometry(0.0042, 0.0042, 0.004), {
      pos: [Math.cos(a) * 0.019, Math.sin(a) * 0.019, -0.046],
    });
  }
  b.add(BODY, 'reticle', cylinderZ(0.0148, 0.0148, 0.0016, 28), { pos: [0, 0, -0.0145] });
  return { muzzle: [0, 0, -0.05] };
};
