/**
 * Weapon attachments (M5 "Aufsätze"), sold at the Werkbank: optics, muzzle devices and barrels,
 * magazines and ammunition, underbarrel grips, stocks and lasers. Each is data: German name and
 * description, price, multiplicative stat mods (defs/weapons WeaponStatMods, applied by
 * resolveWeapon after the Rift Forge tiers), a part-library model id (the viewmodel mounts it on
 * the weapon's `mounts`), and the weapon categories/kinds it fits.
 *
 * Compatibility: the weapon's category is listed, the weapon has the slot
 * (WeaponDef.attachmentSlots) and – if the attachment names kinds – its kind is listed. One
 * attachment per slot. Wonder weapons have no slots.
 *
 * Optics may set an ABSOLUTE ADS zoom (`optic.zoom`, horizontal FOV multiplier like
 * WeaponAdsDef.zoom: 0.48 ≈ 2.5×, 0.31 ≈ 4× at 90°); `attachmentMods` turns it into the adsZoom
 * factor for the weapon at hand, so a 4× scope is 4× on every weapon.
 *
 * Design targets: every attachment is a trade (no strict upgrades except the cheap reflex sight
 * and lasers, which only touch hip fire / ADS speed); prices 500–2000 (a wall gun costs 500–1500),
 * so a fully kitted weapon costs about as much as the first Rift Forge tier.
 */
import type { AttachmentSlot, WeaponCategory, WeaponDef, WeaponKind, WeaponStatMods } from './weapons';

export type ReticleStyle = 'dot' | 'chevron' | 'holo' | 'crosshair' | 'thermal';

export interface AttachmentOpticDef {
  /** Absolute ADS zoom replacing the weapon's own (null = keeps the weapon's zoom). */
  readonly zoom: number | null;
  readonly reticle: ReticleStyle;
  /** Reticle emissive color (sRGB hex). */
  readonly color: number;
}

export interface AttachmentLaserDef {
  /** Dot/beam color (linear hex) and whether the beam is visible (else only the dot). */
  readonly color: number;
  readonly beam: boolean;
}

export interface AttachmentDef {
  readonly id: string;
  readonly slot: AttachmentSlot;
  /** Player-facing (German). */
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  readonly mods: WeaponStatMods;
  /** Part-library model id (weapons/viewmodels/attachments). */
  readonly model: string;
  /** Weapon categories it fits. */
  readonly categories: readonly WeaponCategory[];
  /** Weapon kinds it fits (absent = every kind). */
  readonly kinds?: readonly WeaponKind[];
  readonly optic?: AttachmentOpticDef;
  readonly laser?: AttachmentLaserDef;
  /** Muzzle device that suppresses the report (quieter sound variant, smaller flash). */
  readonly suppressed?: boolean;
}

/** Workbench slot labels (German) in menu order. */
export const ATTACHMENT_SLOTS: readonly { readonly slot: AttachmentSlot; readonly name: string }[] = [
  { slot: 'optic', name: 'Visier' },
  { slot: 'muzzle', name: 'Mündung & Lauf' },
  { slot: 'magazine', name: 'Magazin & Munition' },
  { slot: 'underbarrel', name: 'Unterlauf' },
  { slot: 'stock', name: 'Schaft' },
  { slot: 'laser', name: 'Laser' },
];

const BULLET: readonly WeaponKind[] = ['hitscan'];
const ENERGY_KINDS: readonly WeaponKind[] = ['projectile', 'beam', 'charge'];

const RED = 0xff2a18;
const GREEN = 0x4dff6a;
const CYAN = 0x40e0ff;
const AMBER = 0xffa020;

