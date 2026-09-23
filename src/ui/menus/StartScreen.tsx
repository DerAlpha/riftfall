import { useEffect, useRef } from 'preact/hooks';
import { FIXED_KEYS, type Action, type BindingMap } from '../../defs/input';
import { bindingLabel, familyBindings, sanitizeBindings, type KeyboardLayout } from '../../input/bindings';
import { useInputDevice, useKeyboardLayout, useSettings, type MenuDeps } from './context';

interface CheatRow {
  label: string;
  actions?: readonly Action[];
  /** Fixed text instead of bindings. */
  text?: string;
}

const CHEAT_SHEET: readonly CheatRow[] = [
  { label: 'Bewegen', actions: ['moveForward', 'moveLeft', 'moveBack', 'moveRight'] },
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

export function StartScreen({ deps }: { deps: MenuDeps }) {
  const s = useSettings(deps);
  const layout = useKeyboardLayout() ?? undefined;
  const map = sanitizeBindings(s.controls.bindings);
  const cta = useRef<HTMLButtonElement>(null);
  const info = deps.getInfo();
  const pad = useInputDevice(deps) === 'gamepad';

  useEffect(() => {
    cta.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      class={`start${s.accessibility.reduceFlashing ? ' start--calm' : ''}`}
      onClick={() => deps.onStart()}
    >
      <div class="start__scan" aria-hidden="true" />
      <div class="start__inner">
        <h1 class="rf-title" data-text="RIFTFALL">
          RIFTFALL
        </h1>
        <div class="start__sub">Kalibrierungshalle – Meilenstein 1</div>
        <button
          ref={cta}
          type="button"
          class="start__cta"
          onClick={(e) => {
            e.stopPropagation();
            deps.onStart();
          }}
        >
          KLICKEN ZUM STARTEN
        </button>
        <div class="start__sheet" aria-label="Steuerung">
          {CHEAT_SHEET.map((row) => (
            <div class="start__sheetrow" key={row.label}>
              <span class="start__sheetlabel">{row.label}</span>
              <span class="start__keys">
                {row.text ?? keysFor(map, row.actions ?? [], pad ? 'pad' : 'kbm', layout)}
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
