import { describe, expect, it } from 'vitest';
import {
  accelerate,
  addUniqueNormal,
  advanceGait,
  airAccelerate,
  applyFriction,
  applyLinearFriction,
  canGroundJump,
  classifyLanding,
  clipVelocity,
  consumeDashCharge,
  doubleJumpRedirect,
  effectiveGravity,
  horizontalSpeed,
  integrateVertical,
  jumpVelocity,
  ledgeHeightOk,
  mantleCurve,
  mantleDuration,
  pairSupportNormal,
  rechargeDash,
  slopeAcceleration,
  slopeAngle,
  steerTowards,
  tickDown,
  type DashChargeState,
  type GaitState,
  type MantleCurve,
  type VerticalStep,
} from './movementMath';
import { MOVEMENT } from '../defs/movement';

const DT = 1 / 60;
const G = MOVEMENT.ground;
const A = MOVEMENT.air;

describe('applyFriction', () => {
  it('never reverses velocity and monotonically slows down', () => {
    for (const speed of [0.1, 1, 2.5, 6.6, 9.4, 30]) {
      for (const angle of [0, 1, 2.5, -2]) {
        const v = { x: Math.cos(angle) * speed, z: Math.sin(angle) * speed };
        let prev = speed;
        for (let i = 0; i < 200; i++) {
          const ox = v.x;
          const oz = v.z;
          applyFriction(v, G.friction, G.stopSpeed, DT);
          // Same direction (dot >= 0) and never faster.
          expect(v.x * ox + v.z * oz).toBeGreaterThanOrEqual(0);
          const s = horizontalSpeed(v);
          expect(s).toBeLessThanOrEqual(prev + 1e-12);
          prev = s;
        }
        expect(horizontalSpeed(v)).toBe(0);
      }
    }
  });

  it('even huge dt only stops, never flips', () => {
    const v = { x: 5, z: -3 };
    applyFriction(v, G.friction, G.stopSpeed, 10);
    expect(v.x).toBe(0);
    expect(v.z).toBe(0);
  });

  it('stops from run speed quickly (< 0.35 s)', () => {
    const v = { x: G.runSpeed, z: 0 };
    let t = 0;
    while (horizontalSpeed(v) > 0 && t < 2) {
      applyFriction(v, G.friction, G.stopSpeed, DT);
      t += DT;
    }
    expect(t).toBeLessThan(0.35);
  });
});

describe('applyLinearFriction', () => {
  it('decelerates at a constant rate and never reverses', () => {
    const v = { x: 6, z: -8 };
    applyLinearFriction(v, 6, 0.5);
    expect(horizontalSpeed(v)).toBeCloseTo(7, 9);
    expect(v.x).toBeGreaterThan(0);
    expect(v.z).toBeLessThan(0);
    applyLinearFriction(v, 6, 10);
    expect(v).toEqual({ x: 0, z: 0 });
  });

  it('steep slopes out-accelerate the slide deceleration, gentle ones do not', () => {
    const S = MOVEMENT.slide;
    const accelOn = (deg: number): number => {
      const t = (deg * Math.PI) / 180;
      const out = { x: 0, z: 0 };
      slopeAcceleration({ x: Math.sin(t), y: Math.cos(t), z: 0 }, A.gravity * S.slopeAccelMultiplier, out);
      return Math.hypot(out.x, out.z);
    };
    expect(accelOn(10)).toBeLessThan(S.deceleration);
    expect(accelOn(25)).toBeGreaterThan(S.deceleration);
  });
});

