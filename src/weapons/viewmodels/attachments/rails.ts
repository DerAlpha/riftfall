/**
 * Rail attachments: underbarrel grips (mount on the rail's bottom face, +Y up: they hang towards
 * −Y), stock kits (rear of the receiver, +Z back) and lasers (+Y out of the side / top rail, −Z
 * forward: the beam leaves the emitter along −Z).
 */
import { BoxGeometry, CylinderGeometry, TorusGeometry } from 'three';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY } from '../ModelBuilder';
import { cylinderZ, profileX, roundedBox, tubeZ } from '../shapes';
import type { AttachmentBuilder } from './types';

const P = VIEWMODEL_ART.materials;

export const buildVertGrip: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', roundedBox(0.022, 0.009, 0.034, 0.0015), {
    pos: [0, -0.0045, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'grip', new CylinderGeometry(0.0106, 0.0118, 0.07, 18), {
    pos: [0, -0.044, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  for (const y of [-0.03, -0.047, -0.064]) {
    b.add(BODY, 'polymer', new TorusGeometry(0.0115, 0.0012, 6, 20), { pos: [0, y, 0], rot: [90, 0, 0] });
  }
  b.add(BODY, 'darkMetal', new CylinderGeometry(0.0128, 0.0124, 0.007, 18), {
    pos: [0, -0.082, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'accent', new CylinderGeometry(0.0118, 0.0118, 0.0025, 18), { pos: [0, -0.0125, 0] });
  return {};
};

export const buildAngleGrip: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', roundedBox(0.022, 0.006, 0.064, 0.0015), {
    pos: [0, -0.003, 0],
    paint: P.darkMetal.paint,
  });
  b.add(
    BODY,
    'polymer',
    profileX(
      [
        [0.03, -0.004],
        [-0.03, -0.004],
        [-0.026, -0.03],
        [-0.017, -0.036],
        [0.02, -0.012],
      ],
      0.02,
      { bevel: 0.0025 },
    ),
    { pos: [0, 0, 0], paint: P.polymer.paint },
  );
  b.add(BODY, 'grip', new BoxGeometry(0.0205, 0.024, 0.004), {
    pos: [0, -0.022, -0.0265],
    rot: [-12, 0, 0],
    uvDensity: VIEWMODEL_ART.knurlDensity,
  });
  b.add(BODY, 'accent', new BoxGeometry(0.021, 0.0016, 0.03), { pos: [0, -0.0072, 0.006] });
  return {};
};

/** Gyro stabilizer: a ring guard around a spinning glowing gyro wheel. */
export const buildStabilizer: AttachmentBuilder = (b) => {
  const GY = -0.037;
  b.part('gyro', [0, GY, 0]);
  b.add(BODY, 'darkMetal', roundedBox(0.022, 0.008, 0.032, 0.0015), {
    pos: [0, -0.004, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', new BoxGeometry(0.01, 0.014, 0.014), {
    pos: [0, -0.014, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', tubeZ(0.0205, 0.0172, 0.046, 28), {
    pos: [0, GY, 0.023],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', cylinderZ(0.0055, 0.0055, 0.044, 12), { pos: [0, GY, 0] });
  b.add('gyro', 'accent', new TorusGeometry(0.0138, 0.0021, 8, 30), { pos: [0, GY, 0] });
  for (let i = 0; i < 3; i++) {
    b.add('gyro', 'gunmetal', new BoxGeometry(0.0026, 0.0136, 0.003), {
      pos: [0, GY, 0],
      rot: [0, 0, i * 120],
    });
  }
  return { spinner: { part: 'gyro', axis: 'z' } };
};

/** Skeleton stock kit: twin rods to a slim butt plate. */
export const buildLightStock: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', roundedBox(0.02, 0.024, 0.02, 0.002), {
    pos: [0, -0.006, 0.01],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', cylinderZ(0.0038, 0.0038, 0.15, 10), { pos: [0, 0.004, 0.085] });
  b.add(BODY, 'gunmetal', cylinderZ(0.0038, 0.0038, 0.14, 10), { pos: [0, -0.03, 0.08], rot: [-6, 0, 0] });
  for (const z of [0.055, 0.115])
    b.add(BODY, 'darkMetal', new BoxGeometry(0.005, 0.036, 0.005), { pos: [0, -0.013, z] });
  b.add(BODY, 'polymer', roundedBox(0.022, 0.086, 0.013, 0.003), {
    pos: [0, -0.016, 0.163],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.024, 0.09, 0.008, 0.003), { pos: [0, -0.016, 0.172] });
  b.add(BODY, 'accent', new BoxGeometry(0.0012, 0.0012, 0.1), { pos: [0.0038, 0.004, 0.09] });
  return {};
};

/** Heavy stock kit: buffer tube, cheek riser, counterweight and a thick recoil pad. */
export const buildHeavyStock: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', cylinderZ(0.0145, 0.0145, 0.13, 20), {
    pos: [0, 0, 0.065],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'polymer', roundedBox(0.03, 0.02, 0.085, 0.004), {
    pos: [0, 0.021, 0.09],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'polymer', roundedBox(0.03, 0.058, 0.07, 0.005), {
    pos: [0, -0.029, 0.112],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'darkMetal', roundedBox(0.032, 0.02, 0.032, 0.003), {
    pos: [0, -0.062, 0.1],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'grip', roundedBox(0.036, 0.11, 0.028, 0.006), { pos: [0, -0.016, 0.158] });
  b.add(BODY, 'accent', new BoxGeometry(0.0305, 0.0016, 0.05), { pos: [0, 0.0115, 0.09] });
  return {};
};

/** Compact laser box: red emitter (+ a dark IR window). */
export const buildTacticalLaser: AttachmentBuilder = (b) => {
  b.add(BODY, 'darkMetal', roundedBox(0.018, 0.006, 0.024, 0.0012), {
    pos: [0, 0.003, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'polymer', roundedBox(0.022, 0.017, 0.038, 0.002), {
    pos: [0, 0.0145, -0.002],
    paint: P.polymer.paint,
  });
  b.add(BODY, 'laser', cylinderZ(0.0031, 0.0031, 0.001, 14), { pos: [0.0045, 0.0145, -0.0213] });
  b.add(BODY, 'bore', cylinderZ(0.0028, 0.0028, 0.001, 14), { pos: [-0.005, 0.0145, -0.0213] });
  b.add(BODY, 'accent', new BoxGeometry(0.006, 0.0015, 0.006), { pos: [0, 0.0235, 0.011] });
  return { emitter: [0.0045, 0.0145, -0.022] };
};

/** Long laser module: green emitter with a visible beam. */
export const buildTargetLaser: AttachmentBuilder = (b) => {
  const Y = 0.0155;
  b.add(BODY, 'darkMetal', roundedBox(0.018, 0.006, 0.03, 0.0012), {
    pos: [0, 0.003, 0],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'darkMetal', cylinderZ(0.0095, 0.0095, 0.062, 18), {
    pos: [0, Y, -0.006],
    paint: P.darkMetal.paint,
  });
  b.add(BODY, 'gunmetal', cylinderZ(0.0106, 0.0106, 0.008, 18), { pos: [0, Y, -0.038] });
  b.add(BODY, 'laser', cylinderZ(0.0043, 0.0043, 0.001, 14), { pos: [0, Y, -0.0425] });
  b.add(BODY, 'accent', tubeZ(0.0097, 0.0094, 0.002, 18), { pos: [0, Y, 0.012] });
  b.add(BODY, 'gunmetal', new BoxGeometry(0.004, 0.003, 0.008), { pos: [0, Y + 0.0105, 0.01] });
  return { emitter: [0, Y, -0.043] };
};
