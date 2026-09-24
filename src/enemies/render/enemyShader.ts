/**
 * Enemy materials: MeshPhysicalMaterial (wet clearcoat) + onBeforeCompile patches.
 *
 * Vertex: the rig interpreter (RIG_GLSL) evaluates the per-instance pose attributes against the
 * packed rig texture (poseMath.compileRig) – the same formulas as poseMath.evaluateRig – and
 * deforms position + normal from the vertex's bone up to the root, before three's instancing.
 * The depth/distance materials (shadows) run the identical deformation and clips. Per-instance
 * culling: an instance whose reach sphere lies outside the frustum of the camera drawing it (main
 * camera, every shadow cascade / spot shadow camera) skips the rig and collapses to a point – the
 * InstancedMesh itself is only culled as a whole (one bounding sphere around all instances), so
 * without it every shadow map would run the rig of every enemy on the map.
 *
 * Fragment: per-part material zones (uniform palette), triplanar procedural surface in rest-pose
 * space (blotches, plate seams, pores → albedo/roughness/clearcoat + bump), emissive veins with
 * travelling pulses, glowing organs, attack telegraph glow, white-hot hit flash, elite fresnel
 * rim, the rift seam while emerging and the per-instance noise dissolve (render/materials/dissolve).
 *
 * One program for ALL enemy types (types differ only in uniforms/textures): nothing recompiles
 * when types spawn. Call order: patch hooks here FIRST, then RenderApi.setupMaterial (CSM chains).
 */