describe('accelerate', () => {
  it('never exceeds wishSpeed along wishDir', () => {
    const dirs = [
      { x: 1, z: 0 },
      { x: 0, z: -1 },
      { x: Math.SQRT1_2, z: Math.SQRT1_2 },
    ];
    for (const d of dirs) {
      for (const start of [
        { x: 0, z: 0 },
        { x: -5, z: 2 },
        { x: 3, z: 3 },
      ]) {
        const v = { ...start };
        for (let i = 0; i < 120; i++) {
          accelerate(v, d, G.runSpeed, G.acceleration, DT);
          expect(v.x * d.x + v.z * d.z).toBeLessThanOrEqual(G.runSpeed + 1e-9);
        }
        expect(v.x * d.x + v.z * d.z).toBeCloseTo(G.runSpeed, 6);
      }
    }
  });

  it('does not slow down velocity that is already faster than wishSpeed', () => {
    const v = { x: 20, z: 0 };
    const added = accelerate(v, { x: 1, z: 0 }, G.runSpeed, G.acceleration, DT);
    expect(added).toBe(0);
    expect(v.x).toBe(20);
  });

  it('with friction reaches ~90% of run and sprint speed in about 0.1 s', () => {
    for (const W of [G.runSpeed, G.sprintSpeed, G.crouchSpeed]) {
      const v = { x: 0, z: 0 };
      let t = 0;
      while (v.x < 0.9 * W && t < 1) {
        applyFriction(v, G.friction, G.stopSpeed, DT);
        accelerate(v, { x: 1, z: 0 }, W, G.acceleration, DT);
        t += DT;
      }
      expect(t).toBeLessThan(0.15);
      // Steady state is exactly the wish speed.
      for (let i = 0; i < 120; i++) {
        applyFriction(v, G.friction, G.stopSpeed, DT);
        accelerate(v, { x: 1, z: 0 }, W, G.acceleration, DT);
      }
      expect(v.x).toBeCloseTo(W, 6);
    }
  });
});

describe('airAccelerate', () => {
  it('strafe gain per tick is bounded by the wish speed cap', () => {
    for (const speed of [2, 6.6, 10, 14]) {
      const v = { x: speed, z: 0 };
      // Perpendicular wish direction: the classic air-strafe case.
      airAccelerate(v, { x: 0, z: 1 }, G.runSpeed, A.wishSpeedCap, A.acceleration, DT, A.maxAirStrafeSpeed);
      const after = horizontalSpeed(v);
      expect(after).toBeLessThanOrEqual(Math.sqrt(speed * speed + A.wishSpeedCap * A.wishSpeedCap) + 1e-9);
    }
  });

  it('perfect strafing cannot exceed maxAirStrafeSpeed', () => {
    const v = { x: 8, z: 0 };
    for (let i = 0; i < 60 * 20; i++) {
      // Wish direction always perpendicular to the current velocity (optimal strafe).
      const s = horizontalSpeed(v);
      const wish = { x: -v.z / s, z: v.x / s };
      airAccelerate(v, wish, G.sprintSpeed, A.wishSpeedCap, A.acceleration, DT, A.maxAirStrafeSpeed);
    }
    expect(horizontalSpeed(v)).toBeLessThanOrEqual(A.maxAirStrafeSpeed + 1e-9);
  });

  it('preserves momentum above the cap (dash) but does not add to it', () => {
    const v = { x: 20, z: 0 };
    airAccelerate(v, { x: 0, z: 1 }, G.runSpeed, A.wishSpeedCap, A.acceleration, DT, A.maxAirStrafeSpeed);
    expect(horizontalSpeed(v)).toBeLessThanOrEqual(20 + 1e-9);
    expect(horizontalSpeed(v)).toBeGreaterThan(19.9);
  });

  it('can brake against the current velocity', () => {
    const v = { x: 5, z: 0 };
    for (let i = 0; i < 30; i++)
      airAccelerate(v, { x: -1, z: 0 }, G.runSpeed, A.wishSpeedCap, A.acceleration, DT, A.maxAirStrafeSpeed);
    expect(v.x).toBeLessThan(5);
  });
});

describe('steerTowards', () => {
  it('rotates the velocity without changing speed', () => {
    const v = { x: 10, z: 0 };
    for (let i = 0; i < 30; i++) {
      steerTowards(v, { x: 0, z: 1 }, A.airControl, DT);
      expect(horizontalSpeed(v)).toBeCloseTo(10, 9);
    }
    expect(v.z).toBeGreaterThan(0);
  });

  it('ignores backwards input', () => {
    const v = { x: 10, z: 0 };
    steerTowards(v, { x: -1, z: 0 }, A.airControl, DT);
    expect(v.x).toBe(10);
  });
});

