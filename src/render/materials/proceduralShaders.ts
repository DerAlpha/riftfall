/**
 * GLSL sources for the GPU texture synthesis (see ProceduralTextureGenerator).
 *
 * Every generator shader is COMMON + generator body + MAIN. It is rendered in several passes:
 *   0 height  → float target (Nearest, Repeat), consumed by the normal pass and by the others
 *               for curvature (edge wear) and cavity AO (grime);
 *   1 albedo  → sRGB target (the GPU encodes on write);
 *   2 ORM     → R = AO, G = roughness, B = metalness (glTF convention);
 *   3 emissive (only generators flagged `emissive`).
 * All noise is sampled on periodic lattices (integer periods over uv ∈ [0,1)) so every map
 * tiles seamlessly; layouts use integer cell counts per repeat for the same reason.
 * Lengths given in mm/m are converted with uMeters (meters per texture repeat).
 */
import type { GeneratorId } from '../../defs/materials';

export const PASS_HEIGHT = 0;
export const PASS_ALBEDO = 1;
export const PASS_ORM = 2;
export const PASS_EMISSIVE = 3;

export const FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Normal map from the height field by central differences (OpenGL convention, +Y = +V). */
export const NORMAL_FRAGMENT = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uHeightTex;
uniform vec2 uTexel;
uniform float uStrength;
void main() {
  float hl = texture2D(uHeightTex, vUv - vec2(uTexel.x, 0.0)).r;
  float hr = texture2D(uHeightTex, vUv + vec2(uTexel.x, 0.0)).r;
  float hd = texture2D(uHeightTex, vUv - vec2(0.0, uTexel.y)).r;
  float hu = texture2D(uHeightTex, vUv + vec2(0.0, uTexel.y)).r;
  // uStrength converts height units per texel into a tangent-space slope.
  vec2 slope = vec2(hr - hl, hu - hd) * 0.5 * uStrength;
  vec3 n = normalize(vec3(-slope, 1.0));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;

const COMMON = /* glsl */ `
varying vec2 vUv;
uniform int uPass;
uniform float uSeed;
uniform float uMeters;
uniform vec2 uTexel;
uniform sampler2D uHeightTex;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform vec2 uCells;
uniform float uSeamMm;
uniform float uBevelMm;
uniform float uWear;
uniform float uGrime;
uniform float uScratches;
uniform float uRough;
uniform float uRoughVar;
uniform float uMetal;
uniform float uBareMetal;
uniform float uColorVar;
uniform vec4 uDetail;
uniform vec2 uAoRadius;

#define PI 3.14159265359
#define TAU 6.28318530718

float mm(float v) { return v * 0.001 / uMeters; }
float aaw() { return uTexel.x * 1.25; }

// Hash without sine (Dave Hoskins) – stable across GPUs.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
vec2 seedOff(float k) {
  return vec2(fract(uSeed * 0.1731) * 97.0 + k * 31.71, fract(uSeed * 0.0917) * 89.0 + k * 13.17);
}
float rnd(vec2 id, float k) { return hash12(id + seedOff(k)); }

// Periodic value noise: p in lattice units, period in cells (integers).
float valueNoise(vec2 p, vec2 period, float k) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 s = seedOff(k);
  float a = hash12(mod(i, period) + s);
  float b = hash12(mod(i + vec2(1.0, 0.0), period) + s);
  float c = hash12(mod(i + vec2(0.0, 1.0), period) + s);
  float d = hash12(mod(i + vec2(1.0, 1.0), period) + s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Periodic gradient noise, roughly [-1, 1].
float gradNoise(vec2 p, vec2 period, float k) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 s = seedOff(k);
  vec2 ga = hash22(mod(i, period) + s) * 2.0 - 1.0;
  vec2 gb = hash22(mod(i + vec2(1.0, 0.0), period) + s) * 2.0 - 1.0;
  vec2 gc = hash22(mod(i + vec2(0.0, 1.0), period) + s) * 2.0 - 1.0;
  vec2 gd = hash22(mod(i + vec2(1.0, 1.0), period) + s) * 2.0 - 1.0;
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 1.414;
}

// Tileable fBm over uv ∈ [0,1): freq is the integer base period per axis. Returns ~[-1, 1].
float fbm2(vec2 uv, vec2 freq, int octaves, float k) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  vec2 f = floor(freq + 0.5);
  for (int o = 0; o < 8; o++) {
    if (o >= octaves) break;
    sum += amp * gradNoise(uv * f, f, k + float(o) * 1.37);
    norm += amp;
    amp *= 0.5;
    f *= 2.0;
  }
  return sum / norm;
}
float fbm(vec2 uv, float freq, int octaves, float k) { return fbm2(uv, vec2(freq), octaves, k); }
float fbm01(vec2 uv, float freq, int octaves, float k) { return fbm(uv, freq, octaves, k) * 0.5 + 0.5; }

// Periodic Voronoi: x = F1, y = F2 (cell units), z = cell hash.
vec3 voronoi(vec2 uv, vec2 period, float k) {
  vec2 p = uv * period;
  vec2 i = floor(p);
  vec2 f = p - i;
  float f1 = 8.0;
  float f2 = 8.0;
  float id = 0.0;
  vec2 s = seedOff(k);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = mod(i + g, period);
      vec2 r = g + hash22(cell + s) - f;
      float d = dot(r, r);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash12(cell + s + 5.3);
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}
float sdRoundBox(vec2 p, vec2 b, float r) { return sdBox(p, b - vec2(r)) - r; }
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
// 1 inside (d < 0), 0 outside, antialiased over w.
float fillAA(float d, float w) { return 1.0 - smoothstep(-w, w, d); }

// 7-segment digit coverage. p ∈ [0,1]² (y up), t = stroke half width, w = AA width (glyph units).
int digitMask(int d) {
  if (d == 0) return 63;
  if (d == 1) return 6;
  if (d == 2) return 91;
  if (d == 3) return 79;
  if (d == 4) return 102;
  if (d == 5) return 109;
  if (d == 6) return 125;
  if (d == 7) return 7;
  if (d == 8) return 127;
  return 111;
}
float digit7(vec2 p, int d, float t, float w) {
  int m = digitMask(d);
  vec2 A = vec2(0.18, 0.9);
  vec2 B = vec2(0.82, 0.9);
  vec2 C = vec2(0.82, 0.5);
  vec2 D = vec2(0.82, 0.1);
  vec2 E = vec2(0.18, 0.1);
  vec2 F = vec2(0.18, 0.5);
  float dist = 10.0;
  if ((m & 1) != 0) dist = min(dist, sdSegment(p, A, B));
  if ((m & 2) != 0) dist = min(dist, sdSegment(p, B, C));
  if ((m & 4) != 0) dist = min(dist, sdSegment(p, C, D));
  if ((m & 8) != 0) dist = min(dist, sdSegment(p, E, D));
  if ((m & 16) != 0) dist = min(dist, sdSegment(p, F, E));
  if ((m & 32) != 0) dist = min(dist, sdSegment(p, A, F));
  if ((m & 64) != 0) dist = min(dist, sdSegment(p, F, C));
  return fillAA(dist - t, w);
}

// Fine scratches: thin line fragments in two directions (axis + diagonal lattice keep tiling).
float scratchLines(vec2 uv, float k) {
  float s = 0.0;
  float n1 = valueNoise(uv * vec2(14.0, 330.0), vec2(14.0, 330.0), k);
  float m1 = valueNoise(uv * 10.0, vec2(10.0), k + 1.0);
  s += smoothstep(0.955, 0.99, n1) * smoothstep(0.45, 0.8, m1);
  vec2 d = vec2(uv.x + uv.y, uv.x - uv.y);
  float n2 = valueNoise(d * vec2(9.0, 260.0), vec2(9.0, 260.0), k + 2.0);
  float m2 = valueNoise(uv * 7.0, vec2(7.0), k + 3.0);
  s += smoothstep(0.96, 0.99, n2) * smoothstep(0.5, 0.85, m2);
  float n3 = valueNoise(d.yx * vec2(11.0, 300.0), vec2(11.0, 300.0), k + 4.0);
  s += smoothstep(0.965, 0.992, n3) * smoothstep(0.5, 0.8, m1);
  return clamp(s, 0.0, 1.0);
}

float H(vec2 uv) { return texture2D(uHeightTex, uv).r; }

// Laplacian of the height: > 0 concave (crevices), < 0 convex (edges).
float curvatureAt(vec2 uv) {
  float r = max(uTexel.x * 1.5, mm(4.0));
  float h0 = H(uv);
  float s = H(uv + vec2(r, 0.0)) + H(uv - vec2(r, 0.0)) + H(uv + vec2(0.0, r)) + H(uv - vec2(0.0, r));
  float s2 = H(uv + vec2(r, r)) + H(uv - vec2(r, r)) + H(uv + vec2(r, -r)) + H(uv - vec2(r, -r));
  return (s * 0.15 + s2 * 0.1) - h0;
}

// Cavity AO from the height field (two rings of 8 samples).
float cavityAO(vec2 uv) {
  float h0 = H(uv);
  float r1 = max(uAoRadius.x / uMeters, uTexel.x * 2.0);
  float r2 = max(uAoRadius.y / uMeters, uTexel.x * 5.0);
  float occ = 0.0;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398 + 0.3927;
    vec2 d = vec2(cos(a), sin(a));
    occ += max(0.0, H(uv + d * r1) - h0);
    occ += max(0.0, H(uv + d * r2) - h0) * 0.6;
  }
  return clamp(1.0 - occ * 0.32, 0.0, 1.0);
}

// Generic weathering helpers.
float edgeWearMask(vec2 uv, float curv, float amount, float k) {
  float n = fbm01(uv, 16.0, 5, k);
  float convex = clamp(-curv * 16.0, 0.0, 1.0);
  float w = smoothstep(0.22, 0.55, convex * (0.35 + n) * (0.5 + amount * 1.5));
  float chips = smoothstep(0.8, 0.84, fbm01(uv, 10.0, 5, k + 3.0) + amount * 0.12) * amount;
  return clamp(max(w, chips), 0.0, 1.0);
}
float grimeMask(vec2 uv, float ao, float amount, float k) {
  float n = fbm01(uv, 5.0, 5, k);
  float cav = 1.0 - ao;
  return clamp((cav * 1.7 + (n - 0.5) * 0.9 + 0.1) * amount, 0.0, 1.0);
}
vec3 applyGrime(vec3 albedo, float g) {
  vec3 dirt = albedo * vec3(0.34, 0.3, 0.26);
  return mix(albedo, dirt, g);
}
`;

const MAIN = /* glsl */ `
void main() {
  vec2 uv = vUv;
  if (uPass == 0) {
    gl_FragColor = vec4(genHeight(uv), 0.0, 0.0, 1.0);
    return;
  }
  float h = H(uv);
  float curv = curvatureAt(uv);
  float ao = cavityAO(uv);
  vec3 albedo = vec3(0.5);
  float rough = 0.5;
  float metal = 0.0;
  vec3 emissive = vec3(0.0);
  genSurface(uv, h, curv, ao, albedo, rough, metal, emissive);
  if (uPass == 1) {
    gl_FragColor = vec4(clamp(albedo, 0.0, 1.0), 1.0);
  } else if (uPass == 2) {
    gl_FragColor = vec4(clamp(ao, 0.0, 1.0), clamp(rough, 0.04, 1.0), clamp(metal, 0.0, 1.0), 1.0);
  } else {
    gl_FragColor = vec4(clamp(emissive, 0.0, 1.0), 1.0);
  }
}
`;

// ---------------------------------------------------------------------------
// Generators. Each defines genHeight(uv) and genSurface(...).
// ---------------------------------------------------------------------------

const PANEL = /* glsl */ `
struct Panel { vec2 local; vec2 halfSize; vec2 id; float rnd; float d; };

Panel panelAt(vec2 uv) {
  vec2 cells = max(floor(uCells + 0.5), vec2(1.0));
  vec2 cid = floor(uv * cells);
  vec2 cuv = fract(uv * cells);
  vec2 csize = 1.0 / cells;
  vec2 lo = vec2(0.0);
  vec2 hi = vec2(1.0);
  vec2 sub = vec2(0.0);
  if (rnd(cid, 1.0) < uDetail.y) {
    bool splitX = csize.x > csize.y || (csize.x == csize.y && rnd(cid, 2.0) > 0.5);
    float cut = rnd(cid, 3.0) > 0.6 ? 0.3333 : 0.5;
    if (splitX) {
      if (cuv.x < cut) hi.x = cut; else { lo.x = cut; sub = vec2(1.0, 0.0); }
    } else {
      if (cuv.y < cut) hi.y = cut; else { lo.y = cut; sub = vec2(0.0, 1.0); }
    }
  }
  Panel P;
  vec2 center = (lo + hi) * 0.5;
  P.halfSize = (hi - lo) * 0.5 * csize;
  P.local = (cuv - center) * csize;
  P.id = cid * 2.0 + sub;
  P.rnd = rnd(P.id, 4.0);
  float seam = mm(uSeamMm);
  P.d = sdRoundBox(P.local, P.halfSize - vec2(seam * 0.5), seam * 1.2);
  return P;
}

// Height plus feature masks: x = vent slot, y = bolt/rivet, z = inset groove.
float panelHeightM(vec2 uv, Panel P, out vec3 masks) {
  masks = vec3(0.0);
  float bevel = max(mm(uBevelMm), uTexel.x * 1.5);
  float plate = smoothstep(0.0, bevel, -P.d);
  float h = 0.62 * plate + (P.rnd - 0.5) * 0.05 * plate;
  float minHalf = min(P.halfSize.x, P.halfSize.y);

  // Recessed inset plate with a groove.
  if (rnd(P.id, 5.0) < uDetail.w && minHalf > mm(160.0)) {
    vec2 ih = P.halfSize * vec2(0.66, 0.6);
    float di = sdRoundBox(P.local, ih, bevel * 2.0);
    float inner = smoothstep(0.0, bevel, -di);
    h -= 0.1 * inner;
    float groove = fillAA(abs(di) - mm(2.0), aaw());
    h -= 0.08 * groove;
    masks.z = groove;
  }

  // Vent with horizontal slots.
  if (rnd(P.id, 6.0) < uDetail.x && minHalf > mm(220.0)) {
    vec2 vh = P.halfSize * vec2(0.55, 0.32);
    float dv = sdRoundBox(P.local, vh, bevel);
    float frame = fillAA(abs(dv) - mm(6.0), aaw());
    float inV = fillAA(dv, aaw());
    float slotN = max(3.0, floor(vh.y * 2.0 / mm(28.0)));
    float sy = fract((P.local.y + vh.y) / (2.0 * vh.y) * slotN);
    float slotW = 0.18;
    float slot = smoothstep(slotW, slotW + 0.08, sy) * (1.0 - smoothstep(1.0 - slotW - 0.08, 1.0 - slotW, sy));
    float xin = fillAA(abs(P.local.x) - vh.x + mm(10.0), aaw());
    slot *= xin;
    h += frame * 0.06;
    h = mix(h, h - 0.5, inV * slot);
    masks.x = inV * slot;
  }

  // Corner bolts.
  float br = mm(uDetail.z);
  if (br > 0.0 && minHalf > br * 5.0) {
    vec2 q = abs(P.local) - (P.halfSize - vec2(br * 2.6));
    float bd = length(q);
    float dome = sqrt(clamp(1.0 - (bd * bd) / (br * br), 0.0, 1.0));
    float ring = fillAA(abs(bd - br * 1.25) - mm(0.8), aaw());
    float slotCut = fillAA(abs(q.x - q.y) * 0.7071 - mm(0.9), aaw()) * step(bd, br * 0.8);
    h += (dome * 0.16 - ring * 0.05 - slotCut * 0.05) * plate;
    masks.y = max(masks.y, step(bd, br));
  }

  // Rivet rows along the long edges of some panels.
  if (P.rnd > 0.62 && br > 0.0) {
    float rr = br * 0.55;
    float sp = rr * 7.0;
    bool horiz = P.halfSize.x >= P.halfSize.y;
    vec2 lp = horiz ? P.local : P.local.yx;
    vec2 hs = horiz ? P.halfSize : P.halfSize.yx;
    float rx = (fract(lp.x / sp + 0.5) - 0.5) * sp;
    float ry = abs(lp.y) - (hs.y - br * 2.6);
    float rv = length(vec2(rx, ry));
    float along = step(abs(lp.x), hs.x - br * 5.0);
    float rivet = sqrt(clamp(1.0 - (rv * rv) / (rr * rr), 0.0, 1.0)) * along;
    h += rivet * 0.1 * plate;
    masks.y = max(masks.y, step(rv, rr) * along);
  }

  // Dents and rolling marks.
  h += fbm(uv, 6.0, 4, 7.0) * 0.012 * plate;
  h += fbm2(uv, vec2(3.0, 60.0), 3, 8.0) * 0.004 * plate;
  return h;
}

float genHeight(vec2 uv) {
  Panel P = panelAt(uv);
  vec3 m;
  return panelHeightM(uv, P, m);
}

// Stencil label (3 digits + bar) in the upper-left corner of some panels.
float panelLabel(Panel P) {
  if (P.rnd < 0.55 || min(P.halfSize.x, P.halfSize.y) < mm(260.0)) return 0.0;
  float gh = mm(55.0);
  vec2 origin = vec2(-P.halfSize.x + mm(60.0), P.halfSize.y - mm(60.0) - gh);
  vec2 q = (P.local - origin) / vec2(gh * 0.6, gh);
  float c = 0.0;
  if (q.y > 0.0 && q.y < 1.0 && q.x > 0.0 && q.x < 3.6) {
    float gi = floor(q.x / 1.2);
    vec2 gp = vec2(fract(q.x / 1.2) * 1.2, q.y);
    if (gp.x < 1.0) c = digit7(gp, int(rnd(P.id + gi, 21.0) * 9.99), 0.09, 0.05);
  }
  vec2 bq = P.local - (origin + vec2(0.0, -mm(22.0)));
  float bar = step(0.0, bq.x) * step(bq.x, gh * 2.2) * step(0.0, bq.y) * step(bq.y, mm(8.0));
  return max(c, bar * step(0.8, P.rnd));
}

// Diagonal hazard band along the bottom edge of some panels.
float panelHazard(Panel P) {
  if (rnd(P.id, 22.0) > 0.12 || P.halfSize.y < mm(250.0)) return -1.0;
  float bh = mm(90.0);
  float y = P.local.y + P.halfSize.y - mm(40.0);
  float inBand = step(0.0, y) * step(y, bh) * step(abs(P.local.x), P.halfSize.x - mm(40.0));
  if (inBand < 0.5) return -1.0;
  return step(0.5, fract((P.local.x + P.local.y) / mm(70.0)));
}

void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  Panel P = panelAt(uv);
  vec3 masks;
  panelHeightM(uv, P, masks);
  float bevel = max(mm(uBevelMm), uTexel.x * 1.5);
  float inside = -P.d;
  float accent = step(rnd(P.id, 9.0), 0.08);
  vec3 paint = mix(uColorA, uColorB, accent);
  paint *= 1.0 + (P.rnd - 0.5) * 2.0 * uColorVar;
  float mott = fbm(uv, 4.0, 5, 11.0);
  paint *= 1.0 + mott * 0.2 + fbm(uv, 24.0, 3, 12.0) * 0.05;
  float hz = panelHazard(P);
  if (hz >= 0.0) paint = mix(vec3(0.75, 0.48, 0.02), vec3(0.02), hz);
  float label = panelLabel(P) * smoothstep(0.3, 0.55, fbm01(uv, 40.0, 3, 24.0) + 0.2);
  paint = mix(paint, vec3(0.78, 0.78, 0.74), label * 0.85);

  // Edge wear: along the panel bevels (SDF) and on every convex feature (curvature).
  float n = fbm01(uv, 18.0, 5, 13.0);
  float band = step(0.0, inside) * (1.0 - smoothstep(bevel, bevel + mm(16.0), inside));
  float edgeWear = smoothstep(0.5, 0.56, n) * band;
  float wear = max(edgeWear * uWear * 2.0, edgeWearMask(uv, curv, uWear, 14.0));
  wear = clamp(wear, 0.0, 1.0);
  float scr = scratchLines(uv, 19.0) * uScratches;
  // Grime: in cavities, bleeding out of the seams, and streaks running down.
  float seamBleed = (1.0 - smoothstep(0.0, mm(60.0), inside)) * fbm01(uv, 10.0, 4, 25.0);
  float streak = smoothstep(0.55, 0.85, fbm2(uv, vec2(48.0, 3.0), 3, 26.0) * 0.5 + 0.5) * fbm01(uv, 3.0, 3, 27.0);
  float grime = clamp(grimeMask(uv, ao, uGrime, 23.0) + (seamBleed * 1.3 + streak * 0.8) * uGrime, 0.0, 1.0);
  vec3 bare = uColorC * (0.85 + 0.25 * fbm2(uv, vec2(2.0, 90.0), 3, 29.0));
  albedo = mix(paint, bare, wear);
  albedo = mix(albedo, bare, scr * (1.0 - wear) * 0.7);
  albedo = mix(albedo, bare * 0.9, masks.y * 0.35);
  albedo = applyGrime(albedo, grime);
  // Seams read dark.
  albedo *= mix(0.3, 1.0, smoothstep(0.0, bevel, inside));
  albedo *= mix(1.0, 0.07, masks.x);
  albedo *= 1.0 - masks.z * 0.35;
  rough = uRough + (P.rnd - 0.5) * uRoughVar + mott * uRoughVar * 0.6;
  rough = mix(rough, 0.28, wear);
  rough = mix(rough, 0.22, scr * 0.8);
  rough = mix(rough, 0.92, grime * 0.75);
  rough = mix(rough, rough + 0.12, label);
  metal = mix(uMetal, uBareMetal, max(wear, scr * 0.9));
  metal = mix(metal, 0.0, grime * 0.6);
  ao = min(ao, 1.0 - masks.x * 0.9);
  ao *= mix(0.55, 1.0, smoothstep(0.0, bevel * 2.0, inside));
}
`;

const CONCRETE = /* glsl */ `
float concreteJoint(vec2 uv) {
  vec2 cells = floor(uCells + 0.5);
  if (cells.x <= 0.0 || cells.y <= 0.0) return 0.0;
  vec2 g = abs(fract(uv * cells + 0.5) - 0.5) / cells;
  float jd = min(g.x, g.y);
  return fillAA(jd - max(mm(uSeamMm) * 0.5, uTexel.x), aaw());
}
float concreteCrack(vec2 uv) {
  const float CRACK_CELLS = 5.0;
  vec3 cv = voronoi(uv + fbm(uv, 8.0, 3, 6.0) * 0.012, vec2(CRACK_CELLS), 4.0);
  // F2 - F1 is about twice the distance to the cell border, in cell units: convert to uv.
  float edge = (cv.y - cv.x) * 0.5 / CRACK_CELLS;
  float mask = smoothstep(0.56, 0.7, fbm01(uv, 3.0, 4, 5.0)) * uDetail.y;
  float w = max(uTexel.x, mm(1.5));
  return (1.0 - smoothstep(0.0, w, edge)) * mask;
}
float genHeight(vec2 uv) {
  float h = 0.5;
  h += fbm(uv, 3.0, 5, 1.0) * 0.07;
  vec3 v = voronoi(uv, vec2(floor(uDetail.x + 0.5)), 2.0);
  float agg = smoothstep(0.42, 0.12, v.x) * step(0.4, v.z);
  h += agg * 0.05 * (0.5 + v.z);
  // Round bug holes: a random subset of small Voronoi cells (value noise would give square pits).
  vec3 pv = voronoi(uv, vec2(160.0), 3.0);
  float pores = smoothstep(0.3, 0.12, pv.x) * step(1.0 - 0.25 * uDetail.w, pv.z);
  h -= pores * 0.14;
  h += fbm(uv, 64.0, 2, 9.0) * 0.012;
  h -= concreteCrack(uv) * 0.3;
  h -= concreteJoint(uv) * 0.45;
  return h;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  float large = fbm(uv, 2.0, 5, 11.0);
  float mid = fbm(uv, 12.0, 4, 12.0);
  vec3 base = uColorA * (1.0 + large * uColorVar + mid * 0.06);
  vec3 v = voronoi(uv, vec2(floor(uDetail.x + 0.5)), 2.0);
  float agg = smoothstep(0.42, 0.12, v.x) * step(0.4, v.z);
  base = mix(base, uColorB * (0.8 + 0.4 * v.z), agg * 0.35);
  // Fine speckle.
  float speck = valueNoise(uv * 420.0, vec2(420.0), 14.0);
  base *= 0.93 + speck * 0.14;
  // Water stains / streaks.
  float stain = smoothstep(0.52, 0.8, fbm01(uv, 3.0, 6, 13.0)) * uGrime;
  base = mix(base, uColorC, stain * 0.45);
  float grime = grimeMask(uv, ao, uGrime, 15.0);
  albedo = applyGrime(base, grime * 0.8);
  // Wet patches collect in low spots: darker and glossy.
  float wetN = fbm01(uv, 2.0, 5, 16.0) + (0.5 - h) * 0.8 + (1.0 - ao) * 0.2;
  float wet = smoothstep(0.6, 0.66, wetN) * uDetail.z;
  albedo *= mix(1.0, 0.55, wet);
  float crack = concreteCrack(uv);
  float joint = concreteJoint(uv);
  albedo *= 1.0 - max(crack * 0.45, joint * 0.6);
  rough = uRough + large * uRoughVar + mid * uRoughVar * 0.5;
  rough = mix(rough, 0.1, wet);
  rough = mix(rough, 0.97, max(crack, joint));
  metal = 0.0;
}
`;

const GRATE = /* glsl */ `
// x = solid metal coverage, y = height
vec2 grateLayout(vec2 uv) {
  vec2 cells = max(floor(uCells + 0.5), vec2(1.0));
  float w = max(mm(uSeamMm), uTexel.x * 2.0);
  float aa = aaw();
  if (uDetail.x < 0.5) {
    // Bearing bars along V at cells.x per repeat, cross rods along U at cells.y per repeat.
    float bx = abs(fract(uv.x * cells.x) - 0.5) / cells.x;
    float bar = fillAA(bx - w * 0.5, aa);
    float cy = abs(fract(uv.y * cells.y) - 0.5) / cells.y;
    float rod = fillAA(cy - w * 0.45, aa);
    float serr = 0.5 + 0.5 * cos(uv.y * cells.y * 12.0 * TAU);
    float barH = 0.92 + (serr - 0.5) * 0.1 * uDetail.y;
    float rodProfile = sqrt(clamp(1.0 - pow(cy / (w * 0.45), 2.0), 0.0, 1.0));
    float h = max(bar * barH, rod * (0.72 + 0.12 * rodProfile));
    return vec2(max(bar, rod), h);
  }
  // Expanded metal diamond mesh.
  vec2 p = uv * cells;
  vec2 q = fract(p + vec2(0.5 * mod(floor(p.y), 2.0), 0.0)) - 0.5;
  float dd = abs(q.x) + abs(q.y) * (cells.y / cells.x);
  float strand = w * cells.x;
  float solid = smoothstep(0.5 - strand - aa * cells.x, 0.5 - strand + aa * cells.x, dd);
  float h = solid * (0.75 + 0.2 * smoothstep(0.5 - strand, 0.5, dd));
  return vec2(solid, h);
}
float genHeight(vec2 uv) {
  vec2 g = grateLayout(uv);
  return g.y + fbm(uv, 8.0, 3, 3.0) * 0.01 * g.x;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  vec2 g = grateLayout(uv);
  // Bars are only a few texels wide: full curvature wear would strip them to bare, glossy metal.
  float wear = edgeWearMask(uv, curv, uWear, 5.0) * 0.45;
  // Foot traffic polishes the tops of the bars (kept moderate: glossy thin bars sparkle).
  float top = smoothstep(0.85, 0.95, h) * fbm01(uv, 3.0, 4, 6.0);
  wear = max(wear, top * uWear * 0.6);
  float scr = scratchLines(uv, 7.0) * uScratches;
  float grime = grimeMask(uv, ao, uGrime, 9.0);
  vec3 paint = uColorA * (1.0 + fbm(uv, 4.0, 4, 10.0) * uColorVar * 2.0);
  vec3 bare = uColorC * (0.9 + 0.2 * fbm2(uv, vec2(3.0, 80.0), 3, 12.0));
  vec3 metalCol = mix(paint, bare, max(wear, scr * 0.6));
  metalCol = applyGrime(metalCol, grime);
  // Holes read as the dark void below.
  albedo = mix(uColorB * (1.0 - uDetail.z * 0.8), metalCol, g.x);
  rough = mix(0.95, mix(uRough + fbm(uv, 6.0, 3, 14.0) * uRoughVar, 0.45, max(wear, scr)), g.x);
  rough = mix(rough, 0.9, grime * 0.6 * g.x);
  metal = mix(0.0, mix(uMetal, uBareMetal, max(wear, scr * 0.8)), g.x);
  ao = mix(ao * (1.0 - uDetail.z * 0.85), ao, g.x);
}
`;

const HAZARD = /* glsl */ `
float hazardChip(vec2 uv) {
  float chipScale = max(1.0, floor(uDetail.y + 0.5));
  float n = fbm01(uv, chipScale, 5, 3.0);
  vec3 v = voronoi(uv, vec2(chipScale * 3.0), 4.0);
  float c = n + (0.5 - v.x) * 0.25;
  return smoothstep(1.02 - uWear * 0.42, 1.04 - uWear * 0.42, c);
}
float genHeight(vec2 uv) {
  float chip = hazardChip(uv);
  return 0.6 - chip * 0.45 + fbm(uv, 20.0, 3, 5.0) * 0.02;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  float stripes = max(1.0, floor(uDetail.x + 0.5));
  float s = fract((uv.x + uv.y) * stripes);
  float aa = uTexel.x * stripes * 1.5;
  float stripe = smoothstep(0.5 - aa, 0.5 + aa, s) * (1.0 - smoothstep(1.0 - aa, 1.0, s)) + (1.0 - smoothstep(0.0, aa, s)) * 0.0;
  vec3 paint = mix(uColorA, uColorB, stripe);
  paint *= 1.0 + fbm(uv, 3.0, 4, 8.0) * uColorVar;
  float chip = hazardChip(uv);
  float edgeWear = edgeWearMask(uv, curv, uWear * 0.6, 9.0);
  chip = max(chip, edgeWear);
  // Rust halo around chips.
  // Convex paint edges border the chips (the chips are recessed in the height field).
  float halo = smoothstep(0.0, 1.0, clamp(-curv * 4.0, 0.0, 1.0));
  float rustN = fbm01(uv, 12.0, 4, 10.0);
  vec3 bare = uColorC * (0.85 + 0.3 * fbm2(uv, vec2(2.0, 70.0), 3, 11.0));
  vec3 rust = vec3(0.23, 0.09, 0.03) * (0.7 + 0.6 * rustN);
  bare = mix(bare, rust, smoothstep(0.45, 0.7, rustN) * uDetail.z);
  float scr = scratchLines(uv, 12.0) * uScratches;
  float grime = grimeMask(uv, ao, uGrime, 13.0);
  albedo = mix(paint, bare, chip);
  albedo = mix(albedo, bare, scr * 0.6 * (1.0 - chip));
  albedo = mix(albedo, albedo * vec3(0.5, 0.35, 0.25), halo * uDetail.z * (1.0 - chip) * 0.4);
  albedo = applyGrime(albedo, grime);
  rough = uRough + fbm(uv, 8.0, 3, 14.0) * uRoughVar;
  rough = mix(rough, 0.38, chip);
  rough = mix(rough, 0.8, chip * smoothstep(0.45, 0.7, rustN) * uDetail.z);
  rough = mix(rough, 0.3, scr);
  rough = mix(rough, 0.9, grime * 0.7);
  metal = mix(uMetal, uBareMetal * (1.0 - smoothstep(0.45, 0.7, rustN) * uDetail.z), max(chip, scr * 0.8));
}
`;

const TRIM = /* glsl */ `
float trimGroove(vec2 uv, out float rowId, out float rowF) {
  float rows = max(1.0, floor(uCells.y + 0.5));
  float row = uv.y * rows;
  rowId = floor(row);
  rowF = fract(row);
  float gd = min(rowF, 1.0 - rowF) / rows;
  float seam = max(mm(uSeamMm), uTexel.x * 1.5);
  float bevel = max(mm(uBevelMm), uTexel.x);
  return 1.0 - smoothstep(seam * 0.5, seam * 0.5 + bevel, gd);
}
float trimScrew(vec2 uv, float rowId, float rowF, out float slotMask) {
  slotMask = 0.0;
  float sp = mm(uDetail.x);
  if (sp <= 0.0) return 0.0;
  float rows = max(1.0, floor(uCells.y + 0.5));
  // Keep the screw count per repeat an integer so the pattern tiles.
  float count = max(1.0, floor(1.0 / sp + 0.5));
  float sx = (fract(uv.x * count + rowId * 0.5) - 0.5) / count;
  float sy = (rowF - 0.5) / rows;
  float r = mm(4.0);
  float d = length(vec2(sx, sy));
  slotMask = fillAA(abs(sx) - mm(0.7), aaw()) * step(d, r * 0.8);
  return fillAA(d - r, aaw());
}
float genHeight(vec2 uv) {
  float rowId;
  float rowF;
  float g = trimGroove(uv, rowId, rowF);
  float slot;
  float screw = trimScrew(uv, rowId, rowF, slot);
  float brushed = fbm2(uv, vec2(2.0, 700.0), 2, 3.0);
  return 0.8 - g * 0.55 - screw * 0.12 - slot * 0.08 + brushed * 0.004 * uDetail.y;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  float rowId;
  float rowF;
  float g = trimGroove(uv, rowId, rowF);
  float slot;
  float screw = trimScrew(uv, rowId, rowF, slot);
  float brushed = fbm2(uv, vec2(3.0, 900.0), 3, 5.0);
  float alt = step(rnd(vec2(rowId, 0.0), 6.0), uDetail.z);
  vec3 base = mix(uColorA, uColorB, alt);
  base *= 1.0 + brushed * 0.12 * uDetail.y + fbm(uv, 3.0, 3, 7.0) * uColorVar;
  float wear = edgeWearMask(uv, curv, uWear, 8.0);
  float scr = scratchLines(uv, 9.0) * uScratches;
  float grime = grimeMask(uv, ao, uGrime, 10.0);
  albedo = mix(base, uColorC, max(wear, scr * 0.5));
  albedo = mix(albedo, uColorC * 0.7, screw * 0.6);
  albedo = applyGrime(albedo, grime);
  albedo *= 1.0 - g * 0.3;
  rough = uRough + brushed * uRoughVar * uDetail.y;
  rough = mix(rough, 0.22, scr);
  rough = mix(rough, 0.85, grime * 0.7);
  metal = mix(uMetal, uBareMetal, wear);
  metal = mix(metal, 0.3, grime * 0.5);
}
`;

const RUBBER = /* glsl */ `
float rubberRelief(vec2 uv) {
  vec2 cells = max(floor(uCells + 0.5), vec2(1.0));
  if (uDetail.x < 0.5) {
    vec2 q = (fract(uv * cells) - 0.5) / cells;
    float r = uDetail.y / cells.x;
    float d = length(q);
    float stud = smoothstep(r, r * 0.8, d);
    float top = smoothstep(r * 0.8, r * 0.2, d);
    return stud * (0.75 + top * 0.08);
  }
  float s = fract(uv.y * cells.y);
  float rib = smoothstep(0.2, 0.35, s) * (1.0 - smoothstep(0.65, 0.8, s));
  return rib * 0.8;
}
float genHeight(vec2 uv) {
  return 0.2 + rubberRelief(uv) + fbm(uv, 24.0, 3, 3.0) * 0.015;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  float relief = rubberRelief(uv);
  vec3 base = uColorA * (1.0 + fbm(uv, 4.0, 4, 5.0) * uColorVar * 2.0);
  float scuffN = fbm2(uv, vec2(5.0, 2.0), 5, 6.0) * 0.5 + 0.5;
  float scuff = smoothstep(0.55, 0.8, scuffN) * uDetail.z * relief;
  // Rubber mats collect grey dust in the low areas.
  float dust = (1.0 - relief) * smoothstep(0.35, 0.7, fbm01(uv, 6.0, 4, 7.0)) * uDetail.w;
  albedo = mix(base, uColorB, scuff);
  albedo = mix(albedo, uColorC, dust);
  float wearTop = edgeWearMask(uv, curv, uWear, 8.0) * 0.5;
  albedo = mix(albedo, uColorB, wearTop);
  rough = uRough + fbm(uv, 8.0, 3, 9.0) * uRoughVar;
  rough = mix(rough, 0.7, scuff * 0.6);
  rough = mix(rough, 0.95, dust);
  metal = 0.0;
}
`;

const CRATE = /* glsl */ `
// Masks: x = frame, y = corner bracket, z = stencil, w = rib groove
vec4 crateMasks(vec2 uv, out float h) {
  vec2 p = uv;
  float fw = uDetail.x;
  float aa = aaw();
  float dEdge = min(min(p.x, 1.0 - p.x), min(p.y, 1.0 - p.y));
  float frame = 1.0 - smoothstep(fw - aa, fw + aa, dEdge);
  float bevel = max(mm(uBevelMm), uTexel.x * 1.5);
  float frameProfile = smoothstep(0.0, bevel, dEdge) * (1.0 - smoothstep(fw - bevel, fw, dEdge) * 0.35);
  // Corrugated inner panel.
  float inner = 1.0 - frame;
  float ribs = max(1.0, floor(uDetail.y + 0.5));
  float px = (p.x - fw) / max(1.0 - 2.0 * fw, 1e-3);
  float rib = 0.5 - 0.5 * cos(px * ribs * TAU);
  float ribGroove = smoothstep(0.75, 1.0, 1.0 - rib);
  h = frame * (0.75 * frameProfile + 0.15) + inner * (0.25 + 0.18 * smoothstep(0.1, 0.6, rib));
  // Corner brackets (L plates) with bolts.
  vec2 c = abs(p - 0.5);
  float bs = uDetail.w;
  float bracket = step(0.5 - bs, c.x) * step(0.5 - bs, c.y);
  bracket *= step(min(c.x, c.y), 0.5 - bs * 0.35) + step(0.5 - bs * 0.35, min(c.x, c.y));
  vec2 bp = vec2(0.5 - bs * 0.55);
  float bolt = fillAA(length(c - bp) - bs * 0.12, aa);
  h = mix(h, 0.95, bracket);
  h += bolt * 0.06 * bracket;
  // Stencil block: rows of "text" bars plus a big 2-digit number.
  float stencil = 0.0;
  vec2 sp = (p - vec2(0.5 - 0.28, 0.5 + 0.02)) / vec2(0.56, 0.3);
  if (sp.x > 0.0 && sp.x < 1.0 && sp.y > 0.0 && sp.y < 1.0) {
    float cellW = 1.0 / 3.0;
    float gi = floor(sp.x / cellW);
    vec2 gp = vec2(fract(sp.x / cellW), sp.y);
    if (gi < 2.0) {
      // Seed-derived digits: the hash happened to give "88" (all segments) for the default seed.
      int dig = int(mod(floor(uSeed * 3.7 + 1.0) + gi * 5.0, 10.0));
      stencil = digit7(gp, dig, 0.075, 0.02);
    } else {
      // Text rows.
      float rowsN = 5.0;
      float ry = fract(gp.y * rowsN);
      float ri = floor(gp.y * rowsN);
      float len = 0.35 + 0.6 * rnd(vec2(ri, 2.0), 32.0);
      float seg = step(0.3, ry) * step(ry, 0.7) * step(gp.x, len) * step(0.05, gp.x);
      float gap = step(0.18, fract(gp.x * 7.0 + rnd(vec2(ri, 3.0), 33.0)));
      stencil = seg * gap;
    }
  }
  // Hazard stripe label under the stencil.
  vec2 lp = (p - vec2(0.5 - 0.28, 0.5 - 0.16)) / vec2(0.56, 0.08);
  float label = step(0.0, lp.x) * step(lp.x, 1.0) * step(0.0, lp.y) * step(lp.y, 1.0);
  float stripes = step(0.5, fract((lp.x * 7.0 + lp.y) * 1.0));
  float spray = smoothstep(0.35, 0.6, fbm01(uv, 24.0, 4, 34.0) + 0.25);
  stencil = max(stencil, label * stripes) * spray * inner * uDetail.z;
  return vec4(frame, bracket, stencil, ribGroove * inner);
}
float genHeight(vec2 uv) {
  float h;
  crateMasks(uv, h);
  return h + fbm(uv, 8.0, 4, 3.0) * 0.01;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  float hh;
  vec4 m = crateMasks(uv, hh);
  vec3 paint = uColorA * (1.0 + fbm(uv, 3.0, 4, 5.0) * uColorVar * 2.0);
  paint *= mix(1.0, 0.8, m.x);
  float wear = edgeWearMask(uv, curv, uWear, 7.0);
  float scr = scratchLines(uv, 8.0) * uScratches;
  // More dirt towards the bottom of the crate.
  float grime = grimeMask(uv, ao, uGrime, 9.0);
  grime = clamp(grime + (1.0 - smoothstep(0.0, 0.35, uv.y)) * 0.35 * uGrime, 0.0, 1.0);
  vec3 bare = uColorC * (0.85 + 0.3 * fbm2(uv, vec2(2.0, 60.0), 3, 10.0));
  albedo = mix(paint, uColorB, m.z);
  albedo = mix(albedo, bare, max(wear, m.y));
  albedo = mix(albedo, bare, scr * 0.6);
  albedo = applyGrime(albedo, grime);
  rough = uRough + fbm(uv, 6.0, 3, 11.0) * uRoughVar;
  rough = mix(rough, 0.6, m.z);
  rough = mix(rough, 0.32, max(wear, m.y));
  rough = mix(rough, 0.9, grime * 0.7);
  metal = mix(uMetal, uBareMetal, max(max(wear, m.y), scr * 0.8));
}
`;

const PIPE = /* glsl */ `
float pipeWeld(vec2 uv) {
  float d = min(uv.y, 1.0 - uv.y);
  float w = mm(uSeamMm);
  float bead = 1.0 - smoothstep(0.0, w, d);
  float ripple = 0.75 + 0.25 * cos(uv.x * floor(1.0 / max(mm(6.0), 1e-4)) * TAU);
  return bead * ripple * uDetail.w;
}
float pipeBand(vec2 uv) {
  float d = abs(uv.y - uDetail.x);
  return fillAA(d - uDetail.y * 0.5, aaw());
}
float genHeight(vec2 uv) {
  float band = pipeBand(uv);
  float rustN = fbm01(uv, 6.0, 5, 3.0);
  float rust = smoothstep(0.62, 0.8, rustN) * uDetail.z;
  return 0.5 + pipeWeld(uv) * 0.35 + band * 0.04 + rust * fbm(uv, 40.0, 3, 4.0) * 0.08;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  float band = pipeBand(uv);
  // Flow arrows inside the band.
  float ax = fract(uv.x * 4.0);
  float ay = (uv.y - uDetail.x) / max(uDetail.y, 1e-3);
  float arrow = step(abs(ay), 0.3 - abs(ax - 0.5) * 0.6) * step(0.2, ax) * step(ax, 0.8);
  vec3 paint = uColorA * (1.0 + fbm(uv, 3.0, 4, 5.0) * uColorVar * 2.0);
  paint = mix(paint, uColorB, band);
  paint = mix(paint, vec3(0.02), band * arrow);
  float rustN = fbm01(uv, 6.0, 5, 3.0);
  float rust = smoothstep(0.62, 0.8, rustN) * uDetail.z;
  // Streaks run along the pipe.
  float streak = smoothstep(0.55, 0.85, fbm2(uv, vec2(30.0, 2.0), 4, 6.0) * 0.5 + 0.5) * uDetail.z * 0.6;
  vec3 rustCol = uColorC * (0.7 + 0.6 * fbm01(uv, 24.0, 3, 7.0));
  float wear = edgeWearMask(uv, curv, uWear, 8.0);
  float scr = scratchLines(uv, 9.0) * uScratches;
  float grime = grimeMask(uv, ao, uGrime, 10.0);
  vec3 bare = vec3(0.5, 0.5, 0.52);
  albedo = mix(paint, bare, max(wear, scr * 0.5));
  albedo = mix(albedo, rustCol, max(rust, streak));
  albedo = applyGrime(albedo, grime);
  rough = uRough + fbm(uv, 8.0, 3, 11.0) * uRoughVar;
  rough = mix(rough, 0.85, max(rust, streak));
  rough = mix(rough, 0.3, max(wear, scr));
  rough = mix(rough, 0.9, grime * 0.6);
  metal = mix(uMetal, uBareMetal, max(wear, scr * 0.8) * (1.0 - rust));
}
`;

const GRID = /* glsl */ `
// Masks: x = major line, y = minor line, z = digits, w = accent markers
vec4 gridMasks(vec2 uv) {
  vec2 cells = max(floor(uCells + 0.5), vec2(1.0));
  vec2 g = uv * cells;
  vec2 cf = fract(g);
  vec2 ci = floor(g);
  float aa = aaw();
  vec2 dMaj = min(cf, 1.0 - cf) / cells;
  float major = fillAA(min(dMaj.x, dMaj.y) - max(mm(uSeamMm) * 0.5, uTexel.x), aa);
  float sub = max(1.0, floor(uDetail.x + 0.5));
  vec2 sf = fract(g * sub);
  vec2 dMin = min(sf, 1.0 - sf) / (cells * sub);
  float minor = fillAA(min(dMin.x, dMin.y) - max(mm(uSeamMm) * 0.15, uTexel.x * 0.6), aa);
  // Tick marks every 10 cm along the major lines.
  float ticksN = floor(uMeters * 10.0 / cells.x + 0.5) * cells.x;
  vec2 tf = fract(uv * ticksN);
  vec2 dTick = min(tf, 1.0 - tf) / ticksN;
  float tickLen = mm(40.0);
  float tick = fillAA(dTick.x - mm(1.5), aa) * step(dMaj.y, tickLen) + fillAA(dTick.y - mm(1.5), aa) * step(dMaj.x, tickLen);
  minor = max(minor, tick);
  // Two digits (cell column, row) in the lower-left corner of every cell.
  float ds = uDetail.y;
  float digits = 0.0;
  vec2 dp = (cf - vec2(0.06, 0.06)) / vec2(ds * 0.6, ds);
  float stroke = 0.08;
  float daa = aa * cells.x / ds * 1.5;
  if (dp.y > 0.0 && dp.y < 1.0 && dp.x > 0.0 && dp.x < 2.2) {
    if (dp.x < 1.0) digits = digit7(dp, int(mod(ci.x, 10.0)), stroke, daa);
    else if (dp.x > 1.2) digits = digit7(dp - vec2(1.2, 0.0), int(mod(ci.y, 10.0)), stroke, daa);
  }
  // Calibration target (circle + cross) in the cell center.
  vec2 cc = (cf - 0.5) / cells;
  float cr = length(cc);
  float ring = fillAA(abs(cr - mm(55.0)) - mm(3.0), aa);
  // Named crossMark: a local called cross would shadow the GLSL builtin (rejected by some compilers).
  float crossMark = fillAA(min(abs(cc.x), abs(cc.y)) - mm(2.0), aa) * step(cr, mm(90.0));
  float quad = step(0.0, cc.x * cc.y) * step(cr, mm(55.0));
  float accent = max(ring, quad) * uDetail.z;
  return vec4(major, minor, digits, max(accent, crossMark * uDetail.z));
}
float genHeight(vec2 uv) {
  vec4 m = gridMasks(uv);
  return 0.5 - m.x * 0.03 + fbm(uv, 4.0, 4, 3.0) * 0.02 + fbm(uv, 32.0, 2, 4.0) * 0.005;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  vec4 m = gridMasks(uv);
  vec3 base = uColorA * (1.0 + fbm(uv, 3.0, 5, 5.0) * uColorVar * 2.0);
  base = mix(base, uColorB, max(m.x, m.z));
  base = mix(base, mix(uColorA, uColorB, 0.55), m.y * (1.0 - m.x));
  base = mix(base, uColorC, m.w * (1.0 - m.x));
  float wear = edgeWearMask(uv, curv, uWear, 6.0);
  float scr = scratchLines(uv, 7.0) * uScratches;
  float grime = grimeMask(uv, ao, uGrime, 8.0);
  grime = clamp(grime + (1.0 - smoothstep(0.0, 0.25, uv.y)) * 0.25 * uGrime, 0.0, 1.0);
  albedo = mix(base, uColorA * 1.2, scr * 0.4);
  albedo = mix(albedo, vec3(0.45), wear * 0.5);
  albedo = applyGrime(albedo, grime);
  rough = uRough + fbm(uv, 6.0, 3, 9.0) * uRoughVar;
  rough = mix(rough, 0.38, max(m.x, m.z));
  rough = mix(rough, 0.85, grime * 0.6);
  metal = uMetal;
}
`;

const SCREEN = /* glsl */ `
// Emissive UI: returns glow color (linear, 0..1).
vec3 screenUI(vec2 uv) {
  vec2 cells = max(floor(uCells + 0.5), vec2(1.0));
  vec2 g = uv * cells;
  vec2 cf = fract(g);
  vec2 ci = floor(g);
  float aa = aaw() * cells.x;
  float r = rnd(ci, 1.0);
  vec3 col = vec3(0.0);
  // Widget frame + corner brackets.
  vec2 fp = abs(cf - 0.5);
  float frameD = max(fp.x, fp.y) - 0.46;
  float frame = fillAA(abs(frameD) - 0.004, aa);
  float corner = step(0.4, fp.x) * step(0.4, fp.y) * fillAA(abs(frameD) - 0.01, aa);
  col += uColorA * (frame * 0.35 + corner * 0.9);
  vec2 wp = (cf - 0.06) / 0.88;
  bool inside = wp.x > 0.0 && wp.x < 1.0 && wp.y > 0.0 && wp.y < 1.0;
  if (inside && rnd(ci, 7.0) < uDetail.z) {
    vec3 accent = mix(uColorA, uColorB, step(0.7, rnd(ci, 8.0)));
    if (r < 0.25) {
      // Bar graph.
      float n = 12.0;
      float bi = floor(wp.x * n);
      float bf = fract(wp.x * n);
      float hgt = 0.15 + 0.8 * rnd(vec2(bi, ci.x + ci.y * 7.0), 9.0);
      float bar = step(0.15, bf) * step(bf, 0.85) * step(wp.y, hgt) * step(0.05, wp.y);
      col += accent * bar * (0.55 + 0.45 * wp.y / hgt);
    } else if (r < 0.5) {
      // Line graph with grid.
      float y = 0.5 + 0.35 * fbm(vec2(wp.x, ci.x * 0.37 + ci.y * 0.11), 4.0, 4, 10.0);
      float line = fillAA(abs(wp.y - y) - 0.012, aa * 1.5);
      float glow = exp(-abs(wp.y - y) * 30.0) * 0.35;
      float under = step(wp.y, y) * 0.08;
      vec2 gl = abs(fract(wp * vec2(8.0, 4.0)) - 0.5);
      float gridL = fillAA(0.5 - max(gl.x, gl.y) - 0.02, aa * 8.0) * 0.08;
      col += accent * (line + glow + under) + uColorA * gridL;
    } else if (r < 0.75) {
      // Text lines.
      float rows = 9.0;
      float ri = floor(wp.y * rows);
      float rf = fract(wp.y * rows);
      float len = 0.25 + 0.7 * rnd(vec2(ri, ci.x + ci.y * 5.0), 11.0);
      float words = step(0.2, fract(wp.x * 9.0 + rnd(vec2(ri, 1.0), 12.0) * 3.0));
      float text = step(0.3, rf) * step(rf, 0.7) * step(wp.x, len) * words;
      float hi = step(0.85, rnd(vec2(ri, ci.y), 13.0));
      col += mix(uColorA, uColorB, hi) * text * 0.8;
    } else {
      // Radial gauge + big number.
      vec2 c = wp - vec2(0.3, 0.5);
      float rr = length(c);
      float ang = atan(c.y, c.x) / TAU + 0.5;
      float fill = 0.2 + 0.75 * rnd(ci, 14.0);
      float ring = fillAA(abs(rr - 0.22) - 0.025, aa);
      float arc = ring * step(ang, fill);
      col += uColorA * ring * 0.15 + accent * arc;
      vec2 dp = (wp - vec2(0.62, 0.3)) / vec2(0.16, 0.4);
      if (dp.x > 0.0 && dp.x < 2.2 && dp.y > 0.0 && dp.y < 1.0) {
        float d0 = dp.x < 1.0 ? digit7(dp, int(rnd(ci, 15.0) * 9.99), 0.08, 0.03) : 0.0;
        float d1 = dp.x > 1.2 ? digit7(dp - vec2(1.2, 0.0), int(rnd(ci, 16.0) * 9.99), 0.08, 0.03) : 0.0;
        col += uColorA * max(d0, d1);
      }
    }
  }
  // Faint background grid and vignette glow.
  vec2 bg = abs(fract(uv * cells * 6.0) - 0.5);
  float bgl = fillAA(0.5 - max(bg.x, bg.y) - 0.01, aa * 6.0);
  col += uColorA * (bgl * 0.04 + uDetail.y * 0.05);
  // Scanlines.
  float scan = 0.82 + 0.18 * sin(uv.y * floor(uDetail.x + 0.5) * TAU);
  return col * scan;
}
float genHeight(vec2 uv) {
  return 0.5 + fbm(uv, 16.0, 2, 3.0) * 0.004;
}
void genSurface(vec2 uv, float h, float curv, inout float ao, inout vec3 albedo, inout float rough, inout float metal, inout vec3 emissive) {
  vec3 ui = screenUI(uv);
  float smudge = fbm01(uv, 4.0, 5, 20.0);
  albedo = uColorC;
  rough = uRough + smudge * uRoughVar * 2.0 + uGrime * smoothstep(0.6, 0.8, smudge) * 0.3;
  metal = 0.0;
  emissive = ui;
  ao = 1.0;
}
`;

interface GeneratorShader {
  body: string;
  /** Produces an emissive map (pass 3). */
  emissive: boolean;
}

const GENERATORS: Record<GeneratorId, GeneratorShader> = {
  panel: { body: PANEL, emissive: false },
  concrete: { body: CONCRETE, emissive: false },
  grate: { body: GRATE, emissive: false },
  hazard: { body: HAZARD, emissive: false },
  trim: { body: TRIM, emissive: false },
  rubber: { body: RUBBER, emissive: false },
  crate: { body: CRATE, emissive: false },
  pipe: { body: PIPE, emissive: false },
  grid: { body: GRID, emissive: false },
  screen: { body: SCREEN, emissive: true },
};

export function generatorHasEmissive(id: GeneratorId): boolean {
  return GENERATORS[id].emissive;
}

export function buildGeneratorFragment(id: GeneratorId): string {
  return `${COMMON}\n${GENERATORS[id].body}\n${MAIN}`;
}
