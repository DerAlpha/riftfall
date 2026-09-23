/**
 * F3 performance overlay: stats text (throttled) and a frame-time graph (every frame while visible).
 * Does no work at all while hidden; the snapshot provider is only called on text refreshes.
 */
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { createLogger } from '../../core/log';
import { RingBuffer } from '../../core/math';
import { FIXED_KEYS } from '../../defs/input';
import { DEBUG_OVERLAY } from '../../defs/ui';

export type Vec3Tuple = readonly [number, number, number];

export interface DebugSnapshot {
  fps: number;
  frameMs: number;
  frameMsP99?: number;
  ticksPerFrame: number;
  droppedTicks: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  width: number;
  height: number;
  pixelRatio: number;
  resolutionScale: number;
  /** -1 when GPU timer queries are unavailable. */
  gpuMs: number;
  gpuName: string;
  preset: string;
  entities: { bodies: number; colliders: number; dynamicBodies: number; meshes: number; lights: number };
  physicsMs: number;
  /** -1 when performance.memory is unavailable. */
  memoryMb: number;
  audioVoices: number;
  audioState: string;
  player: {
    state: string;
    speed: number;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    grounded: boolean;
    crouched: boolean;
  };
  missingAssets: readonly string[];
  /** M2 combat / VFX budget counters (rows omitted when absent). */
  combat?: DebugCombatSnapshot;
}

export interface DebugCombatSnapshot {
  /** Combat raycasts (shots, pellets, penetration continuations, LOS) per rendered frame. */
  raycastsPerFrame: number;
  targets: number;
  staticMeshes: number;
  particles: number;
  particleCapacity: number;
  decals: number;
  decalCapacity: number;
  flashLights: number;
  flashLightCapacity: number;
  casings: number;
  /** Weapon in hand; null when unarmed. */
  weapon: {
    id: string;
    state: string;
    spreadDeg: number;
    mag: number;
    magSize: number;
    reserve: number;
  } | null;
}

const G = DEBUG_OVERLAY.graph;
const log = createLogger('Debug');

