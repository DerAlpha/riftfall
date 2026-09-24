import { afterAll, describe, expect, it } from 'vitest';
import type { MeshStandardMaterial } from 'three';
import { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { ABILITIES } from '../defs/abilities';
import { VIEWMODEL_ANIM } from '../defs/viewmodels';
import { ViewmodelAnimator } from '../weapons/ViewmodelAnimator';
import { WeaponMaterialKit, createWeaponViewmodel, type WeaponViewmodelModel } from '../weapons/viewmodels';

/** Überladung: the viewmodel's accent glows (def weaponGlow) while the effect runs. */
const kit = new WeaponMaterialKit();
let model: WeaponViewmodelModel | null = null;
afterAll(() => {
  model?.dispose();
  kit.dispose();
});

function accentOf(m: WeaponViewmodelModel): MeshStandardMaterial {
  let found: MeshStandardMaterial | null = null;
  m.root.traverse((o) => {
    const mat = (o as { material?: MeshStandardMaterial }).material;
    if (mat?.name === 'vm-accent') found = mat;
  });
  if (!found) throw new Error('no accent');
  return found;
}

describe('ability weapon glow (ViewmodelAnimator)', () => {
  it('eases the accent up while a glowing ability runs and back after ability:ended', () => {
    const events = new EventBus<GameEvents>();
    const anim = new ViewmodelAnimator({
      events,
      showModel: (id) => (id ? (model ??= createWeaponViewmodel(id, kit)) : null),
    });
    anim.snapTo('pistol');
    const step = (s: number): void => {
      for (let i = 0; i < Math.round(s * 60); i++) anim.update(1 / 60, 0, 0);
    };
    // Readings one accent pulse period apart share the pulse phase.
    const period = (2 * Math.PI) / VIEWMODEL_ANIM.accentPulse.rate;
    step(period);
    const accent = accentOf(model!);
    const base = accent.emissiveIntensity;
    const def = ABILITIES.ueberladung;
    events.emit('ability:used', { abilityId: def.id, cooldown: def.cooldown, duration: def.duration });
    step(period);
    // The accent pulses a little: compare against the boost with margin.
    expect(accent.emissiveIntensity - base).toBeGreaterThan(def.weaponGlow * 0.7);
    events.emit('ability:ended', { abilityId: def.id });
    step(period);
    expect(accent.emissiveIntensity - base).toBeLessThan(def.weaponGlow * 0.1);
    // Abilities without a glow (Schockwelle) add none.
    events.emit('ability:used', { abilityId: 'schockwelle', cooldown: 18, duration: 0 });
    step(period);
    expect(accent.emissiveIntensity - base).toBeLessThan(def.weaponGlow * 0.1);
    anim.dispose();
  });
});
