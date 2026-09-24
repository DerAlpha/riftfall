/**
 * GLSL snippets shared by the arsenal renderers (glow sprites, strips, discs, charge glow): cheap
 * hash / value noise / fbm and polar helpers. Shader-internal constants (hash primes, octave
 * weights) live here by design.
 */

export const NOISE_GLSL = /* glsl */ `
float aHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float aNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = aHash(i);
  float b = aHash(i + vec2(1.0, 0.0));
  float c = aHash(i + vec2(0.0, 1.0));
  float d = aHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float aFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    v += amp * aNoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    amp *= 0.5;
  }
  return v;
}
// Thin bright ridges where the noise crosses 0.5 (electric filaments, frost veins).
float aRidge(float n, float sharpness) {
  return pow(1.0 - abs(n * 2.0 - 1.0), sharpness);
}
`;

/** Minimum on-screen size helper: meters per pixel at a view depth. */
export const PIXEL_GLSL = /* glsl */ `
float metersPerPixel(float depth, float viewportHeight) {
  return max(depth, 1e-3) / (projectionMatrix[1][1] * 0.5 * viewportHeight);
}
`;