describe('jump', () => {
  function apex(v0: number, held: boolean): number {
    const def = A;
    const step: VerticalStep = { dy: 0, vy: 0 };
    let y = 0;
    let vy = v0;
    let maxY = 0;
    for (let i = 0; i < 600 && (vy > 0 || i === 0); i++) {
      const g = effectiveGravity(vy, true, held, def);
      integrateVertical(vy, g, def.terminalVelocity, DT, step);
      y += step.dy;
      vy = step.vy;
      maxY = Math.max(maxY, y);
    }
    return maxY;
  }

  it('reaches the configured apex height at 60 Hz within 5%', () => {
    for (const h of [MOVEMENT.jump.height, MOVEMENT.jump.doubleJumpHeight, 0.5, 3]) {
      const top = apex(jumpVelocity(h, A.gravity), true);
      expect(Math.abs(top - h) / h).toBeLessThan(0.05);
    }
  });

  it('releasing jump early (jump cut) gives a lower apex', () => {
    const v0 = jumpVelocity(MOVEMENT.jump.height, A.gravity);
    expect(apex(v0, false)).toBeLessThan(apex(v0, true) * 0.8);
  });

  it('falls faster than it rises and respects terminal velocity', () => {
    expect(effectiveGravity(-1, false, false, A)).toBeGreaterThan(effectiveGravity(1, false, false, A));
    const step: VerticalStep = { dy: 0, vy: 0 };
    let vy = 0;
    for (let i = 0; i < 1000; i++)
      vy = integrateVertical(vy, effectiveGravity(vy, false, false, A), A.terminalVelocity, DT, step).vy;
    expect(vy).toBe(-A.terminalVelocity);
  });

  it('v = sqrt(2gh)', () => {
    expect(jumpVelocity(1.3, 23)).toBeCloseTo(Math.sqrt(2 * 23 * 1.3), 10);
    expect(jumpVelocity(-1, 23)).toBe(0);
  });
});

describe('coyote time and jump buffer', () => {
  const J = MOVEMENT.jump;

  it('allows a ground jump within the coyote window only', () => {
    expect(canGroundJump(true, 0, J.coyoteTime, false, 0)).toBe(true);
    expect(canGroundJump(false, J.coyoteTime * 0.9, J.coyoteTime, false, 0)).toBe(true);
    expect(canGroundJump(false, J.coyoteTime + DT, J.coyoteTime, false, 0)).toBe(false);
    // Already jumped (coyote cannot be reused) or cooldown.
    expect(canGroundJump(false, 0.01, J.coyoteTime, true, 0)).toBe(false);
    expect(canGroundJump(true, 0, J.coyoteTime, false, 0.05)).toBe(false);
  });

  it('coyote window counted in ticks matches the configured time', () => {
    let t = 0;
    let ticksAllowed = 0;
    for (let i = 0; i < 60; i++) {
      t += DT;
      if (canGroundJump(false, t, J.coyoteTime, false, 0)) ticksAllowed++;
    }
    expect(ticksAllowed).toBe(Math.floor(J.coyoteTime / DT + 1e-9));
  });

  it('a buffered press survives bufferTime and then expires', () => {
    let buffer: number = J.bufferTime;
    let ticks = 0;
    while (buffer > 0) {
      buffer = tickDown(buffer, DT);
      ticks++;
    }
    expect(ticks).toBe(Math.ceil(J.bufferTime / DT - 1e-9));
    expect(tickDown(0, DT)).toBe(0);
  });
});

describe('double jump redirect', () => {
  it('redirects towards input without exceeding max(current, cap)', () => {
    const v = { x: 9, z: 0 };
    doubleJumpRedirect(v, { x: 0, z: 1 }, true, MOVEMENT.jump.doubleJumpDirectionalBoost, G.sprintSpeed);
    expect(v.z).toBeGreaterThan(0);
    expect(horizontalSpeed(v)).toBeLessThanOrEqual(G.sprintSpeed + 1e-9);
    const slow = { x: 0, z: 0 };
    doubleJumpRedirect(slow, { x: 1, z: 0 }, true, MOVEMENT.jump.doubleJumpDirectionalBoost, G.sprintSpeed);
    expect(slow.x).toBeCloseTo(MOVEMENT.jump.doubleJumpDirectionalBoost, 9);
    const none = { x: 3, z: 0 };
    doubleJumpRedirect(none, { x: 0, z: 1 }, false, 5, 1);
    expect(none).toEqual({ x: 3, z: 0 });
  });
});

