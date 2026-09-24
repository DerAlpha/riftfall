/**
 * Game over screen (M3): "DU BIST GEFALLEN", the wave reached, the run's statistics and score,
 * "Neu starten" / "Hauptmenü". The stats reveal one after another (CSS delays); the buttons only
 * react after RUN_MENU.gameOver.inputDelayMs, then "Neu starten" takes the focus – a trigger or
 * jump held through the death must not restart by accident. Keyboard: Tab / arrow keys between
 * the buttons, Enter; gamepad: D-pad + A (MenuPadNavigator).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { RUN_MENU } from '../../defs/ui';
import { usePointerLockProblem, type GameOverStats, type MenuDeps, type PlayOptions } from './context';
import './menus-run.css';

const G = RUN_MENU.gameOver;
const numberFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

/** Seconds → "m:ss" (hours: "h:mm:ss"). */
export function formatRunTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Integer with German digit grouping ("12.345"); garbage shows 0. */
export function formatCount(v: number): string {
  return numberFormat.format(Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
}

/** Accuracy 0..1 of the stats (explicit value, else hits / shots). */
export function statsAccuracy(s: GameOverStats): number {
  const a =
    s.accuracy !== undefined && Number.isFinite(s.accuracy)
      ? s.accuracy
      : s.shotsFired > 0
        ? s.shotsHit / s.shotsFired
        : 0;
  return Math.min(1, Math.max(0, a));
}

export function formatAccuracy(a: number): string {
  return `${Math.round(Math.min(1, Math.max(0, Number.isFinite(a) ? a : 0)) * 100)} %`;
}

interface StatRow {
  key: string;
  label: string;
  value: string;
}

function statRows(s: GameOverStats): StatRow[] {
  const rows: StatRow[] = [
    { key: 'kills', label: G.labels.kills, value: formatCount(s.kills) },
    { key: 'headshots', label: G.labels.headshots, value: formatCount(s.headshots) },
  ];
  if (s.weakpointKills !== undefined && s.weakpointKills > 0) {
    rows.push({ key: 'weakpoints', label: G.labels.weakpoints, value: formatCount(s.weakpointKills) });
  }
  rows.push(
    { key: 'accuracy', label: G.labels.accuracy, value: formatAccuracy(statsAccuracy(s)) },
    { key: 'time', label: G.labels.time, value: formatRunTime(s.timeSurvived) },
  );
  return rows;
}

export function GameOverScreen({
  deps,
  stats,
  onRestart,
  onMainMenu,
}: {
  deps: MenuDeps;
  stats: GameOverStats;
  /** "Neu starten" (the controller closes the screen, then calls deps.onRestart or deps.onStart). */
  onRestart: (opts?: PlayOptions) => void;
  /** "Hauptmenü" (the controller routes it to deps.onMainMenu or the start screen). */
  onMainMenu: () => void;
}) {
  const [ready, setReady] = useState(false);
  const restartRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const lockProblem = usePointerLockProblem(deps);
  const reduce = deps.settings.current.accessibility.reduceFlashing;

  useEffect(() => {
    const t = setTimeout(() => setReady(true), G.inputDelayMs);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (ready) restartRef.current?.focus({ preventScroll: true });
  }, [ready]);

  const mapName =
    stats.mapName ?? (stats.mapId ? deps.maps?.find((m) => m.id === stats.mapId)?.name : undefined);
  const modeLabel = stats.mode ? G.modeLabels[stats.mode] : undefined;
  const sub = [mapName, modeLabel].filter((v): v is string => !!v).join(' · ');
  const rows = statRows(stats);

  // Without the API a lock request can only fail: restart lock-less right away.
  const restart = (): void => onRestart(lockProblem === 'unsupported' ? { lockless: true } : undefined);

  const onNavKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const buttons = [
      ...(navRef.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? []),
    ];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };

  let reveal = 0;
  const delay = (): Record<string, string> => ({ '--reveal': `${reveal++ * G.revealStepMs}ms` });

  return (
    <div
      class={`gameover${reduce ? ' gameover--calm' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={G.title}
    >
      <div class="gameover__backdrop" aria-hidden="true" />
      <div class="gameover__inner">
        <h1 class="gameover__title" data-text={G.title}>
          {G.title}
        </h1>
        {sub ? <div class="gameover__sub">{sub}</div> : null}
        <div class="gameover__wave" style={delay()}>
          <span class="gameover__wavelabel">{G.waveLabel}</span>
          <span class="gameover__wavevalue">{formatCount(stats.wave)}</span>
        </div>
        <dl class="gameover__stats">
          {rows.map((r) => (
            <div key={r.key} class={`gameover__stat gameover__stat--${r.key}`} style={delay()}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
        <div class="gameover__score" style={delay()}>
          <span class="gameover__scorelabel">{G.labels.score}</span>
          <span class="gameover__scorevalue">{formatCount(stats.score)}</span>
        </div>
        <nav class={`gameover__nav${ready ? ' is-ready' : ''}`} ref={navRef} onKeyDown={onNavKey}>
          <button
            ref={restartRef}
            type="button"
            class="menu-btn menu-btn--primary"
            disabled={!ready}
            onClick={restart}
          >
            {G.restart}
          </button>
          <button type="button" class="menu-btn" disabled={!ready} onClick={onMainMenu}>
            {G.mainMenu}
          </button>
        </nav>
      </div>
    </div>
  );
}
