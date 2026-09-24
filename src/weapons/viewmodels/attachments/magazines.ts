/**
 * Magazine and ammunition add-ons. Built per weapon in its magazine part's space (they ride the
 * reload motions with it) and sized from the magazine's own bounds (MagazineShape): extended
 * base, a coupled second magazine, a drum replacing the magazine, ammunition marker bands, an
 * energy capacitor pack, a heavy blast-charge cap.
 */
import { BoxGeometry, Vector3 } from 'three';
import { clamp } from '../../../core/math';
import { ATTACHMENT_ART } from '../../../defs/weaponOutfit';
import { VIEWMODEL_ART } from '../../../defs/viewmodels';
import { BODY, type ModelBuilder, type Vec3Tuple } from '../ModelBuilder';
import { cylinderX, roundedBox } from '../shapes';
import type { MagazineBuilder, MagazineShape } from './types';

const P = VIEWMODEL_ART.materials;
const A = ATTACHMENT_ART.magazine;
const AXES = ['x', 'y', 'z'] as const;

/** The magazine's frame: long axis `i`, cross axes `j` (thin) / `k`, sizes and ends. */
interface Frame {
  i: number;
  j: number;
  k: number;
  size: Vector3;
  center: Vector3;
  long: number;
  far: number;
  near: number;
  dir: number;
}

function frameOf(mag: MagazineShape): Frame {
  const size = mag.box.getSize(new Vector3());
  const center = mag.box.getCenter(new Vector3());
  const i = AXES.indexOf(mag.axis);
  const others = [0, 1, 2].filter((a) => a !== i);
  const [a, b] = others as [number, number];
  const thinFirst = size.getComponent(a) <= size.getComponent(b);
  const j = thinFirst ? a : b;
  const k = thinFirst ? b : a;
  const min = mag.box.min.getComponent(i);
  const max = mag.box.max.getComponent(i);
  return {
    i,
    j,
    k,
    size,
    center,
    long: size.getComponent(i),
    far: mag.dir > 0 ? max : min,
    near: mag.dir > 0 ? min : max,
    dir: mag.dir,
  };
}

/** Point: `along` on the long axis, offsets from the center on the cross axes. */
function at(f: Frame, along: number, dj = 0, dk = 0): Vec3Tuple {
  const v = [0, 0, 0];
  v[f.i] = along;
  v[f.j] = f.center.getComponent(f.j) + dj;
  v[f.k] = f.center.getComponent(f.k) + dk;
  return [v[0]!, v[1]!, v[2]!];
}

/** Box of `along` × (thin cross `sj`) × (wide cross `sk`) as xyz sizes. */
function dims(f: Frame, along: number, sj: number, sk: number): [number, number, number] {
  const v = [0, 0, 0];
  v[f.i] = along;
  v[f.j] = sj;
  v[f.k] = sk;
  return [v[0]!, v[1]!, v[2]!];
}

function box(b: ModelBuilder, mat: string, f: Frame, along: number, sj: number, sk: number, pos: Vec3Tuple, paint?: number): void {
  const [sx, sy, sz] = dims(f, along, sj, sk);
  const r = Math.min(sx, sy, sz) * 0.18;
  b.add(BODY, mat, r > 0.0004 ? roundedBox(sx, sy, sz, r) : new BoxGeometry(sx, sy, sz), { pos, paint });
}

/** A glowing band around the magazine `frac` of the way from the well. */
function band(b: ModelBuilder, f: Frame, frac: number): void {
  const along = f.near + f.dir * f.long * frac;
  box(b, 'band', f, A.bandWidth, f.size.getComponent(f.j) * 1.06, f.size.getComponent(f.k) * 1.04, at(f, along));
}

export const buildExtMag: MagazineBuilder = (b, mag) => {
  const f = frameOf(mag);
  const ext = clamp(f.long * A.extension, A.minExtension, A.maxExtension);
  const sj = f.size.getComponent(f.j);
  const sk = f.size.getComponent(f.k);
  box(b, 'polymer', f, ext, sj * 0.94, sk * 0.94, at(f, f.far + (f.dir * ext) / 2), P.polymer.paint);
  box(b, 'darkMetal', f, 0.006, sj * 1.08, sk * 1.1, at(f, f.far + f.dir * (ext + 0.002)), P.darkMetal.paint);
  box(b, 'accent', f, ext * 0.7, sj * 0.96, 0.0015, at(f, f.far + (f.dir * ext) / 2, 0, sk * 0.47));
  return {};
};