describe('slope acceleration', () => {
  it('is zero on flat ground and points downhill with g·sinθ·cosθ', () => {
    const out = { x: 0, z: 0 };
    slopeAcceleration({ x: 0, y: 1, z: 0 }, 23, out);
    expect(out.x).toBe(0);
    expect(out.z).toBe(0);
    const theta = (30 * Math.PI) / 180;
    // Surface descending towards +x: normal tilts towards +x.
    const n = { x: Math.sin(theta), y: Math.cos(theta), z: 0 };
    slopeAcceleration(n, 23, out);
    expect(out.x).toBeGreaterThan(0);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(23 * Math.sin(theta) * Math.cos(theta), 9);
    expect(slopeAngle(n)).toBeCloseTo(theta, 9);
  });
});

describe('dash charges', () => {
  const D = MOVEMENT.dash;

  it('recharge sequentially, one charge per rechargeTime', () => {
    const s: DashChargeState = { charges: D.charges, progress: 0 };
    expect(consumeDashCharge(s)).toBe(true);
    expect(consumeDashCharge(s)).toBe(true);
    expect(consumeDashCharge(s)).toBe(false);
    expect(s.charges).toBe(0);
    const ticksPerCharge = Math.round(D.rechargeTime / DT);
    for (let i = 0; i < ticksPerCharge - 2; i++) rechargeDash(s, D.charges, D.rechargeTime, DT);
    expect(s.charges).toBe(0);
    expect(s.progress).toBeGreaterThan(0.9);
    for (let i = 0; i < 3; i++) rechargeDash(s, D.charges, D.rechargeTime, DT);
    expect(s.charges).toBe(1);
    // The second charge starts from (almost) zero – sequential, not parallel.
    expect(s.progress).toBeLessThan(0.05);
    for (let i = 0; i < ticksPerCharge + 2; i++) rechargeDash(s, D.charges, D.rechargeTime, DT);
    expect(s.charges).toBe(2);
    expect(s.progress).toBe(0);
    for (let i = 0; i < 500; i++) rechargeDash(s, D.charges, D.rechargeTime, DT);
    expect(s.charges).toBe(D.charges);
  });

  it('a huge dt refills at most up to max', () => {
    const s: DashChargeState = { charges: 0, progress: 0 };
    rechargeDash(s, 2, 1, 100);
    expect(s).toEqual({ charges: 2, progress: 0 });
  });
});

describe('mantle', () => {
  const M = MOVEMENT.mantle;

  it('accepts ledges only within the height window', () => {
    expect(ledgeHeightOk(1.0, true, M)).toBe(true);
    expect(ledgeHeightOk(M.minHeight - 0.01, true, M)).toBe(false);
    expect(ledgeHeightOk(M.minHeight - 0.01, false, M)).toBe(true);
    expect(ledgeHeightOk(M.airMinHeight - 0.01, false, M)).toBe(false);
    expect(ledgeHeightOk(M.maxHeight + 0.01, true, M)).toBe(false);
  });

  it('duration scales with height', () => {
    expect(mantleDuration(M.maxHeight, M.maxHeight, M.duration, M.minDurationFraction)).toBeCloseTo(
      M.duration,
      9,
    );
    expect(mantleDuration(0, M.maxHeight, M.duration, M.minDurationFraction)).toBeCloseTo(
      M.duration * M.minDurationFraction,
      9,
    );
  });

  it('curve goes up first, then forward, monotonically from 0 to 1', () => {
    const c: MantleCurve = { vertical: 0, horizontal: 0 };
    mantleCurve(0, M.upPortion, M.forwardStart, c);
    expect(c).toEqual({ vertical: 0, horizontal: 0 });
    let pv = 0;
    let ph = 0;
    for (let i = 1; i <= 100; i++) {
      mantleCurve(i / 100, M.upPortion, M.forwardStart, c);
      expect(c.vertical).toBeGreaterThanOrEqual(pv);
      expect(c.horizontal).toBeGreaterThanOrEqual(ph);
      pv = c.vertical;
      ph = c.horizontal;
      // Early phase: mostly vertical.
      if (i / 100 <= M.forwardStart) expect(c.horizontal).toBe(0);
    }
    expect(c.vertical).toBe(1);
    expect(c.horizontal).toBe(1);
    mantleCurve(M.upPortion, M.upPortion, M.forwardStart, c);
    expect(c.vertical).toBe(1);
  });
});

