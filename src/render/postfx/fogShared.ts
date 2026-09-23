/**
 * Height-fog parameters and GLSL shared by HeightFogEffect and the world shaders drawn after the
 * fog pass (the additive volumetrics, see VolumetricPass). Those cannot be fogged by the post
 * effect – it only knows the depth of the opaque surface behind them – so they multiply themselves
 * by the fog transmittance to their own position instead.
 *
 * No postprocessing import here: the vfx modules (and their node tests) include this file.
 */
import * as THREE from 'three';
import { POSTFX } from '../../defs/postfx';

/**
 * x: density at base height, y: height falloff (1/m), z: base height (m), w: max fog distance (m).
 * One Uniform object shared by reference, so HeightFogEffect.setFog updates every consumer.
 */
export const HEIGHT_FOG_PARAMS = new THREE.Uniform(
  new THREE.Vector4(0, 0.2, 0, POSTFX.heightFog.maxSkyDistance),
);

/** Declares `fogParams`; defines fogHeightDensity, fogOpticalDepth and fogTransmittance. */
export const HEIGHT_FOG_GLSL = /* glsl */ `
uniform vec4 fogParams;

// Height density factor; the exponent is capped so points far below the base height cannot overflow.
float fogHeightDensity(float y) {
  return exp(min(-fogParams.y * (y - fogParams.z), 60.0));
}

// Closed-form optical depth of exponential height fog from ro along unit rd over dist.
float fogOpticalDepth(vec3 ro, vec3 rd, float dist) {
  float base = fogParams.x * fogHeightDensity(ro.y);
  // Lower bound avoids exp() overflow (inf/NaN) for long rays diving into dense fog.
  float k = max(fogParams.y * rd.y * dist, -60.0);
  // (1 - e^-k) / k with a series fallback near k = 0 (horizontal rays).
  float shape = abs(k) > 1e-3 ? (1.0 - exp(-k)) / k : 1.0 - 0.5 * k;
  return base * dist * shape;
}

// Fraction of light from p that reaches camPos through the (noise-free) height fog.
float fogTransmittance(vec3 camPos, vec3 p) {
  vec3 ray = p - camPos;
  float len = length(ray);
  return exp(-fogOpticalDepth(camPos, ray / max(len, 1e-5), min(len, fogParams.w)));
}
`;