import {
  Color,
  MeshDepthMaterial,
  MeshDistanceMaterial,
  MeshPhysicalMaterial,
  Vector2,
  Vector4,
  type DataTexture,
  type Material,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { createLogger } from '../../core/log';
import { ENEMY_RENDER, GAIT_WAVES, RIG_DRIVERS, type EnemyVisualDef } from '../../defs/enemyVisuals';
import {
  createDissolveUniforms,
  patchDissolveFragment,
  type DissolveUniforms,
} from '../../render/materials/dissolve';
import {
  CODE_STRIDE,
  DRIVER_CODE,
  MIN_SCALE,
  RARE_DRIVER_MASK,
  WAVE_CODE,
  type CompiledRig,
} from './poseMath';

const log = createLogger('EnemyShader');

/** Bump when the injected GLSL changes (program cache keys). */
export const ENEMY_SHADER_KEY = 'rf-enemy-3';

/** vec4 entries per material zone in `rfZones`. */
export const ZONE_VEC4 = 6;

const R = ENEMY_RENDER;

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

function glslFloat(v: number): string {
  const s = String(v);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

/** Driver / wave codes as #defines – generated from the same tables the CPU evaluator uses. */
export function rigDefines(): string {
  const lines = [
    `#define RF_MAX_DEPTH ${R.maxDepth}`,
    `#define RF_MAX_MOTIONS ${R.maxMotionsPerBone}`,
    `#define RF_RIG_WIDTH ${R.rigTextureWidth}`,
    `#define RF_CODE_STRIDE ${CODE_STRIDE}`,
    `#define RF_MIN_SCALE ${glslFloat(MIN_SCALE)}`,
    `#define RF_RARE_MASK ${RARE_DRIVER_MASK}`,
  ];
  for (const d of RIG_DRIVERS) lines.push(`#define RF_DRV_${d.toUpperCase()} ${DRIVER_CODE[d]}`);
  for (const w of GAIT_WAVES) lines.push(`#define RF_WAVE_${w.toUpperCase()} ${WAVE_CODE[w]}`);
  return lines.join('\n');
}

/** Rig interpreter: mirrors poseMath.computeDrivers / motionValue / evaluateRig line by line. */
export const RIG_GLSL = /* glsl */ `
${rigDefines()}

attribute float partId;
attribute float partAxis;
attribute vec4 rfPose0; // locomotion, phase, attackId, attack
attribute vec4 rfPose1; // stagger, death, dissolve, emerge
attribute vec4 rfPose2; // hitFlash, lookYaw, lookPitch, seed
attribute vec4 rfRimAttr; // rim rgb, rim strength

uniform highp sampler2D rfRig;
uniform ivec4 rfLayout; // attackBase, boneBase, partBase, motionBase (texels)
uniform ivec4 rfCounts; // attacks, bones, parts, motions
uniform vec2 rfLook; // look yaw / pitch limits (rad)
uniform float rfTime;
uniform float rfCullRadius; // reach around the feet (m at scale 1, EnemyRenderer cullReach); <= 0: off

float rfLoc;
float rfPhase;
float rfAttack;
float rfEW;
float rfES;
float rfStagger;
float rfDeath;
float rfEmergeInv;
float rfLookYaw;
float rfLookPitch;
float rfSeed;
float rfLife;
float rfGlowBoost;
float rfZone;
int rfActive;

vec4 rfTex( int i ) {
	return texelFetch( rfRig, ivec2( i - ( i / RF_RIG_WIDTH ) * RF_RIG_WIDTH, i / RF_RIG_WIDTH ), 0 );
}

bool rfInsidePlane( vec4 plane, vec4 p, float r ) {
	return dot( plane, p ) >= - r * length( plane.xyz );
}

// Reach sphere of this instance against the frustum of the camera drawing it (planes from the
// rows of the projection matrix, view space). Mirrors poseMath.instanceInFrustum.
bool rfInstanceVisible() {
#ifdef USE_INSTANCING
	if ( rfCullRadius <= 0.0 ) return true;
	vec4 c = vec4( ( modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz, 1.0 );
	float r = rfCullRadius * length( instanceMatrix[ 0 ].xyz );
	mat4 P = projectionMatrix;
	vec4 r0 = vec4( P[ 0 ][ 0 ], P[ 1 ][ 0 ], P[ 2 ][ 0 ], P[ 3 ][ 0 ] );
	vec4 r1 = vec4( P[ 0 ][ 1 ], P[ 1 ][ 1 ], P[ 2 ][ 1 ], P[ 3 ][ 1 ] );
	vec4 r2 = vec4( P[ 0 ][ 2 ], P[ 1 ][ 2 ], P[ 2 ][ 2 ], P[ 3 ][ 2 ] );
	vec4 r3 = vec4( P[ 0 ][ 3 ], P[ 1 ][ 3 ], P[ 2 ][ 3 ], P[ 3 ][ 3 ] );
	return rfInsidePlane( r3 + r0, c, r ) && rfInsidePlane( r3 - r0, c, r ) &&
		rfInsidePlane( r3 + r1, c, r ) && rfInsidePlane( r3 - r1, c, r ) &&
		rfInsidePlane( r3 + r2, c, r ) && rfInsidePlane( r3 - r2, c, r );
#else
	return true;
#endif
}

float rfSmooth01( float x ) {
	float t = clamp( x, 0.0, 1.0 );
	return t * t * ( 3.0 - 2.0 * t );
}

float rfWindow( float e0, float e1, float x ) {
	float d = e1 - e0;
	float t = d > 0.0 ? clamp( ( x - e0 ) / d, 0.0, 1.0 ) : step( e0, x );
	return t * t * ( 3.0 - 2.0 * t );
}

void rfSetup() {
	rfLoc = clamp( rfPose0.x, 0.0, 2.0 );
	rfPhase = rfPose0.y;
	int id = int( floor( rfPose0.z + 0.5 ) );
	rfAttack = -1.0;
	rfEW = 0.0;
	rfES = 0.0;
	rfGlowBoost = 0.0;
	if ( id >= 0 && id < rfCounts.x ) {
		rfAttack = float( id );
		vec4 k = rfTex( rfLayout.x + id );
		float t = clamp( rfPose0.w, 0.0, 1.0 );
		float w = clamp( k.x, 0.0, 1.0 );
		float s = clamp( k.y, w, 1.0 );
		if ( t < w ) {
			rfEW = rfSmooth01( t / max( w, 1e-5 ) );
		} else if ( t < s ) {
			float u = rfSmooth01( ( t - w ) / max( s - w, 1e-5 ) );
			rfEW = 1.0 - u;
			rfES = u;
		} else {
			rfES = 1.0 - rfSmooth01( ( t - s ) / max( 1.0 - s, 1e-5 ) );
		}
		rfGlowBoost = k.z * max( rfEW, rfES );
	}
	rfStagger = clamp( rfPose1.x, 0.0, 1.0 );
	rfDeath = clamp( rfPose1.y, 0.0, 1.0 );
	rfEmergeInv = 1.0 - clamp( rfPose1.w, 0.0, 1.0 );
	rfLookYaw = clamp( rfPose2.y, -rfLook.x, rfLook.x );
	rfLookPitch = clamp( rfPose2.z, -rfLook.y, rfLook.y );
	rfSeed = rfPose2.w;
	rfLife = 1.0 - rfDeath;
	// Same conditions as poseMath.activeDriverMask: motions of other drivers are exactly 0.
	bool alive = rfLife > 0.0;
	rfActive = 1 << RF_DRV_REST;
	if ( alive ) rfActive |= 1 << RF_DRV_IDLE;
	if ( alive && rfLoc > 0.0 ) rfActive |= ( 1 << RF_DRV_GAIT ) | ( 1 << RF_DRV_LOCO );
	if ( alive && rfAttack >= 0.0 ) rfActive |= 1 << RF_DRV_ATTACK;
	if ( alive && rfStagger > 0.0 ) rfActive |= 1 << RF_DRV_STAGGER;
	if ( rfDeath > 0.0 ) rfActive |= 1 << RF_DRV_DEATH;
	if ( rfEmergeInv > 0.0 ) rfActive |= 1 << RF_DRV_EMERGE;
	if ( alive && rfLookYaw != 0.0 ) rfActive |= 1 << RF_DRV_LOOKYAW;
	if ( alive && rfLookPitch != 0.0 ) rfActive |= 1 << RF_DRV_LOOKPITCH;
}

float rfMotion( vec4 m0, vec4 m1, int drv ) {
	float aux = m0.y;
	float amp = m0.z;
	float amp2 = m0.w;
	float freq = m1.x;
	float off = m1.y;
	if ( drv == RF_DRV_GAIT ) {
		float w = sin( rfPhase * freq + off );
		int wave = int( floor( aux + 0.5 ) );
		if ( wave == RF_WAVE_POS ) w = max( w, 0.0 );
		else if ( wave == RF_WAVE_ABS ) w = abs( w );
		float a = amp * clamp( rfLoc, 0.0, 1.0 ) + ( amp2 - amp ) * clamp( rfLoc - 1.0, 0.0, 1.0 );
		return w * a * rfLife;
	}
	if ( drv == RF_DRV_ATTACK ) {
		return abs( aux - rfAttack ) < 0.5 ? ( amp2 * rfEW + amp * rfES ) * rfLife : 0.0;
	}
	float base = 0.0;
	if ( drv == RF_DRV_REST ) base = 1.0;
	else if ( drv == RF_DRV_IDLE ) base = rfLife;
	else if ( drv == RF_DRV_LOCO ) base = rfWindow( m1.z, m1.w, rfLoc * 0.5 ) * rfLife;
	else if ( drv == RF_DRV_STAGGER ) base = rfWindow( m1.z, m1.w, rfStagger ) * rfLife;
	else if ( drv == RF_DRV_DEATH ) base = rfWindow( m1.z, m1.w, rfDeath );
	else if ( drv == RF_DRV_EMERGE ) base = rfWindow( m1.z, m1.w, rfEmergeInv );
	else if ( drv == RF_DRV_LOOKYAW ) base = rfLookYaw * rfLife;
	else if ( drv == RF_DRV_LOOKPITCH ) base = -rfLookPitch * rfLife;
	if ( freq > 0.0 ) base *= sin( 6.283185307 * freq * rfTime + off + rfSeed * 6.283185307 );
	return base * amp;
}

// L(x) = R · (S ∘ (x - pivot)) + pivot + move, R = Ry · Rx · Rz. Returns the parent bone.
int rfApplyBone( int b, inout vec3 p, inout vec3 n ) {
	int bt = rfLayout.y + b * 2;
	vec4 h0 = rfTex( bt );
	vec4 h1 = rfTex( bt + 1 );
	int parent = int( floor( h0.w + 0.5 ) );
	// No active driver on this bone: rest transform (identity).
	if ( ( int( h1.z + 0.5 ) & rfActive ) == 0 ) return parent;
	int start = int( h1.x + 0.5 );
	// No rare driver (attack, stagger, death, emerge) active: only the leading common block.
	int count = int( ( ( rfActive & RF_RARE_MASK ) == 0 ? h1.w : h1.y ) + 0.5 );
	vec3 rot = vec3( 0.0 );
	vec3 mov = vec3( 0.0 );
	vec3 scl = vec3( 1.0 );
	for ( int i = 0; i < RF_MAX_MOTIONS; i ++ ) {
		if ( i >= count ) break;
		int mt = rfLayout.w + ( start + i ) * 2;
		vec4 m0 = rfTex( mt );
		int code = int( m0.x + 0.5 );
		int drv = code / RF_CODE_STRIDE;
		// Inactive drivers and other attacks contribute exactly 0 (poseMath.evaluateRig skips them too).
		if ( ( ( rfActive >> drv ) & 1 ) == 0 ) continue;
		if ( drv == RF_DRV_ATTACK && abs( m0.y - rfAttack ) >= 0.5 ) continue;
		vec4 m1 = rfTex( mt + 1 );
		int ch = code - drv * RF_CODE_STRIDE;
		float v = rfMotion( m0, m1, drv );
		if ( ch == 0 ) rot.x += v;
		else if ( ch == 1 ) rot.y += v;
		else if ( ch == 2 ) rot.z += v;
		else if ( ch == 3 ) mov.x += v;
		else if ( ch == 4 ) mov.y += v;
		else if ( ch == 5 ) mov.z += v;
		else if ( ch == 6 ) scl.x += v;
		else if ( ch == 7 ) scl.y += v;
		else if ( ch == 8 ) scl.z += v;
		else scl += vec3( v );
	}
	scl = max( scl, vec3( RF_MIN_SCALE ) );
	float ca = cos( rot.y );
	float sa = sin( rot.y );
	float cb = cos( rot.x );
	float sb = sin( rot.x );
	float cc = cos( rot.z );
	float sc = sin( rot.z );
	mat3 R = mat3(
		ca * cc + sa * sb * sc, cb * sc, - sa * cc + ca * sb * sc,
		- ca * sc + sa * sb * cc, cb * cc, sa * sc + ca * sb * cc,
		sa * cb, - sb, ca * cb
	);
	vec3 c = h0.xyz;
	p = R * ( ( p - c ) * scl ) + c + mov;
	n = R * ( n / scl );
	return parent;
}

void rfDeform( vec3 pos, vec3 nrm, out vec3 outPos, out vec3 outNrm ) {
	vec4 part = rfTex( rfLayout.z + int( partId + 0.5 ) );
	rfZone = part.y;
	int b = int( part.x + 0.5 );
	vec3 p = pos;
	vec3 n = nrm;
	for ( int d = 0; d < RF_MAX_DEPTH; d ++ ) {
		if ( b < 0 ) break;
		b = rfApplyBone( b, p, n );
	}
	outPos = p;
	outNrm = normalize( n );
}
`;

const VERTEX_VARYINGS_COLOR = /* glsl */ `
varying vec3 vRfDissolvePos;
varying vec4 vRfRestN;
varying float vRfLocalY;
flat varying vec4 vRfFx;
flat varying vec4 vRfInst;
flat varying vec4 vRfState;
`;

const VERTEX_VARYINGS_DEPTH = /* glsl */ `
varying vec3 vRfDissolvePos;
varying float vRfLocalY;
flat varying vec4 vRfFx;
`;

/** Rest-pose position + per-instance offset: stable noise space for dissolve and texturing. */
const DISSOLVE_POS = 'position + vec3( rfSeed * 37.0, 0.0, rfSeed * 23.0 )';

// Culled instances: every vertex at the feet (zero-area triangles, nothing rasterizes).
const VERTEX_DEFORM_COLOR = /* glsl */ `
rfSetup();
vec3 rfPos = vec3( 0.0 );
vec3 rfNrm = vec3( 0.0, 1.0, 0.0 );
rfZone = 0.0;
if ( rfInstanceVisible() ) rfDeform( position, objectNormal, rfPos, rfNrm );
objectNormal = rfNrm;
`;

const VERTEX_ASSIGN_COLOR = /* glsl */ `
transformed = rfPos;
vRfDissolvePos = ${DISSOLVE_POS};
vRfRestN = vec4( normal, partAxis );
vRfLocalY = rfPos.y;
vRfFx = vec4( rfPose2.x, rfRimAttr.w, rfPose1.z, rfPose1.w );
vRfInst = vec4( rfRimAttr.rgb, rfSeed );
vRfState = vec4( rfZone, rfGlowBoost, rfLife, rfEmergeInv );
`;

const VERTEX_DEFORM_DEPTH = /* glsl */ `
rfSetup();
vec3 rfNrmUnused;
transformed = vec3( 0.0 );
if ( rfInstanceVisible() ) rfDeform( position, vec3( 0.0, 1.0, 0.0 ), transformed, rfNrmUnused );
vRfDissolvePos = ${DISSOLVE_POS};
vRfLocalY = transformed.y;
vRfFx = vec4( rfPose2.x, rfRimAttr.w, rfPose1.z, rfPose1.w );
`;

/** Emergence: nothing below the rift plane (feet level) while the enemy is still coming out. */
const FRAGMENT_EMERGE_CLIP = /* glsl */ `
if ( vRfFx.w < 1.0 && vRfLocalY < 0.0 ) discard;
`;

const FRAGMENT_DEPTH_PARS = /* glsl */ `
varying float vRfLocalY;
flat varying vec4 vRfFx;
`;

const FRAGMENT_PARS = /* glsl */ `
#define RF_ZONE_VEC4 ${ZONE_VEC4}
uniform sampler2D rfNoise;
uniform vec4 rfZones[ ${R.maxZones * ZONE_VEC4} ];
uniform float rfTime;
uniform vec4 rfFlash; // rgb × intensity (reduce-flashing scaled), bump depth (m)
uniform vec2 rfFlashShape; // face-on share, fresnel power
uniform vec4 rfRimParams; // fresnel power, rim intensity, glow left when dead, emerge charge
uniform vec4 rfSeam; // rgb × intensity, band height (m)
uniform vec4 rfPulse; // vein speed, vein travel, vein pulse depth, glow pulse speed
varying vec4 vRfRestN;
varying float vRfLocalY;
flat varying vec4 vRfFx;
flat varying vec4 vRfInst;
flat varying vec4 vRfState;

struct RfSurface {
	vec3 albedo;
	float roughness;
	float metalness;
	float clearcoat;
	vec2 dHdxy;
	vec3 emissive;
	float glow;
	float pulse;
	float veins;
	float veinMask;
	float cells;
};

vec4 rfTriplanar( vec3 p, vec3 n ) {
	vec3 w = abs( n );
	w *= w;
	w *= w;
	w /= max( w.x + w.y + w.z, 1e-4 );
	return texture( rfNoise, p.yz ) * w.x + texture( rfNoise, p.zx ) * w.y + texture( rfNoise, p.xy ) * w.z;
}

RfSurface rfSurface() {
	int z = int( vRfState.x + 0.5 ) * RF_ZONE_VEC4;
	vec4 z0 = rfZones[ z ];
	vec4 z1 = rfZones[ z + 1 ];
	vec4 z2 = rfZones[ z + 2 ];
	vec4 z3 = rfZones[ z + 3 ];
	vec4 z4 = rfZones[ z + 4 ];
	vec4 z5 = rfZones[ z + 5 ];
	vec3 rn = normalize( vRfRestN.xyz );
	vec3 p = vRfDissolvePos * z3.z;
	vec4 t = rfTriplanar( p, rn );
	vec4 t2 = rfTriplanar( p * 2.37 + 11.3, rn );
	float blot = t.r * 0.7 + t2.r * 0.3;
	float cells = t.g;
	// Veins gather in patches (low-frequency mask) instead of covering the whole surface.
	float veins = max( t.b, t2.b * 0.6 ) * smoothstep( 0.48, 0.74, t.r );
	float pores = t2.a;
	RfSurface s;
	float seam = mix( 1.0, smoothstep( 0.0, 0.55, cells ), z3.w );
	vec3 base = mix( z0.rgb, z1.rgb, smoothstep( 0.3, 0.7, blot ) );
	base *= mix( 0.25, 1.0, seam );
	base = mix( base, z4.rgb, clamp( vRfRestN.w * vRfRestN.w * z4.w, 0.0, 1.0 ) );
	s.albedo = base;
	float wet = smoothstep( 0.3, 0.7, blot );
	s.roughness = clamp( z0.w * mix( 1.2, 0.8, wet ) * mix( 1.25, 1.0, seam ), 0.04, 1.0 );
	s.metalness = z1.w;
	s.clearcoat = z2.w * mix( 0.45, 1.0, wet ) * mix( 0.5, 1.0, seam );
	float h = ( seam * 0.7 + pores * 0.15 - veins * 0.4 ) * z3.y * rfFlash.w;
	s.dHdxy = vec2( dFdx( h ), dFdy( h ) );
	s.emissive = z2.rgb;
	s.glow = z5.x;
	s.pulse = z5.y;
	s.veins = z3.x;
	s.veinMask = veins;
	s.cells = cells;
	return s;
}

// Resolution-independent surface-gradient bump (unnormalized screen derivatives, height in meters).
vec3 rfPerturbNormal( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
	vec3 sx = dFdx( surfPos );
	vec3 sy = dFdy( surfPos );
	vec3 r1 = cross( sy, surfNorm );
	vec3 r2 = cross( surfNorm, sx );
	float det = dot( sx, r1 ) * faceDir;
	vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
	vec3 n = abs( det ) * surfNorm - grad;
	return dot( n, n ) > 1e-20 ? normalize( n ) : surfNorm;
}

// N: the geometric normal (three's nonPerturbedNormal) – fresnel rims follow the silhouette, not the bump.
vec3 rfEmissive( RfSurface s, vec3 N ) {
	vec3 V = normalize( vViewPosition );
	float ndv = clamp( dot( N, V ), 0.0, 1.0 );
	float fres = 1.0 - ndv;
	float seed = vRfInst.w * 6.283185307;
	float glowPulse = 1.0 - s.pulse * ( 0.5 + 0.5 * sin( rfTime * rfPulse.w + seed ) );
	float travel = sin( rfTime * rfPulse.x - ( vRfDissolvePos.y + vRfDissolvePos.z * 0.5 ) * rfPulse.y + seed );
	float veinPulse = mix( 1.0 - rfPulse.z, 1.0, 0.5 + 0.5 * travel );
	float veinLine = smoothstep( 0.12, 0.6, s.veinMask );
	float alive = mix( rfRimParams.z, 1.0, vRfState.z );
	// Organs glow through a cellular membrane, brighter face-on (thick translucent tissue).
	float organ = ( 0.4 + 0.6 * s.cells ) * ( 0.7 + 0.3 * ndv );
	vec3 e = s.emissive * ( s.glow * glowPulse * organ + s.veins * veinLine * veinPulse );
	e *= ( 1.0 + vRfState.y ) * alive;
	float emergeInv = vRfState.w;
	if ( emergeInv > 0.0 ) {
		float band = 1.0 - smoothstep( 0.0, rfSeam.w, vRfLocalY );
		float fade = smoothstep( 0.0, 0.15, emergeInv );
		e += rfSeam.rgb * fade * ( band * ( 0.55 + 0.45 * s.veinMask ) + rfRimParams.w * emergeInv * fres );
	}
	e += rfFlash.rgb * vRfFx.x * mix( rfFlashShape.x, 1.0, pow( fres, rfFlashShape.y ) );
	e += vRfInst.rgb * ( vRfFx.y * rfRimParams.y * pow( fres, rfRimParams.x ) );
	return e;
}
`;

const COMMON = '#include <common>';
const BEGIN_NORMAL = '#include <beginnormal_vertex>';
const BEGIN_VERTEX = '#include <begin_vertex>';
const CLIP_FRAGMENT = '#include <clipping_planes_fragment>';
const COLOR_FRAGMENT = '#include <color_fragment>';
const ROUGHNESS_FRAGMENT = '#include <roughnessmap_fragment>';
const METALNESS_FRAGMENT = '#include <metalnessmap_fragment>';
const NORMAL_MAPS_FRAGMENT = '#include <normal_fragment_maps>';
const EMISSIVE_FRAGMENT = '#include <emissivemap_fragment>';
const LIGHTS_PHYSICAL_FRAGMENT = '#include <lights_physical_fragment>';

function injectAfter(src: string | null, anchor: string, code: string): string | null {
  if (src === null) return null;
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  const end = i + anchor.length;
  return src.slice(0, end) + '\n' + code + src.slice(end);
}

/** Vertex shader with the rig deformation (color: position + normal; depth: position). */
export function patchEnemyVertex(src: string, depth: boolean): string | null {
  let out = injectAfter(src, COMMON, RIG_GLSL + (depth ? VERTEX_VARYINGS_DEPTH : VERTEX_VARYINGS_COLOR));
  if (depth) return injectAfter(out, BEGIN_VERTEX, VERTEX_DEFORM_DEPTH);
  out = injectAfter(out, BEGIN_NORMAL, VERTEX_DEFORM_COLOR);
  return injectAfter(out, BEGIN_VERTEX, VERTEX_ASSIGN_COLOR);
}

/** Physical fragment shader with the enemy surface, emissive effects, dissolve and emergence clip. */
export function patchEnemyFragment(src: string): string | null {
  // Our pars first: the dissolve pars then land right after <common>, before ours (vRfDissolvePos).
  let out = injectAfter(src, COMMON, FRAGMENT_PARS);
  out = out === null ? null : patchDissolveFragment(out, true, 'vRfFx.z');
  out = injectAfter(out, CLIP_FRAGMENT, FRAGMENT_EMERGE_CLIP);
  out = injectAfter(out, COLOR_FRAGMENT, 'RfSurface rfS = rfSurface();\ndiffuseColor.rgb *= rfS.albedo;');
  out = injectAfter(out, ROUGHNESS_FRAGMENT, 'roughnessFactor = rfS.roughness;');
  out = injectAfter(out, METALNESS_FRAGMENT, 'metalnessFactor = rfS.metalness;');
  out = injectAfter(
    out,
    NORMAL_MAPS_FRAGMENT,
    'normal = rfPerturbNormal( - vViewPosition, normal, rfS.dHdxy, faceDirection );',
  );
  out = injectAfter(
    out,
    EMISSIVE_FRAGMENT,
    'totalEmissiveRadiance += rfEmissive( rfS, nonPerturbedNormal );',
  );
  out = injectAfter(
    out,
    LIGHTS_PHYSICAL_FRAGMENT,
    '#ifdef USE_CLEARCOAT\n\tmaterial.clearcoat = saturate( rfS.clearcoat );\n#endif',
  );
  return out;
}

/** Depth / distance fragment shader with the dissolve and emergence clips. */
export function patchEnemyDepthFragment(src: string): string | null {
  let out = injectAfter(src, COMMON, FRAGMENT_DEPTH_PARS);
  out = out === null ? null : patchDissolveFragment(out, false, 'vRfFx.z');
  return injectAfter(out, CLIP_FRAGMENT, FRAGMENT_EMERGE_CLIP);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** Uniform objects shared by every enemy type (one write per frame updates all). */
export interface EnemySharedUniforms {
  readonly rfTime: { value: number };
  readonly rfNoise: { value: Texture | null };
  readonly rfFlash: { value: Vector4 };
  readonly rfFlashShape: { value: Vector2 };
  readonly rfRimParams: { value: Vector4 };
  readonly rfPulse: { value: Vector4 };
}

export function createSharedUniforms(noise: Texture | null): EnemySharedUniforms {
  const F = R.hitFlash;
  return {
    rfTime: { value: 0 },
    rfNoise: { value: noise },
    rfFlash: {
      value: new Vector4(
        F.color[0] * F.intensity,
        F.color[1] * F.intensity,
        F.color[2] * F.intensity,
        R.bumpDepth,
      ),
    },
    rfFlashShape: { value: new Vector2(F.faceOn, F.power) },
    rfRimParams: { value: new Vector4(R.rim.power, R.rim.intensity, R.deadGlow, R.emerge.charge) },
    rfPulse: {
      value: new Vector4(R.veinPulse.speed, R.veinPulse.travel, R.veinPulse.sharpness, R.glowPulse.speed),
    },
  };
}

/** Hit flash strength (accessibility: reduce flashing). Uniform write only. */
export function setFlashScale(shared: EnemySharedUniforms, scale: number): void {
  const F = R.hitFlash;
  const k = F.intensity * scale;
  shared.rfFlash.value.set(F.color[0] * k, F.color[1] * k, F.color[2] * k, R.bumpDepth);
}

/** Packed zone palette (ZONE_VEC4 vec4 per zone) in the rig's zone order. */
export function packZones(rig: CompiledRig, def: EnemyVisualDef): Float32Array {
  const out = new Float32Array(R.maxZones * ZONE_VEC4 * 4);
  rig.zoneNames.forEach((name, i) => {
    const z = def.zones[name]!;
    const o = i * ZONE_VEC4 * 4;
    const e = z.emissiveIntensity;
    out.set([z.color[0], z.color[1], z.color[2], z.roughness], o);
    out.set([z.color2[0], z.color2[1], z.color2[2], z.metalness], o + 4);
    out.set([z.emissive[0] * e, z.emissive[1] * e, z.emissive[2] * e, z.clearcoat], o + 8);
    out.set([z.veins, z.bump, z.scale, z.cells], o + 12);
    out.set([z.tip[0], z.tip[1], z.tip[2], z.tipAmount], o + 16);
    out.set([z.glow, z.pulse, 0, 0], o + 20);
  });
  return out;
}

export interface EnemyTypeUniforms {
  readonly rfRig: { value: DataTexture };
  /** Per-instance frustum culling reach (m at scale 1); 0 disables it. */
  readonly rfCullRadius: { value: number };
  readonly rfLayout: { value: Vector4 };
  readonly rfCounts: { value: Vector4 };
  readonly rfLook: { value: Vector2 };
  readonly rfZones: { value: Float32Array };
  readonly rfSeam: { value: Vector4 };
  readonly dissolve: DissolveUniforms;
}

export interface EnemyMaterialSet {
  readonly material: MeshPhysicalMaterial;
  readonly depth: MeshDepthMaterial;
  readonly distance: MeshDistanceMaterial;
  readonly uniforms: EnemyTypeUniforms;
  dispose(): void;
}

const warned = new Set<string>();

function install(
  material: Material,
  key: string,
  uniforms: Record<string, unknown>,
  vertex: (src: string) => string | null,
  fragment: (src: string) => string | null,
): void {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms): void => {
    const vs = vertex(shader.vertexShader);
    const fs = fragment(shader.fragmentShader);
    if (vs === null || fs === null) {
      if (!warned.has(key)) {
        warned.add(key);
        log.warn(`Enemy shader anchors missing in ${material.type} – enemies render undeformed`);
      }
      return;
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    Object.assign(shader.uniforms, uniforms);
  };
  material.customProgramCacheKey = (): string => key;
}

/**
 * Materials of one enemy type: the lit physical material and the shadow depth / distance
 * materials, all sharing the type's rig texture and uniforms. Call RenderApi.setupMaterial on
 * `material` afterwards (CSM). `cullRadius`: the type's reach around the feet for the
 * per-instance frustum culling (EnemyRenderer cullReach; 0 = draw every instance).
 */
export function createEnemyMaterials(
  type: string,
  rig: CompiledRig,
  def: EnemyVisualDef,
  rigTexture: DataTexture,
  shared: EnemySharedUniforms,
  cullRadius = 0,
): EnemyMaterialSet {
  const L = rig.layout;
  const D = def.dissolve;
  const dissolve = createDissolveUniforms({
    edgeWidth: D.edgeWidth,
    edgeColor: D.edgeColor,
    edgeIntensity: D.edgeIntensity,
    noiseScale: D.noiseScale,
    sweep: 0,
  });
  const seam = def.rift;
  const uniforms: EnemyTypeUniforms = {
    rfRig: { value: rigTexture },
    rfCullRadius: { value: Math.max(0, cullRadius) },
    rfLayout: { value: new Vector4(L.attackBase, L.boneBase, L.partBase, L.motionBase) },
    rfCounts: {
      value: new Vector4(rig.attackIds.length, rig.bones.length, rig.parts.length, rig.motionCount),
    },
    rfLook: { value: new Vector2(rig.lookYawMax, rig.lookPitchMax) },
    rfZones: { value: packZones(rig, def) },
    rfSeam: {
      value: new Vector4(
        seam.color[0] * seam.intensity,
        seam.color[1] * seam.intensity,
        seam.color[2] * seam.intensity,
        R.emerge.seamWidth,
      ),
    },
    dissolve,
  };
  const all: Record<string, unknown> = { ...shared, ...uniforms, ...dissolve };
  delete all.dissolve;

  const material = new MeshPhysicalMaterial({
    name: `enemy:${type}`,
    color: new Color(1, 1, 1),
    roughness: 0.5,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: R.clearcoatRoughness,
    emissive: new Color(0, 0, 0),
  });
  install(material, ENEMY_SHADER_KEY, all, (s) => patchEnemyVertex(s, false), patchEnemyFragment);

  const depth = new MeshDepthMaterial();
  depth.name = `enemy:${type}:depth`;
  install(depth, `${ENEMY_SHADER_KEY}-depth`, all, (s) => patchEnemyVertex(s, true), patchEnemyDepthFragment);
  const distance = new MeshDistanceMaterial();
  distance.name = `enemy:${type}:distance`;
  install(
    distance,
    `${ENEMY_SHADER_KEY}-distance`,
    all,
    (s) => patchEnemyVertex(s, true),
    patchEnemyDepthFragment,
  );

  return {
    material,
    depth,
    distance,
    uniforms,
    dispose(): void {
      material.dispose();
      depth.dispose();
      distance.dispose();
    },
  };
}
