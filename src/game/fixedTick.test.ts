import { describe, expect, it } from 'vitest';
import { Group, Vector3 } from 'three';
import type { CombatWorldApi, DamageInfo, DamageResult, Damageable, Hitbox } from '../core/contracts';
import { EventBus } from '../core/EventBus';
import type { GameEvents, HitZone } from '../core/events';
import { PHYSICS } from '../defs/physics';
import { TrainingTargets } from '../world/TrainingTargets';
import { runFixedTick, type FixedTickSystems } from './fixedTick';

const DT = 1 / 60;

function recorder(calls: string[]): FixedTickSystems {
  const step = (name: string) => ({ fixedUpdate: () => void calls.push(name) });
  return {
    player: {
      ...step('player'),
      noclip: false,
      position: new Vector3(0, 1, 0),
      teleport: () => void calls.push('teleport'),
    },
    weapons: step('weapons'),
    targets: step('targets'),
    waves: step('waves'),
    enemies: step('enemies'),
    runFlow: step('runFlow'),
    interaction: step('interaction'),
    interactables: step('interactables'),
    powerUps: step('powerUps'),
    perks: step('perks'),
    physics: { step: () => void calls.push('physics') },
    health: step('health'),
    level: {
      spawn: { position: new Vector3(1, 2, 3), yaw: 0.5 },
      fixedUpdate: () => void calls.push('level'),
    },
  };
}

class FakeCombat implements CombatWorldApi {
  readonly targets: Damageable[] = [];
  register(t: Damageable): void {
    this.targets.push(t);
  }
  unregister(t: Damageable): void {
    const i = this.targets.indexOf(t);
    if (i >= 0) this.targets.splice(i, 1);
  }
  raycast(): null {
    return null;
  }
  queryRadius(_c: unknown, _r: number, out: Damageable[]): Damageable[] {
    return out;
  }
  dealDamage(t: Damageable, info: DamageInfo): DamageResult {
    return t.applyDamage(info);
  }
  lineOfSight(): boolean {
    return true;
  }
}

function box(d: Damageable, zone: HitZone): Hitbox {
  const b = d.hitboxes.find((h) => h.zone === zone);
  if (!b) throw new Error(`no ${zone} hitbox`);
  return b;
}

describe('runFixedTick', () => {
  it('steps player → interaction → weapons → targets → waves → enemies → interactables → powerUps → physics → health → perks → level → runFlow', () => {
    const calls: string[] = [];
    runFixedTick(recorder(calls), DT);
    expect(calls).toEqual([
      'player',
      'interaction',
      'weapons',
      'targets',
      'waves',
      'enemies',
      'interactables',
      'powerUps',
      'physics',
      'health',
      'perks',
      'level',
      'runFlow',
    ]);
  });

  it('runs without targets and returns a player below the kill plane to spawn before the step', () => {
    const calls: string[] = [];
    const s = recorder(calls);
    s.targets = null;
    s.waves = null;
    s.enemies = null;
    s.runFlow = null;
    s.interaction = null;
    s.interactables = null;
    s.powerUps = null;
    s.perks = null;
    s.player.position.y = PHYSICS.killPlaneY - 1;
    runFixedTick(s, DT);
    expect(calls).toEqual(['player', 'weapons', 'teleport', 'physics', 'health', 'level']);

    calls.length = 0;
    s.player.noclip = true;
    runFixedTick(s, DT);
    expect(calls).not.toContain('teleport');
  });

  it("resolves shots against the previous tick's hitboxes: at most one tick ahead of the rendered model", () => {
    // Mid-rail dummy as in the calibration hall range lane (fast eased section).
    const events = new EventBus<GameEvents>();
    const targets = new TrainingTargets({
      scene: new Group(),
      combat: new FakeCombat(),
      events,
      physics: null,
      render: { setupMaterial: () => {} },
      placements: [
        {
          type: 'dummy',
          position: [-9.5, 0, -22],
          yawDeg: 0,
          rail: { to: [9.5, 0, -22], speed: 2.4, pause: 0 },
        },
      ],
    });
    const d = targets.dummies[0]!;
    const alpha = 0.25;
    let rendered = Number.NaN;
    let endOfTickWeakpoint = Number.NaN;
    const ends: number[] = [];
    let checked = 0;
    const s = recorder([]);
    s.targets = targets;
    s.weapons = {
      fixedUpdate: () => {
        if (ends.length < 2) return;
        // Exactly the hitbox the previous tick ended with...
        expect(box(d, 'weakpoint').a.x).toBe(endOfTickWeakpoint);
        // ...which leads the rendered model (lerp(prev, cur, alpha)) by (1 − alpha) ticks of travel.
        const tick = Math.abs(ends[ends.length - 1]! - ends[ends.length - 2]!);
        const lead = Math.abs(d.position.x - rendered);
        expect(lead).toBeLessThanOrEqual(tick * (1 - alpha) + 1e-9);
        checked++;
      },
    };
    for (let frame = 0; frame < 240; frame++) {
      runFixedTick(s, DT);
      endOfTickWeakpoint = box(d, 'weakpoint').a.x;
      ends.push(d.position.x);
      targets.update(DT, alpha);
      rendered = d.root.position.x;
    }
    expect(checked).toBeGreaterThan(200);
    // The rail really moved (the lead check is not vacuous).
    expect(Math.abs(ends[ends.length - 1]! - ends[0]!)).toBeGreaterThan(2);
    targets.dispose();
  });
});