export const ATTACHMENTS = {
  // --- optics ---
  reflex: {
    id: 'reflex',
    slot: 'optic',
    name: 'Mini-Reflexvisier',
    description: 'Winziger Leuchtpunkt auf dem Schlitten. Schneller im Ziel, sonst unverändert.',
    cost: 500,
    mods: { adsTime: 0.9 },
    model: 'att.reflex',
    categories: ['pistol'],
    optic: { zoom: null, reticle: 'chevron', color: GREEN },
  },
  reddot: {
    id: 'reddot',
    slot: 'optic',
    name: 'Rotpunktvisier',
    description: 'Klarer roter Punkt statt Kimme und Korn. Etwas schneller im Anschlag.',
    cost: 750,
    mods: { adsTime: 0.94 },
    model: 'att.reddot',
    categories: ['pistol', 'smg', 'rifle', 'shotgun', 'lmg', 'launcher', 'energy'],
    optic: { zoom: null, reticle: 'dot', color: RED },
  },
  holo: {
    id: 'holo',
    slot: 'optic',
    name: 'Holo-Visier',
    description: 'Holografischer Ring mit Punkt. Ruhigeres Visierbild, weniger Rückstoß im Anschlag.',
    cost: 900,
    mods: { recoil: 0.95, adsTime: 1.02 },
    model: 'att.holo',
    categories: ['smg', 'rifle', 'shotgun', 'lmg', 'energy'],
    optic: { zoom: null, reticle: 'holo', color: CYAN },
  },
  acog: {
    id: 'acog',
    slot: 'optic',
    name: 'Zielvisier 2,5×',
    description: 'Prismenvisier mit 2,5-facher Vergrößerung. Für Distanz – langsamer im Anschlag.',
    cost: 1250,
    mods: { adsTime: 1.2, hipSpread: 1.05 },
    model: 'att.acog',
    // Not the DM-8: its built-in optic is already 2.5× (the ACOG would only slow its aim).
    categories: ['smg', 'rifle', 'lmg', 'energy'],
    optic: { zoom: 0.48, reticle: 'chevron', color: AMBER },
  },
  scope4x: {
    id: 'scope4x',
    slot: 'optic',
    name: 'Zielfernrohr 4×',
    description: 'Vierfache Vergrößerung für weite Hallen. Träge im Anschlag, unruhig aus der Hüfte.',
    cost: 1500,
    mods: { adsTime: 1.35, hipSpread: 1.15 },
    model: 'att.scope4x',
    categories: ['rifle', 'marksman', 'sniper', 'energy'],
    kinds: ['hitscan', 'charge'],
    optic: { zoom: 0.31, reticle: 'crosshair', color: RED },
  },
  thermal: {
    id: 'thermal',
    slot: 'optic',
    name: 'Wärmebildvisier',
    description: 'Zeigt Körperwärme durch Rauch und Dunkelheit. Leichte Vergrößerung, schweres Gehäuse.',
    cost: 2000,
    mods: { adsTime: 1.15 },
    model: 'att.thermal',
    categories: ['smg', 'rifle', 'lmg', 'marksman', 'sniper'],
    optic: { zoom: 0.6, reticle: 'thermal', color: AMBER },
  },

  // --- muzzle devices and barrels ---
  suppressor: {
    id: 'suppressor',
    slot: 'muzzle',
    name: 'Schalldämpfer',
    description: 'Dämpft Knall und Mündungsfeuer, beruhigt den Rückstoß. Kostet Reichweite.',
    cost: 1000,
    mods: { recoil: 0.92, range: 0.85 },
    model: 'att.suppressor',
    categories: ['pistol', 'smg', 'rifle', 'marksman', 'sniper', 'lmg'],
    kinds: BULLET,
    suppressed: true,
  },
  compensator: {
    id: 'compensator',
    slot: 'muzzle',
    name: 'Kompensator',
    description:
      'Lenkt Gase nach oben und zur Seite. Deutlich weniger Rückstoß, etwas mehr Streuung aus der Hüfte.',
    cost: 750,
    mods: { recoil: 0.82, hipSpread: 1.08 },
    model: 'att.compensator',
    categories: ['pistol', 'smg', 'rifle', 'lmg'],
    kinds: BULLET,
  },
  muzzlebrake: {
    id: 'muzzlebrake',
    slot: 'muzzle',
    name: 'Mündungsbremse',
    description: 'Schwere Bremse für großes Kaliber. Zähmt den Tritt, macht die Waffe kopflastig.',
    cost: 900,
    mods: { recoil: 0.86, adsTime: 1.05 },
    model: 'att.muzzlebrake',
    categories: ['rifle', 'marksman', 'sniper', 'lmg', 'shotgun'],
    kinds: BULLET,
  },
  longbarrel: {
    id: 'longbarrel',
    slot: 'muzzle',
    name: 'Langer Lauf',
    description: 'Mehr Lauf, mehr Geschwindigkeit: höhere Reichweite und Präzision, langsamer im Anschlag.',
    cost: 1200,
    mods: { range: 1.35, damage: 1.06, spread: 0.9, adsTime: 1.12 },
    model: 'att.longbarrel',
    categories: ['pistol', 'smg', 'rifle', 'marksman', 'sniper', 'lmg'],
    kinds: BULLET,
  },
  shortbarrel: {
    id: 'shortbarrel',
    slot: 'muzzle',
    name: 'Kurzer Lauf',
    description:
      'Gekürzter Lauf für enge Gänge: schneller im Anschlag und aus der Hüfte, weniger Reichweite.',
    cost: 750,
    mods: { range: 0.8, adsTime: 0.85, hipSpread: 0.85, equipTime: 0.9 },
    model: 'att.shortbarrel',
    categories: ['smg', 'rifle', 'shotgun', 'lmg'],
    kinds: BULLET,
  },
  choke: {
    id: 'choke',
    slot: 'muzzle',
    name: 'Würgebohrung',
    description: 'Verengt die Mündung der Flinte: die Garbe bleibt enger zusammen und trägt weiter.',
    cost: 900,
    mods: { spread: 0.72, range: 1.2 },
    model: 'att.choke',
    categories: ['shotgun'],
    kinds: BULLET,
  },
  focuslens: {
    id: 'focuslens',
    slot: 'muzzle',
    name: 'Fokuslinse',
    description: 'Bündelt Energiewaffen: höhere Reichweite, engere Streuung, etwas mehr Wucht.',
    cost: 1500,
    mods: { range: 1.3, spread: 0.8, damage: 1.05 },
    model: 'att.focuslens',
    categories: ['energy'],
    kinds: ENERGY_KINDS,
  },

  // --- magazines and ammunition ---
  extmag: {
    id: 'extmag',
    slot: 'magazine',
    name: 'Erweitertes Magazin',
    description: 'Fünfzig Prozent mehr Patronen pro Magazin. Etwas schwerer, etwas langsamer nachgeladen.',
    cost: 1250,
    mods: { magazine: 1.5, reloadTime: 1.12, adsTime: 1.04 },
    model: 'att.extmag',
    categories: ['pistol', 'smg', 'rifle', 'marksman', 'sniper', 'lmg', 'shotgun'],
    kinds: BULLET,
  },
  fastmag: {
    id: 'fastmag',
    slot: 'magazine',
    name: 'Schnellwechsel-Magazin',
    description: 'Gekoppelte Magazine mit Zuglasche: fast ein Drittel schneller nachgeladen.',
    cost: 1000,
    mods: { reloadTime: 0.72 },
    model: 'att.fastmag',
    categories: ['pistol', 'smg', 'rifle', 'marksman', 'sniper', 'lmg', 'shotgun', 'launcher'],
  },
  drum: {
    id: 'drum',
    slot: 'magazine',
    name: 'Trommelmagazin',
    description: 'Doppelte Kapazität und mehr Reserve. Schwer, träge und lange im Nachladen.',
    cost: 2000,
    mods: { magazine: 2, reserve: 1.25, reloadTime: 1.35, adsTime: 1.1, moveSpeed: 0.95 },
    model: 'att.drum',
    categories: ['smg', 'rifle', 'lmg'],
    kinds: BULLET,
  },
  overpressure: {
    id: 'overpressure',
    slot: 'magazine',
    name: 'Überdruck-Munition',
    description: 'Heiß geladene Patronen: mehr Schaden und Reichweite, spürbar mehr Rückstoß.',
    cost: 1500,
    mods: { damage: 1.15, recoil: 1.15, range: 1.1 },
    model: 'att.overpressure',
    categories: ['pistol', 'smg', 'rifle', 'marksman', 'sniper', 'lmg', 'shotgun'],
    kinds: BULLET,
  },
  apround: {
    id: 'apround',
    slot: 'magazine',
    name: 'Panzerbrechende Munition',
    description: 'Wolframkern: durchschlägt doppelt so viel, verliert aber ein wenig Wucht.',
    cost: 1250,
    mods: { penetration: 2, damage: 0.95 },
    model: 'att.apround',
    categories: ['pistol', 'smg', 'rifle', 'marksman', 'sniper', 'lmg'],
    kinds: BULLET,
  },
  capacitor: {
    id: 'capacitor',
    slot: 'magazine',
    name: 'Kondensatorbank',
    description: 'Zusätzliche Zellen für Energiewaffen: mehr Ladung pro Zelle, längerer Zellenwechsel.',
    cost: 1500,
    mods: { magazine: 1.4, reloadTime: 1.1 },
    model: 'att.capacitor',
    categories: ['energy'],
    kinds: ENERGY_KINDS,
  },
  heavyload: {
    id: 'heavyload',
    slot: 'magazine',
    name: 'Schwere Ladung',
    description: 'Größere Sprengladungen: weiterer Explosionsradius, langsamere Geschosse.',
    cost: 1500,
    mods: { blastRadius: 1.25, projectileSpeed: 0.9 },
    model: 'att.heavyload',
    categories: ['launcher', 'energy'],
    kinds: ['projectile'],
  },

  // --- underbarrel ---
  vertgrip: {
    id: 'vertgrip',
    slot: 'underbarrel',
    name: 'Vertikalgriff',
    description: 'Fester Halt für die vordere Hand: weniger Rückstoß, minimal träger im Anschlag.',
    cost: 750,
    mods: { recoil: 0.85, adsTime: 1.05 },
    model: 'att.vertgrip',
    categories: ['smg', 'rifle', 'lmg', 'marksman', 'shotgun'],
  },
  anglegrip: {
    id: 'anglegrip',
    slot: 'underbarrel',
    name: 'Winkelgriff',
    description: 'Schräger Griff für schnelle Anschläge: deutlich schneller im Ziel.',
    cost: 750,
    mods: { adsTime: 0.85, recoil: 0.96 },
    model: 'att.anglegrip',
    categories: ['smg', 'rifle', 'lmg', 'marksman', 'shotgun'],
  },
  stabilizer: {
    id: 'stabilizer',
    slot: 'underbarrel',
    name: 'Gyro-Stabilisator',
    description: 'Kreiselstabilisierte Halterung: engere Streuung und ruhiger Lauf, etwas schwerer.',
    cost: 1250,
    mods: { spread: 0.8, recoil: 0.9, moveSpeed: 0.96 },
    model: 'att.stabilizer',
    categories: ['smg', 'rifle', 'lmg', 'marksman'],
  },

  // --- stocks ---
  lightstock: {
    id: 'lightstock',
    slot: 'stock',
    name: 'Leichtschaft',
    description: 'Skelettierter Schaft: schneller unterwegs und im Anschlag, etwas mehr Rückstoß.',
    cost: 750,
    mods: { moveSpeed: 1.06, adsTime: 0.9, recoil: 1.08 },
    model: 'att.lightstock',
    categories: ['pistol', 'smg', 'rifle', 'shotgun', 'marksman', 'sniper', 'lmg', 'launcher'],
  },
  heavystock: {
    id: 'heavystock',
    slot: 'stock',
    name: 'Schwerer Schaft',
    description: 'Gepolsterter Schaft mit Gegengewicht: viel weniger Rückstoß, etwas langsamer.',
    cost: 900,
    mods: { recoil: 0.82, adsTime: 1.08, moveSpeed: 0.96 },
    model: 'att.heavystock',
    categories: ['pistol', 'smg', 'rifle', 'shotgun', 'marksman', 'sniper', 'lmg', 'launcher', 'energy'],
  },

  // --- lasers ---
  tacticallaser: {
    id: 'tacticallaser',
    slot: 'laser',
    name: 'Taktischer Laser',
    description: 'Roter Laserpunkt für Schüsse aus der Hüfte: deutlich engere Hüftstreuung.',
    cost: 750,
    mods: { hipSpread: 0.75 },
    model: 'att.tacticallaser',
    categories: ['pistol', 'smg', 'rifle', 'shotgun', 'lmg', 'marksman', 'sniper', 'energy'],
    laser: { color: 0xff2010, beam: false },
  },
  targetlaser: {
    id: 'targetlaser',
    slot: 'laser',
    name: 'Ziellaser',
    description: 'Sichtbarer grüner Strahl: schneller im Anschlag, etwas präziser aus der Hüfte.',
    cost: 900,
    mods: { adsTime: 0.85, hipSpread: 0.9 },
    model: 'att.targetlaser',
    categories: ['pistol', 'smg', 'rifle', 'shotgun', 'lmg', 'marksman', 'sniper', 'energy'],
    laser: { color: 0x30ff50, beam: true },
  },
} as const satisfies Record<string, AttachmentDef>;

