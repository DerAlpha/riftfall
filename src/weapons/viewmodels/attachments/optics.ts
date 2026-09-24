/**
 * Optic attachments (mount space: origin on the rail top, +Y up, −Z forward). Each reports its
 * sight point – the reticle center on its sight line – which the viewmodel rig aligns with the
 * view axis while aiming. Open sights (reflex, red dot, holo) keep the weapon's eye distance; the
 * magnified ones (ACOG, 4× scope, thermal) are real sighting devices like the HX-50 scope: the eye
 * sits right behind the ocular, a depth-only mask disk just in front of the reticle hides their
 * own interior and the gun behind it, so the ocular is a clean window onto the zoomed world.
 */
import { BoxGeometry, CylinderGeometry, PlaneGeometry, TorusGeometry } from 'three';
import { ATTACHMENT_ART } from '../../../defs/weaponOutfit';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, type ModelBuilder } from '../ModelBuilder';
import { chamferRectProfile, cylinderX, cylinderZ, latheZHard, profileZ, roundedBox, tubeZ } from '../shapes';
import type { AttachmentBuilder } from './types';

const P = VIEWMODEL_ART.materials;
const RETICLE_DEPTH = 0.0002;

/** Chevron reticle (apex at the sight point) on the plane z. */
function chevron(b: ModelBuilder, y: number, z: number, arm: number, width: number): void {
  const a = (35 * Math.PI) / 180;
  const cx = (Math.cos(a) * arm) / 2;
  const cy = (Math.sin(a) * arm) / 2;
  for (const s of [-1, 1]) {
    b.add(BODY, 'reticle', new BoxGeometry(arm, width, RETICLE_DEPTH), {
      pos: [s * cx, y - cy, z],
      rot: [0, 0, s * -35],
    });
  }
}

/** Duplex crosshair: black outer posts, a fine illuminated center cross and dot (the 4× scope). */
function crosshair(b: ModelBuilder, y: number, z: number, inner: number, edge: number): void {
  const fine = 0.00011;
  const post = 0.00045;
  b.add(BODY, 'reticle', new BoxGeometry(inner * 2, fine, RETICLE_DEPTH), { pos: [0, y, z] });
  b.add(BODY, 'reticle', new BoxGeometry(fine, inner * 2, RETICLE_DEPTH), { pos: [0, y, z] });
  for (const s of [-1, 1]) {
    b.add(BODY, 'bore', new BoxGeometry(edge - inner, post, RETICLE_DEPTH), {
      pos: [(s * (inner + edge)) / 2, y, z],
    });
    b.add(BODY, 'bore', new BoxGeometry(post, edge - inner, RETICLE_DEPTH), {
      pos: [0, y + (s * (inner + edge)) / 2, z],
    });
  }
  b.add(BODY, 'reticle', cylinderZ(0.00032, 0.00032, RETICLE_DEPTH, 10), { pos: [0, y, z + 0.0001] });
}

/** Ocular window of a magnified optic: tint, dark edge ring, reticle plane, then the mask behind. */
function ocular(b: ModelBuilder, y: number, z: number, r: number): void {
  b.add(BODY, 'lensTint', cylinderZ(r, r, 0.0003, 32), { pos: [0, y, z + 0.0006] });
  b.add(BODY, 'bore', tubeZ(r, r - 0.0022, 0.0004, 32), { pos: [0, y, z + 0.0002] });
  b.add(BODY, 'mask', cylinderZ(r, r, 0.0002, 32), { pos: [0, y, z - 0.0022] });
}

/** Mini reflex sight (pistol slides): open window, green chevron. */
export const buildReflex: AttachmentBuilder = (b) => {
  const SY = 0.0165;
  const WZ = -0.008;
  b.add(BODY, 'darkMetal', roundedBox(0.024, 0.005, 0.032, 0.0012), {
    pos: [0, 0.0025, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'polymer', roundedBox(0.021, 0.007, 0.018, 0.0015), {
    pos: [0, 0.0085, 0.006],
    paint: P.polymer.paint,
  });
  for (const s of [-1, 1]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0032, 0.022, 0.007, 0.0008), {
      pos: [s * 0.0106, 0.0155, WZ],
      paint: P.darkMetal.paint,
    });
  }
  b.add(BODY, 'darkMetal', roundedBox(0.0244, 0.0034, 0.008, 0.0008), {
    pos: [0, 0.0272, WZ],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.012, 0.0008, 0.004), { pos: [0, 0.0293, WZ] });
  b.add(BODY, 'lensTint', new PlaneGeometry(0.018, 0.019), { pos: [0, SY + 0.0005, WZ], uv: 'keep' });
  // LED emitter at the back of the window.
  b.add(BODY, 'reticle', new BoxGeometry(0.002, 0.0016, 0.0016), { pos: [0, 0.0065, 0.0012] });
  chevron(b, SY, WZ + 0.0004, 0.0024, 0.00045);
  return { sight: [0, SY, WZ + 0.0004] };
};