function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmt(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function fmtVec(v: Vec3Tuple, digits: number): string {
  return `${fmt(v[0], digits)} ${fmt(v[1], digits)} ${fmt(v[2], digits)}`;
}

export class DebugOverlay {
  private _visible = false;
  private readonly panel: HTMLDivElement;
  private readonly text: HTMLPreElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly frames = new RingBuffer(G.frames);
  /** Scratch copy for percentile computation without allocations. */
  private readonly sortScratch = new Float32Array(G.frames);
  private textTimer = 0;
  private dpr = 1;
  private snapshotFailed = false;

  constructor(
    root: HTMLElement,
    private readonly events: EventBus<GameEvents>,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'debug-overlay';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-hidden', 'true');

    const title = document.createElement('div');
    title.className = 'debug-overlay__title';
    title.textContent = 'LEISTUNG // F3';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'debug-overlay__graph';
    this.canvas.style.width = `${G.widthPx}px`;
    this.canvas.style.height = `${G.heightPx}px`;
    let ctx: CanvasRenderingContext2D | null;
    try {
      ctx = this.canvas.getContext('2d');
    } catch {
      ctx = null; // jsdom / exotic environments: text-only overlay
    }
    this.ctx = ctx;

    this.text = document.createElement('pre');
    this.text.className = 'debug-overlay__text';

    this.panel.append(title, this.canvas, this.text);
    root.appendChild(this.panel);
    window.addEventListener('keydown', this.onKey, true);
  }

  get visible(): boolean {
    return this._visible;
  }

  setVisible(v: boolean): void {
    if (v === this._visible) return;
    this._visible = v;
    this.panel.hidden = !v;
    this.panel.setAttribute('aria-hidden', v ? 'false' : 'true');
    if (v) {
      this.frames.clear();
      this.textTimer = Number.POSITIVE_INFINITY; // refresh text on the first update
      this.resizeCanvas();
    }
    this.events.emit('ui:debugOverlay', { visible: v });
  }

  toggle(): void {
    this.setVisible(!this._visible);
  }

  /** Call once per frame (only needed while visible). `snapshot` is invoked at DEBUG_OVERLAY.textHz. */
  update(realDt: number, snapshot: () => DebugSnapshot): void {
    if (!this._visible) return;
    const ms = realDt > 0 && Number.isFinite(realDt) ? realDt * 1000 : 0;
    this.frames.push(ms);
    this.drawGraph();
    this.textTimer += realDt;
    if (this.textTimer >= 1 / DEBUG_OVERLAY.textHz) {
      this.textTimer = 0;
      if (this.currentDpr() !== this.dpr) this.resizeCanvas();
      let text: string;
      try {
        text = this.formatText(snapshot());
      } catch (err) {
        // A broken provider must never take the frame down with it.
        if (!this.snapshotFailed) log.warn('Debug-Snapshot fehlgeschlagen', err);
        this.snapshotFailed = true;
        text = `Snapshot fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`;
      }
      this.text.textContent = text;
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey, true);
    this.panel.remove();
  }

  // -------------------------------------------------------------------------

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code !== FIXED_KEYS.debugOverlay) return;
    e.preventDefault(); // F3 = "find next" in browsers
    if (e.repeat) return;
    this.toggle();
  };

  private currentDpr(): number {
    return Math.max(1, Math.min(G.maxPixelRatio, window.devicePixelRatio || 1));
  }

  private resizeCanvas(): void {
    const dpr = this.currentDpr();
    this.dpr = dpr;
    this.canvas.width = Math.round(G.widthPx * dpr);
    this.canvas.height = Math.round(G.heightPx * dpr);
  }

  private drawGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const n = this.frames.length;
    const barW = w / G.frames;
    const scale = h / G.maxMs;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = G.colors.background;
    ctx.fillRect(0, 0, w, h);
    // One path per color keeps canvas state changes to three fills.
    const x0 = w - n * barW;
    for (let pass = 0; pass < 3; pass++) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = this.frames.get(i);
        const bucket = v <= G.guidesMs[0] + 0.5 ? 0 : v <= G.guidesMs[1] + 0.5 ? 1 : 2;
        if (bucket !== pass) continue;
        const bh = Math.min(h, v * scale);
        ctx.rect(x0 + i * barW, h - bh, Math.max(1, barW), bh);
      }
      ctx.fillStyle = pass === 0 ? G.colors.good : pass === 1 ? G.colors.warn : G.colors.bad;
      ctx.fill();
    }
    ctx.fillStyle = G.colors.guide;
    for (const g of G.guidesMs) {
      const y = Math.round(h - g * scale);
      ctx.fillRect(0, y, w, this.dpr);
    }
  }

  private frameStats(): { avg: number; p99: number; max: number } {
    const n = this.frames.length;
    if (n === 0) return { avg: 0, p99: 0, max: 0 };
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const v = this.frames.get(i);
      this.sortScratch[i] = v;
      sum += v;
      if (v > max) max = v;
    }
    const sorted = this.sortScratch.subarray(0, n).sort();
    const p99 = sorted[Math.min(n - 1, Math.floor(DEBUG_OVERLAY.percentile * n))] ?? 0;
    return { avg: sum / n, p99, max };
  }

  private formatText(s: DebugSnapshot): string {
    const f = this.frameStats();
    const avgFps = f.avg > 0 ? 1000 / f.avg : s.fps;
    const p99 = s.frameMsP99 ?? f.p99;
    const e = s.entities;
    const p = s.player;
    const missing = s.missingAssets;
    const lines = [
      `FPS ${fmt(avgFps, 0)}  (${fmt(f.avg, 2)} ms, p99 ${fmt(p99, 2)}, max ${fmt(f.max, 1)})`,
      `GPU ${s.gpuMs >= 0 ? `${fmt(s.gpuMs, 2)} ms` : 'n/v'}  Physik ${fmt(s.physicsMs, 2)} ms  Ticks ${s.ticksPerFrame} (verworfen ${s.droppedTicks})`,
      `Draw Calls ${fmtInt(s.drawCalls)}  Dreiecke ${fmtInt(s.triangles)}  Punkte ${fmtInt(s.points)}  Linien ${fmtInt(s.lines)}`,
      `Geometrien ${s.geometries}  Texturen ${s.textures}  Shader ${s.programs}`,
      `Auflösung ${s.width}×${s.height} @${fmt(s.pixelRatio, 2)}  Skalierung ${fmt(s.resolutionScale * 100, 0)} %  Preset ${s.preset}`,
      `GPU: ${s.gpuName || 'unbekannt'}`,
      `Körper ${e.bodies} (dyn ${e.dynamicBodies})  Collider ${e.colliders}  Meshes ${e.meshes}  Lichter ${e.lights}`,
      `Speicher ${s.memoryMb >= 0 ? `${fmt(s.memoryMb, 0)} MB` : 'n/v'}  Audio ${s.audioVoices} Stimmen (${s.audioState})`,
      `Spieler ${p.state}  ${fmt(p.speed, 2)} m/s  ${p.grounded ? 'Boden' : 'Luft'}${p.crouched ? ' · geduckt' : ''}`,
      `  Pos ${fmtVec(p.position, 2)}`,
      `  Vel ${fmtVec(p.velocity, 2)}`,
    ];
    const c = s.combat;
    if (c) {
      const w = c.weapon;
      lines.push(
        `Kampf ${fmt(c.raycastsPerFrame, 1)} Strahlen/Frame  Ziele ${c.targets}  Statik-Meshes ${c.staticMeshes}`,
        `VFX Partikel ${fmtInt(c.particles)}/${fmtInt(c.particleCapacity)}  Decals ${c.decals}/${c.decalCapacity}  Blitzlichter ${c.flashLights}/${c.flashLightCapacity}  Hülsen ${c.casings}`,
        w
          ? `Waffe ${w.id} (${w.state})  Streuung ${fmt(w.spreadDeg, 2)}°  Magazin ${w.mag}/${w.magSize} (+${w.reserve})`
          : 'Waffe —',
      );
    }
    if (missing.length > 0) {
      const shown = missing.slice(0, DEBUG_OVERLAY.maxMissingAssets).join(', ');
      const more =
        missing.length > DEBUG_OVERLAY.maxMissingAssets
          ? ` … (+${missing.length - DEBUG_OVERLAY.maxMissingAssets})`
          : '';
      lines.push(`Fehlende Assets (${missing.length}): ${shown}${more}`);
    }
    return lines.join('\n');
  }
}