/** Coupled magazines: the second one (a copy of the weapon's) rides beside the first. */
export const buildFastMag: MagazineBuilder = (b, mag) => {
  const f = frameOf(mag);
  const sj = f.size.getComponent(f.j);
  const sk = f.size.getComponent(f.k);
  const offset = sj + A.coupleGap;
  for (const frac of [0.3, 0.72]) {
    box(b, 'darkMetal', f, 0.009, offset + sj * 1.15, sk * 1.06, at(f, f.near + f.dir * f.long * frac, offset / 2), P.darkMetal.paint);
  }
  box(b, 'grip', f, 0.004, sj * 0.7, sk * 0.5, at(f, f.far + f.dir * 0.004, offset / 2));
  box(b, 'accent', f, 0.0015, offset + sj * 1.17, sk * 1.07, at(f, f.near + f.dir * f.long * 0.3, offset / 2));
  const dup = [0, 0, 0];
  dup[f.j] = offset;
  return { duplicateMagazine: [dup[0]!, dup[1]!, dup[2]!] };
};

/** Drum: replaces the magazine with a round drum under a feed neck. */
export const buildDrum: MagazineBuilder = (b, mag) => {
  const f = frameOf(mag);
  const sj = f.size.getComponent(f.j);
  const sk = f.size.getComponent(f.k);
  const r = clamp(f.long * A.drumRadius, A.minDrum, A.maxDrum);
  const neck = Math.max(A.drumNeck, f.long * 0.18);
  const thick = clamp(r * 0.9, sj * 1.2, r * 1.1);
  box(b, 'darkMetal', f, neck + 0.01, sj, sk, at(f, f.near + (f.dir * (neck + 0.01)) / 2), P.darkMetal.paint);
  const c = at(f, f.near + f.dir * (neck + r * 0.85));
  // The drum's axis is the thin cross axis (a side-on disc).
  const rot: Vec3Tuple = f.j === 0 ? [0, 0, 0] : f.j === 1 ? [0, 0, 90] : [0, 90, 0];
  b.add(BODY, 'darkMetal', cylinderX(r, thick, 32), { pos: c, rot, paint: P.darkMetal.paint });
  b.add(BODY, 'gunmetal', cylinderX(r * 0.72, thick + 0.003, 28), { pos: c, rot });
  b.add(BODY, 'accent', cylinderX(r * 1.01, thick * 0.12, 32), { pos: c, rot });
  b.add(BODY, 'grip', cylinderX(r * 0.2, thick + 0.012, 14), { pos: c, rot });
  return { replacesMagazine: true };
};

export const buildOverpressure: MagazineBuilder = (b, mag) => {
  const f = frameOf(mag);
  band(b, f, ATTACHMENT_ART.magazine.bandAt);
  band(b, f, ATTACHMENT_ART.magazine.bandAt + 0.12);
  return {};
};

export const buildApRound: MagazineBuilder = (b, mag) => {
  const f = frameOf(mag);
  band(b, f, ATTACHMENT_ART.magazine.bandAt);
  box(
    b,
    'darkMetal',
    f,
    0.004,
    f.size.getComponent(f.j) * 1.04,
    f.size.getComponent(f.k) * 1.04,
    at(f, f.far + f.dir * 0.002),
    P.darkMetal.paint,
  );
  return {};
};

/** Energy capacitor pack clamped to the side of the cell. */
export const buildCapacitor: MagazineBuilder = (b, mag) => {
  const f = frameOf(mag);
  const sj = f.size.getComponent(f.j);
  const sk = f.size.getComponent(f.k);
  const packJ = Math.max(0.012, sj * 0.5);
  const off = sj / 2 + packJ / 2;
  box(b, 'darkMetal', f, f.long * 0.72, packJ, sk * 0.8, at(f, f.center.getComponent(f.i), off), P.darkMetal.paint);
  for (const frac of [0.3, 0.5, 0.7]) {
    box(b, 'band', f, 0.004, packJ * 1.08, sk * 0.84, at(f, f.near + f.dir * f.long * frac, off));
  }
  return {};
};

/** Heavy blast charges: an armored cap with hazard marks and a glowing ring. */
export const buildHeavyLoad: MagazineBuilder = (b, mag) => {
  const f = frameOf(mag);
  const sj = f.size.getComponent(f.j);
  const sk = f.size.getComponent(f.k);
  const cap = clamp(f.long * 0.22, 0.014, 0.034);
  box(b, 'darkMetal', f, cap, sj * 1.12, sk * 1.12, at(f, f.far - (f.dir * cap) / 2 + f.dir * 0.006), P.darkMetal.paint);
  box(b, 'accentPaint', f, cap * 0.3, sj * 1.14, sk * 1.14, at(f, f.far - f.dir * cap * 0.6 + f.dir * 0.006), P.accentPaint.paint);
  box(b, 'band', f, 0.003, sj * 1.15, sk * 1.15, at(f, f.far - f.dir * cap * 0.15 + f.dir * 0.006));
  return {};
};