/** Tube red dot on a riser. */
export const buildRedDot: AttachmentBuilder = (b) => {
  const SY = 0.027;
  const LZ = -0.0195;
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.013, 0.03, 0.0015), {
    pos: [0, 0.0065, 0.002],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', cylinderX(0.0026, 0.027, 10), { pos: [0, 0.0045, -0.006] });
  b.add(BODY, 'darkMetal', tubeZ(0.0142, 0.0118, 0.046, 28), {
    pos: [0, SY, 0.023],
    paint: P.darkMetal.paint,
  });
  const ring = latheZHard(
    [
      [0.0118, 0],
      [0.0156, 0],
      [0.0156, 0.006],
      [0.0118, 0.006],
    ],
    28,
  );
  b.add(BODY, 'gunmetal', ring, { pos: [0, SY, -0.017] });
  b.add(BODY, 'gunmetal', ring.clone(), { pos: [0, SY, 0.023] });
  b.add(BODY, 'accent', tubeZ(0.0145, 0.0142, 0.0022, 28), { pos: [0, SY, 0.004] });
  b.add(BODY, 'gunmetal', cylinderX(0.0065, 0.008, 16), { pos: [0.0175, SY, 0.004] });
  b.add(BODY, 'accent', cylinderX(0.0066, 0.0014, 16), { pos: [0.0222, SY, 0.004] });
  b.add(BODY, 'lensTint', cylinderZ(0.0118, 0.0118, 0.0004, 28), { pos: [0, SY, LZ - 0.0006] });
  b.add(BODY, 'reticle', cylinderZ(0.00062, 0.00062, RETICLE_DEPTH, 12), { pos: [0, SY, LZ] });
  return { sight: [0, SY, LZ] };
};

/** Holographic sight: boxy hood over a flat window, cyan ring + dot. */
export const buildHolo: AttachmentBuilder = (b) => {
  const SY = 0.03;
  const WZ = -0.0238;
  b.add(BODY, 'darkMetal', roundedBox(0.03, 0.013, 0.056, 0.002), {
    pos: [0, 0.0065, 0.002],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'polymer', cylinderX(0.0072, 0.031, 16), { pos: [0, 0.009, 0.019] });
  for (const s of [-1, 1]) {
    b.add(BODY, 'darkMetal', roundedBox(0.0036, 0.034, 0.037, 0.001), {
      pos: [s * 0.0168, 0.03, -0.008],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'gunmetal', new BoxGeometry(0.004, 0.0035, 0.004), { pos: [s * 0.006, 0.0112, 0.031] });
  }
  b.add(BODY, 'darkMetal', roundedBox(0.0372, 0.0036, 0.039, 0.001), {
    pos: [0, 0.0475, -0.008],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.022, 0.0008, 0.028), { pos: [0, 0.0497, -0.008] });
  b.add(BODY, 'lensTint', new PlaneGeometry(0.0302, 0.0304), {
    pos: [0, SY + 0.0007, WZ - 0.0004],
    uv: 'keep',
  });
  b.add(BODY, 'reticle', new TorusGeometry(0.0034, 0.00021, 4, 40), { pos: [0, SY, WZ] });
  b.add(BODY, 'reticle', cylinderZ(0.00045, 0.00045, RETICLE_DEPTH, 10), { pos: [0, SY, WZ] });
  return { sight: [0, SY, WZ] };
};

/** 2.5× prism sight with a fiber-optic strip on top, amber chevron. */
export const buildAcog: AttachmentBuilder = (b) => {
  const SY = 0.028;
  const OZ = 0.033;
  const OR = 0.0108;
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.012, 0.042, 0.0015), {
    pos: [0, 0.006, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', cylinderX(0.0045, 0.004, 12), { pos: [-0.0122, 0.006, -0.01] });
  b.add(BODY, 'gunmetal', cylinderX(0.0045, 0.004, 12), { pos: [-0.0122, 0.006, 0.012] });
  b.add(BODY, 'darkMetal', profileZ(chamferRectProfile(0.03, 0.027, 0.006), 0.036, { bevel: 0.001 }), {
    pos: [0, SY, 0.001],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0125, 0],
        [0.0182, 0.004],
        [0.0182, 0.024],
        [0.0165, 0.027],
        [0.0125, 0.027],
      ],
      28,
    ),
    { pos: [0, SY, -0.016], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'lensTint', cylinderZ(0.0166, 0.0166, 0.0004, 28), { pos: [0, SY, -0.0415] });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [OR, 0],
        [0.0138, 0],
        [0.0138, 0.017],
        [OR, 0.017],
      ],
      28,
    ),
    { pos: [0, SY, OZ + 0.002], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'reticle', new BoxGeometry(0.0034, 0.0022, 0.03), { pos: [0, SY + 0.0145, -0.002] });
  b.add(BODY, 'accent', new BoxGeometry(0.031, 0.0008, 0.004), { pos: [0, SY + 0.0082, 0.012] });
  ocular(b, SY, OZ, OR);
  chevron(b, SY, OZ, 0.0021, 0.0003);
  b.add(BODY, 'reticle', new BoxGeometry(0.0003, 0.0024, RETICLE_DEPTH), { pos: [0, SY - 0.0023, OZ] });
  return { sight: [0, SY, OZ], eyeDistance: ATTACHMENT_ART.eyeRelief.acog };
};

