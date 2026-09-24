/**
 * Meta progression toasts (M9, top right): level up, prestige, achievement unlocked, challenge
 * completed, weapon level milestones and cosmetic unlocks. Game time (Hud.update): toasts raised
 * while a menu is open (the run end behind the game over screen) wait and show once play resumes.
 *
 * At most PROGRESSION_TOASTS.visible toasts show at once (a fixed pool of DOM slots, text written
 * when a toast enters its slot); the rest queue (maxQueued, oldest dropped). Per frame only
 * timers advance – classes change on entry / exit.
 */
import type { EventBus } from '../../core/EventBus';
import type { AchievementTier, GameEvents, UnlockKind } from '../../core/events';
import { PROGRESSION_TOASTS } from '../../defs/progression';
import { getWeaponDef } from '../../defs/weapons';
import { h, restartAnim, setText } from './dom';
import './hud-progression.css';

export type ToastKind = 'level' | 'prestige' | 'achievement' | 'challenge' | 'weapon' | 'unlock';

export interface Toast {
  kind: ToastKind;
  kicker: string;
  title: string;
  sub: string;
  /** Accent (CSS colour). */
  color: string;
}

const TIER_LABELS: Readonly<Record<AchievementTier, string>> = {
  bronze: 'Bronze',
  silver: 'Silber',
  gold: 'Gold',
  platinum: 'Platin',
};

const TIER_COLORS: Readonly<Record<AchievementTier, string>> = {
  bronze: '#d08a44',
  silver: '#c9d3df',
  gold: '#f4d06a',
  platinum: '#9fe8ff',
};

const UNLOCK_LABELS: Readonly<Record<UnlockKind, string>> = {
  camo: 'Tarnung',
  charm: 'Anhänger',
  crosshair: 'Fadenkreuz',
  killEffect: 'Kill-Effekt',
  emblem: 'Emblem',
};

const COLORS = {
  level: '#ffb000',
  prestige: '#ff3df2',
  challenge: '#00e5ff',
  weapon: '#e8f4ff',
  unlock: '#b98cff',
} as const;

function thousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function weaponName(id: string | null): string {
  if (id === null) return 'Alle Waffen';
  return getWeaponDef(id)?.name ?? id;
}

interface Slot {
  el: HTMLDivElement;
  kicker: HTMLDivElement;
  title: HTMLDivElement;
  sub: HTMLDivElement;
  toast: Toast | null;
  /** Seconds shown so far; -1 = free. */
  age: number;
  phase: boolean;
}

export class ProgressionToasts {
  readonly el: HTMLDivElement;
  private readonly slots: Slot[] = [];
  private readonly queue: Toast[] = [];
  private readonly offs: (() => void)[] = [];

  constructor(layer: HTMLElement, events: EventBus<GameEvents>) {
    this.el = h('div', 'hud-ptoasts', layer);
    for (let i = 0; i < PROGRESSION_TOASTS.visible; i++) {
      const el = h('div', 'hud-ptoast', this.el);
      const kicker = h('div', 'hud-ptoast__kicker', el);
      const title = h('div', 'hud-ptoast__title', el);
      const sub = h('div', 'hud-ptoast__sub', el);
      el.hidden = true;
      this.slots.push({ el, kicker, title, sub, toast: null, age: -1, phase: false });
    }
    this.offs.push(
      events.on('progression:levelUp', (e) =>
        this.push({
          kind: 'level',
          kicker: 'Stufenaufstieg',
          title: `Stufe ${e.level}`,
          sub: e.skillPoints > 0 ? `${e.skillPoints} Fertigkeitspunkte verfügbar` : '',
          color: COLORS.level,
        }),
      ),
      events.on('progression:prestige', (e) =>
        this.push({
          kind: 'prestige',
          kicker: 'Prestige',
          title: `Prestige ${e.prestige}`,
          sub: `+${Math.round(e.xpBonus * 100)} % XP dauerhaft`,
          color: COLORS.prestige,
        }),
      ),
      events.on('achievement:unlocked', (e) =>
        this.push({
          kind: 'achievement',
          kicker: `Erfolg · ${TIER_LABELS[e.tier]}`,
          title: e.name,
          sub: `${e.description} +${thousands(e.xp)} XP`,
          color: TIER_COLORS[e.tier],
        }),
      ),
      events.on('challenge:completed', (e) =>
        this.push({
          kind: 'challenge',
          kicker: e.period === 'daily' ? 'Tägliche Herausforderung' : 'Wöchentliche Herausforderung',
          title: e.name,
          sub: `+${thousands(e.xp)} XP · +${e.currency} Splitter`,
          color: COLORS.challenge,
        }),
      ),
      events.on('progression:weaponLevelUp', (e) => {
        if (e.level % PROGRESSION_TOASTS.weaponLevelStep !== 0 && e.level < e.maxLevel) return;
        this.push({
          kind: 'weapon',
          kicker: 'Waffenstufe',
          title: `${weaponName(e.weaponId)} · Stufe ${e.level}`,
          sub: e.level >= e.maxLevel ? 'Gemeistert' : '',
          color: COLORS.weapon,
        });
      }),
      events.on('progression:unlock', (e) =>
        this.push({
          kind: 'unlock',
          kicker: `Freigeschaltet · ${UNLOCK_LABELS[e.kind]}`,
          title: e.name,
          sub: e.kind === 'camo' ? weaponName(e.weaponId) : '',
          color: COLORS.unlock,
        }),
      ),
    );
  }

  /** Toasts on screen and waiting (tests, debug). */
  get pending(): number {
    let n = this.queue.length;
    for (const s of this.slots) if (s.toast) n++;
    return n;
  }

  /** Titles on screen, top to bottom. */
  get shown(): string[] {
    return this.slots.filter((s) => s.toast).map((s) => s.toast!.title);
  }

  push(t: Toast): void {
    this.queue.push(t);
    if (this.queue.length > PROGRESSION_TOASTS.maxQueued) this.queue.shift();
    this.fill();
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    const T = PROGRESSION_TOASTS;
    for (const s of this.slots) {
      if (!s.toast) continue;
      const before = s.age;
      s.age += dt;
      if (before < T.duration && s.age >= T.duration) s.el.classList.add('is-out');
      if (s.age >= T.duration + T.outSeconds) this.release(s);
    }
    this.fill();
  }

  clear(): void {
    this.queue.length = 0;
    for (const s of this.slots) this.release(s);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.el.remove();
  }

  private fill(): void {
    for (const s of this.slots) {
      if (this.queue.length === 0) return;
      if (s.toast) continue;
      this.show(s, this.queue.shift()!);
    }
  }

  private show(s: Slot, t: Toast): void {
    s.toast = t;
    s.age = 0;
    setText(s.kicker, t.kicker);
    setText(s.title, t.title);
    setText(s.sub, t.sub);
    s.sub.hidden = t.sub === '';
    s.el.className = `hud-ptoast hud-ptoast--${t.kind}`;
    s.el.style.setProperty('--pt', t.color);
    s.el.hidden = false;
    // Keep the newest at the bottom of the stack.
    this.el.appendChild(s.el);
    s.phase = restartAnim(s.el, 'is-in', s.phase);
  }

  private release(s: Slot): void {
    s.toast = null;
    s.age = -1;
    s.el.hidden = true;
    s.el.classList.remove('is-out');
  }
}