export type AttachmentId = keyof typeof ATTACHMENTS;

/** Every attachment id, in workbench order (by slot). */
export const ATTACHMENT_IDS: readonly AttachmentId[] = Object.keys(ATTACHMENTS) as AttachmentId[];

export function getAttachmentDef(id: string): AttachmentDef | undefined {
  return Object.prototype.hasOwnProperty.call(ATTACHMENTS, id)
    ? (ATTACHMENTS as Record<string, AttachmentDef>)[id]
    : undefined;
}

/** Can `att` go on `weapon` (category, slot and kind match)? */
export function isAttachmentCompatible(att: AttachmentDef, weapon: WeaponDef): boolean {
  return (
    att.categories.includes(weapon.category) &&
    weapon.attachmentSlots.includes(att.slot) &&
    (att.kinds === undefined || att.kinds.includes(weapon.kind))
  );
}

/** Attachments that fit `weapon` (optionally one slot), in workbench order. */
export function attachmentsFor(weapon: WeaponDef, slot?: AttachmentSlot): AttachmentDef[] {
  const out: AttachmentDef[] = [];
  for (const id of ATTACHMENT_IDS) {
    const a: AttachmentDef = ATTACHMENTS[id];
    if ((slot === undefined || a.slot === slot) && isAttachmentCompatible(a, weapon)) out.push(a);
  }
  return out;
}

/**
 * The stat mods `att` applies to `weapon` (base def: the forge tiers never change the ADS zoom):
 * an optic's absolute zoom becomes the adsZoom factor for this weapon (× the attachment's own
 * adsZoom). Call on attach, not per frame.
 */
export function attachmentMods(att: AttachmentDef, weapon: WeaponDef): WeaponStatMods {
  const zoom = att.optic?.zoom;
  if (zoom === null || zoom === undefined || !(weapon.ads.zoom > 0)) return att.mods;
  return { ...att.mods, adsZoom: (zoom / weapon.ads.zoom) * (att.mods.adsZoom ?? 1) };
}