/** 4× rifle scope in two rings: turrets, bells, red crosshair. */
export const buildScope4x: AttachmentBuilder = (b) => {
  const SY = 0.034;
  const RZ = 0.0852;
  const OR = 0.0142;
  for (const z of [0.024, -0.03]) {
    b.add(BODY, 'darkMetal', roundedBox(0.018, 0.01, 0.012, 0.0015), {
      pos: [0, 0.005, z],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'darkMetal', new BoxGeometry(0.011, SY - 0.0128 - 0.009, 0.01), {
      pos: [0, 0.009 + (SY - 0.0128 - 0.009) / 2, z],
      paint: P.darkMetal.paint,
    });
    b.add(BODY, 'gunmetal', tubeZ(0.0158, 0.0128, 0.011, 28), { pos: [0, SY, z + 0.0055] });
    b.add(BODY, 'gunmetal', cylinderX(0.0022, 0.036, 8), { pos: [0, SY - 0.0165, z] });
  }
  b.add(BODY, 'darkMetal', tubeZ(0.0128, 0.0115, 0.1, 28), { pos: [0, SY, 0.048], paint: P.darkMetal.paint });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0128, 0],
        [0.0202, 0.02],
        [0.0202, 0.042],
        [0.0186, 0.045],
        [0.0156, 0.045],
      ],
      32,
    ),
    { pos: [0, SY, -0.045], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'lensTint', cylinderZ(0.0186, 0.0186, 0.0004, 28), { pos: [0, SY, -0.088] });
  b.add(BODY, 'bore', cylinderZ(0.0184, 0.0184, 0.0004, 28), { pos: [0, SY, -0.08] });
  b.add(
    BODY,
    'darkMetal',
    latheZHard(
      [
        [0.0166, 0],
        [0.0166, 0.02],
        [0.0128, 0.032],
      ],
      32,
    ),
    { pos: [0, SY, 0.08], paint: P.darkMetal.paint },
  );
  b.add(BODY, 'bore', tubeZ(0.0172, OR, 0.0075, 32), { pos: [0, SY, 0.0875] });
  b.add(BODY, 'accent', tubeZ(0.0204, 0.0198, 0.0025, 32), { pos: [0, SY, -0.058] });
  // Elevation (top) and windage (right) turrets with knurled caps.
  b.add(BODY, 'darkMetal', new CylinderGeometry(0.0072, 0.0078, 0.011, 18), { pos: [0, SY + 0.0175, 0.0] });
  b.add(BODY, 'grip', new CylinderGeometry(0.0082, 0.0082, 0.006, 20), {
    pos: [0, SY + 0.025, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'darkMetal', cylinderX(0.0072, 0.011, 18), { pos: [0.0175, SY, 0] });
  b.add(BODY, 'grip', cylinderX(0.0082, 0.006, 20), {
    pos: [0.025, SY, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  ocular(b, SY, RZ, OR);
  crosshair(b, SY, RZ, 0.0038, OR - 0.0024);
  return { sight: [0, SY, RZ], eyeDistance: ATTACHMENT_ART.eyeRelief.scope4x };
};

/** Thermal sight: boxy imager, germanium objective, amber-tinted eyepiece. */
export const buildThermal: AttachmentBuilder = (b) => {
  const SY = 0.03;
  const OZ = 0.0525;
  const OR = 0.0124;
  b.add(BODY, 'darkMetal', roundedBox(0.022, 0.01, 0.05, 0.0015), {
    pos: [0, 0.005, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'polymer', roundedBox(0.043, 0.041, 0.076, 0.005), {
    pos: [0, SY, -0.004],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'darkMetal', cylinderZ(0.0195, 0.0195, 0.013, 28), {
    pos: [0, SY, -0.047],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'bore', cylinderZ(0.016, 0.016, 0.0004, 28), { pos: [0, SY, -0.0532] });
  b.add(BODY, 'lensTint', cylinderZ(0.0166, 0.0166, 0.0004, 28), { pos: [0, SY, -0.0538] });
  b.add(BODY, 'grip', tubeZ(0.0152, OR, 0.022, 28), {
    pos: [0, SY, 0.056],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  for (let i = 0; i < 3; i++) {
    b.add(BODY, 'gunmetal', new CylinderGeometry(0.0032, 0.0032, 0.003, 10), {
      pos: [-0.008 + i * 0.008, SY + 0.0215, 0.012],
    });
  }
  b.add(BODY, 'reticle', new BoxGeometry(0.0012, 0.0024, 0.018), { pos: [-0.0218, SY + 0.008, 0.004] });
  b.add(BODY, 'accent', new BoxGeometry(0.0008, 0.03, 0.05), { pos: [0.0218, SY, -0.004] });
  ocular(b, SY, OZ, OR);
  chevron(b, SY, OZ, 0.0019, 0.0003);
  b.add(BODY, 'reticle', new TorusGeometry(0.0046, 0.00016, 4, 36), { pos: [0, SY, OZ] });
  return { sight: [0, SY, OZ], eyeDistance: ATTACHMENT_ART.eyeRelief.thermal };
};
