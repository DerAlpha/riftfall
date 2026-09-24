import { useEffect, useRef, useState } from 'preact/hooks';
import { FIXED_KEYS, type Action, type BindingMap } from '../../defs/input';
import { RUN_MENU } from '../../defs/ui';
import { bindingLabel, familyBindings, sanitizeBindings, type KeyboardLayout } from '../../input/bindings';
import {
  useInputDevice,
  useKeyboardLayout,
  useSettings,
  type MapChoice,
  type MenuDeps,
  type MenuMemory,
} from './context';
import './menus-run.css';

interface CheatRow {
  label: string;
  actions?: readonly Action[];
  /** Fixed text instead of bindings. */
  text?: string;
  /** Gamepad mode: fixed text instead (the sticks are hard-wired, not bindings). */
  padText?: string;
}

const CHEAT_SHEET: readonly CheatRow[] = [
  { label: 'Bewegen', actions: ['moveForward', 'moveLeft', 'moveBack', 'moveRight'], padText: 'L-Stick' },
  { label: 'Umsehen', text: 'Maus', padText: 'R-Stick' },
  { label: 'Springen / Doppelsprung', actions: ['jump'] },
  { label: 'Sprinten', actions: ['sprint'] },
  { label: 'Ducken / Rutschen', actions: ['crouch'] },
  { label: 'Dash', actions: ['dash'] },
  { label: 'Klettern', text: 'Sprung an Kante' },
  { label: 'Zielen', actions: ['ads'] },
  { label: 'Pause', actions: ['pause'] },
];

function primaryLabel(
  map: BindingMap,
  action: Action,
  family: 'kbm' | 'pad',
  layout?: KeyboardLayout,
): string | null {
  const b = familyBindings(map[action] ?? [], family)[0];
  return b ? bindingLabel(b, layout) : null;
}

function keysFor(
  map: BindingMap,
  actions: readonly Action[],
  family: 'kbm' | 'pad',
  layout?: KeyboardLayout,
): string {
  const labels = actions
    .map((a) => primaryLabel(map, a, family, layout))
    .filter((l): l is string => l !== null);
  if (labels.length === 0) return '—';
  // WASD-style groups read better compact ("W A S D").
  return labels.every((l) => l.length === 1) ? labels.join(' ') : labels.join(' / ');
}

/**
 * Map preselected on the start screen: the remembered one (the player's pick, else the loaded
 * map), else the first recommended, else the first.
 */
export function initialMapId(maps: readonly MapChoice[], remembered?: string): string | null {
  if (remembered !== undefined && maps.some((m) => m.id === remembered)) return remembered;
  return (maps.find((m) => m.recommended) ?? maps[0])?.id ?? null;
}

/**
 * Map selection cards: a radio group with a roving tab stop (arrow keys / D-pad left-right pick a
 * map, like the settings tabs). Activating the already selected card starts the game.
 */
function MapCards({
  maps,
  selected,
  onSelect,
  onStart,
}: {
  maps: readonly MapChoice[];
  selected: string | null;
  onSelect: (id: string) => void;
  onStart: () => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent): void => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    e.preventDefault();
    const i = maps.findIndex((m) => m.id === selected);
    const next = Math.min(maps.length - 1, Math.max(0, i + step));
    if (next === i) return;
    onSelect(maps[next]!.id);
    refs.current[next]?.focus({ preventScroll: true });
  };
  return (
    <div class="start__maps">
      <div class="start__mapshead">{RUN_MENU.start.mapsHeading}</div>
      <div
        class="start__maplist"
        role="radiogroup"
        aria-label={RUN_MENU.start.mapsHeading}
        onKeyDown={onKey}
        // Clicks between the cards must not start the game (the screen starts on any click).
        onClick={(e) => e.stopPropagation()}
      >
        {maps.map((m, i) => {
          const on = m.id === selected;
          return (
            <button
              key={m.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-map={m.id}
              class={`start__map${on ? ' is-selected' : ''}${m.recommended ? ' start__map--recommended' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (on) onStart();
                else onSelect(m.id);
              }}
            >
              <span class="start__mapname">{m.name}</span>
              {m.recommended ? <span class="start__mapbadge">{RUN_MENU.start.recommended}</span> : null}
              <span class="start__mapdesc">{m.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StartScreen({ deps, memory }: { deps: MenuDeps; memory?: MenuMemory }) {
  const s = useSettings(deps);
  const layout = useKeyboardLayout() ?? undefined;
  const map = sanitizeBindings(s.controls.bindings);
  const cta = useRef<HTMLButtonElement>(null);
  const info = deps.getInfo();
  const pad = useInputDevice(deps) === 'gamepad';
  const maps = deps.maps ?? [];
  // The player's pick of this session, else the loaded map (a map switch reloads onto this screen).
  const [mapId, setMapId] = useState<string | null>(() => initialMapId(maps, memory?.mapId ?? info.mapId));
  // Without the Pointer Lock API a lock request can only fail: start lock-less right away.
  const noLockApi = deps.input.pointerLockSupported === false;
  const start = (): void => {
    if (mapId === null) {
      deps.onStart(noLockApi ? { lockless: true } : undefined);
      return;
    }
    deps.onStart(noLockApi ? { lockless: true, mapId } : { mapId });
  };
  const selectMap = (id: string): void => {
    setMapId(id);
    if (memory) memory.mapId = id;
  };

  useEffect(() => {
    cta.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      class={`start${s.accessibility.reduceFlashing ? ' start--calm' : ''}${maps.length > 0 ? ' start--maps' : ''}`}
      onClick={start}
    >
      <div class="start__scan" aria-hidden="true" />
      <div class="start__inner">
        <h1 class="rf-title" data-text="RIFTFALL">
          RIFTFALL
        </h1>
        <div class="start__sub">
          {maps.length > 0 ? RUN_MENU.start.subtitleMaps : RUN_MENU.start.subtitle}
        </div>
        {maps.length > 0 ? (
          <MapCards maps={maps} selected={mapId} onSelect={selectMap} onStart={start} />
        ) : null}
        <button
          ref={cta}
          type="button"
          class="start__cta"
          onClick={(e) => {
            e.stopPropagation();
            start();
          }}
        >
          {pad ? 'A DRÜCKEN ZUM STARTEN' : 'KLICKEN ZUM STARTEN'}
        </button>
        {noLockApi ? (
          <div class="start__note">Mauszeiger-Sperre wird von diesem Browser nicht unterstützt.</div>
        ) : null}
        <div class="start__sheet" aria-label="Steuerung">
          {CHEAT_SHEET.map((row) => (
            <div class="start__sheetrow" key={row.label}>
              <span class="start__sheetlabel">{row.label}</span>
              <span class="start__keys">
                {pad && row.padText
                  ? row.padText
                  : (row.text ?? keysFor(map, row.actions ?? [], pad ? 'pad' : 'kbm', layout))}
              </span>
            </div>
          ))}
          <div class="start__sheetrow start__sheetrow--dev">
            <span class="start__sheetlabel">Konsole · Leistung</span>
            <span class="start__keys">
              {bindingLabel({ device: 'key', code: FIXED_KEYS.console }, layout)} · {FIXED_KEYS.debugOverlay}
            </span>
          </div>
        </div>
      </div>
      <div class="start__footer">
        <span>v{info.version}</span>
        <span>{info.gpuName}</span>
      </div>
    </div>
  );
}