describe('gait', () => {
  it('emits one footstep per stride', () => {
    const g: GaitState = { phase: 0 };
    let steps = 0;
    for (let i = 0; i < 600; i++) steps += advanceGait(g, G.runSpeed * DT, MOVEMENT.footsteps.strideRun);
    // 10 s at run speed = 66 m / 2.1 m stride.
    expect(steps).toBe(Math.floor((G.runSpeed * 10) / MOVEMENT.footsteps.strideRun + 1e-9));
    expect(advanceGait(g, 0, 2)).toBe(0);
  });
});

describe('landing', () => {
  it('classifies impacts', () => {
    const L = MOVEMENT.landing;
    const out = { emit: false, heavy: false };
    expect(classifyLanding(1, L.minImpactSpeed, L.heavyImpactSpeed, out)).toEqual({
      emit: false,
      heavy: false,
    });
    expect(classifyLanding(5, L.minImpactSpeed, L.heavyImpactSpeed, out)).toEqual({
      emit: true,
      heavy: false,
    });
    expect(classifyLanding(15, L.minImpactSpeed, L.heavyImpactSpeed, out)).toEqual({
      emit: true,
      heavy: true,
    });
  });
});

describe('clipVelocity', () => {
  it('removes only the component into the surface', () => {
    const v = { x: 5, y: 2, z: 1 };
    clipVelocity(v, { x: -1, y: 0, z: 0 });
    expect(v).toEqual({ x: 0, y: 2, z: 1 });
    const away = { x: -5, y: 0, z: 0 };
    clipVelocity(away, { x: -1, y: 0, z: 0 });
    expect(away.x).toBe(-5);
    const up = { x: 0, y: 4, z: 0 };
    clipVelocity(up, { x: 0, y: -1, z: 0 });
    expect(up.y).toBe(0);
  });
});

describe('two-contact support (V crevices)', () => {
  const walkableCos = Math.cos(MOVEMENT.ground.maxSlopeDeg * (Math.PI / 180));
  const slope = (deg: number, dirZ: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: 0, y: Math.cos(a), z: Math.sin(a) * dirZ };
  };
  const support = (...normals: { x: number; y: number; z: number }[]) => {
    const buf = new Float64Array(8 * 3);
    let n = 0;
    for (const nrm of normals) n = addUniqueNormal(buf, n, nrm, 0.999);
    const out = { x: 0, y: 0, z: 0 };
    return { y: pairSupportNormal(buf, n, out), out, n };
  };

  it('stores each surface once and never overflows the buffer', () => {
    const buf = new Float64Array(2 * 3);
    let n = addUniqueNormal(buf, 0, slope(60, 1), 0.999);
    n = addUniqueNormal(buf, n, slope(60, 1), 0.999);
    expect(n).toBe(1);
    n = addUniqueNormal(buf, n, slope(60, -1), 0.999);
    n = addUniqueNormal(buf, n, { x: 1, y: 0, z: 0 }, 0.999);
    expect(n).toBe(2);
  });

  it('a symmetric V of too-steep slopes supports like flat ground', () => {
    const r = support(slope(60, 1), slope(60, 1), slope(60, -1), slope(60, -1), slope(60, 1));
    expect(r.n).toBe(2);
    expect(r.y).toBeCloseTo(1, 9);
    expect(r.out.z).toBeCloseTo(0, 9);
  });

  it('a steep slope running into a wall supports, one beside a side wall or away from a wall does not', () => {
    // Slope normal leans towards +z: downhill is +z, into a wall facing -z.
    expect(support(slope(60, 1), { x: 0, y: 0, z: -1 }).y).toBeGreaterThanOrEqual(walkableCos);
    expect(support(slope(60, 1), { x: 1, y: 0, z: 0 }).y).toBeLessThan(walkableCos);
    expect(support(slope(60, 1), { x: 0, y: 0, z: 1 }).y).toBeLessThan(walkableCos);
  });

  it('needs two different surfaces', () => {
    expect(support(slope(60, 1)).y).toBe(-2);
    expect(support(slope(60, 1), slope(60, 1)).y).toBe(-2);
    expect(support().y).toBe(-2);
  });
});
