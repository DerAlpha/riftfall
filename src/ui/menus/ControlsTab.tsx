import { useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_BINDINGS, type Action, type Binding, type BindingMap } from '../../defs/input';
import { MENU } from '../../defs/ui';
import {
  ACTION_GROUPS,
  actionLabel,
  bindingFamily,
  bindingLabel,
  cloneBindingMap,
  familyBindings,
  getSlotBinding,
  sanitizeBindings,
  setBinding,
  type BindingSlot,
  type KeyboardLayout,
} from '../../input/bindings';
import type { ControlSettings } from '../../save/settingsSchema';
import { useKeyboardLayout, useSettings, type MenuDeps } from './context';
import { ActionRow, fixed, pct, Section, Slider, Toggle } from './widgets';

const SLOTS: readonly { slot: BindingSlot; label: string }[] = [
  { slot: { family: 'kbm', index: 0 }, label: 'Primär' },
  { slot: { family: 'kbm', index: 1 }, label: 'Sekundär' },
  { slot: { family: 'pad', index: 0 }, label: 'Gamepad' },
];

interface Capturing {
  action: Action;
  slot: BindingSlot;
}

let captureSeq = 0;

function sameSlot(a: Capturing | null, action: Action, slot: BindingSlot): boolean {
  return !!a && a.action === action && a.slot.family === slot.family && a.slot.index === slot.index;
}

function KeybindingList({ deps, layout }: { deps: MenuDeps; layout: KeyboardLayout | null }) {
  const s = useSettings(deps);
  const [capturing, setCapturing] = useState<Capturing | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'info' | 'warn' } | null>(null);
  const alive = useRef(true);
  /** Id of the running capture (0 = none); a superseded capture must not touch the UI state. */
  const captureId = useRef(0);
  const noticeTimer = useRef(0);
  const map: BindingMap = sanitizeBindings(s.controls.bindings);
  const lay = layout ?? undefined;

  useEffect(
    () => () => {
      alive.current = false;
      window.clearTimeout(noticeTimer.current);
      // Closing the menu / switching tabs mid-capture must not leave the input system listening.
      if (captureId.current !== 0) deps.input.cancelCapture?.();
    },
    [],
  );

  const flash = (text: string, kind: 'info' | 'warn'): void => {
    setNotice({ text, kind });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => alive.current && setNotice(null), MENU.conflictNoticeMs);
  };

  const apply = (action: Action, slot: BindingSlot, b: Binding | null): void => {
    const current = sanitizeBindings(deps.settings.current.controls.bindings);
    const { map: next, conflicts } = setBinding(current, action, slot, b);
    deps.settings.update('controls', { bindings: next });
    if (conflicts.length > 0) {
      flash(
        conflicts
          .map(
            (c) =>
              `„${bindingLabel(c.binding, lay)}“ war „${actionLabel(c.action)}“ zugewiesen – ${
                c.swappedIn ? `getauscht gegen „${bindingLabel(c.swappedIn, lay)}“` : 'dort entfernt'
              }.`,
          )
          .join(' '),
        'info',
      );
    }
  };

  const capture = async (action: Action, clicked: BindingSlot): Promise<void> => {
    // Bindings are stored compactly per family (no gaps): a secondary slot next to an empty primary
    // would be stored as the primary. Capture into the slot the binding will actually occupy.
    const stored = familyBindings(
      sanitizeBindings(deps.settings.current.controls.bindings)[action],
      clicked.family,
    ).length;
    const slot = clicked.index > stored ? { ...clicked, index: stored } : clicked;
    const id = ++captureSeq;
    captureId.current = id;
    setCapturing({ action, slot });
    setNotice(null);
    const b = await deps.input.captureBinding();
    if (!alive.current || captureId.current !== id) return;
    captureId.current = 0;
    setCapturing(null);
    if (!b) return;
    if (bindingFamily(b) !== slot.family) {
      flash(
        slot.family === 'pad'
          ? 'Bitte eine Gamepad-Taste drücken.'
          : 'Bitte eine Taste oder Maustaste drücken.',
        'warn',
      );
      return;
    }
    apply(action, slot, b);
  };

  return (
    <div class="keybinds">
      <div class="keybinds__head" aria-hidden="true">
        <span>Aktion</span>
        {SLOTS.map((c) => (
          <span key={c.label}>{c.label}</span>
        ))}
      </div>
      {ACTION_GROUPS.map((group) => (
        <div class="keybinds__group" key={group.label}>
          <div class="keybinds__grouptitle">{group.label}</div>
          {group.actions.map((action) => (
            <div class="keybinds__row" key={action}>
              <span class="keybinds__action">{actionLabel(action)}</span>
              {SLOTS.map(({ slot, label }) => {
                const b = getSlotBinding(map, action, slot);
                const active = sameSlot(capturing, action, slot);
                return (
                  <button
                    key={label}
                    type="button"
                    class={`keybinds__slot${active ? ' is-capturing' : ''}${b ? '' : ' is-empty'}`}
                    title="Klicken zum Belegen · Rechtsklick/Entf entfernt"
                    aria-label={`${actionLabel(action)} ${label}: ${b ? bindingLabel(b, lay) : 'nicht belegt'}`}
                    onClick={() => void capture(action, slot)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (b) apply(action, slot, null);
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Delete' || e.key === 'Backspace') && b) {
                        e.preventDefault();
                        apply(action, slot, null);
                      }
                    }}
                  >
                    {active ? 'Taste drücken … (Esc)' : b ? bindingLabel(b, lay) : '—'}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ))}
      <div class={`keybinds__notice${notice ? ` is-visible is-${notice.kind}` : ''}`} role="status">
        {notice?.text ?? ''}
      </div>
      <div class="menu-tab__footer">
        <button
          type="button"
          class="menu-btn menu-btn--ghost"
          onClick={() => deps.settings.update('controls', { bindings: cloneBindingMap(DEFAULT_BINDINGS) })}
        >
          Belegung zurücksetzen
        </button>
      </div>
    </div>
  );
}

export function ControlsTab({ deps }: { deps: MenuDeps }) {
  const c = useSettings(deps).controls;
  const layout = useKeyboardLayout();
  const set = (patch: Partial<ControlSettings>): void => deps.settings.update('controls', patch);
  const r = MENU.ranges;
  return (
    <div class="menu-tab">
      <Section title="Maus">
        <Slider
          label="Empfindlichkeit"
          value={c.mouseSensitivity}
          range={r.mouseSensitivity}
          format={fixed(2)}
          onChange={(v) => set({ mouseSensitivity: v })}
        />
        <Slider
          label="Empfindlichkeit beim Zielen"
          hint="Multiplikator"
          value={c.adsSensitivityMultiplier}
          range={r.adsSensitivity}
          format={(v) => `${fixed(2)(v)}×`}
          onChange={(v) => set({ adsSensitivityMultiplier: v })}
        />
        <Toggle label="Y-Achse invertieren" value={c.invertY} onChange={(v) => set({ invertY: v })} />
      </Section>

      <Section title="Kamera & Bewegung">
        <Slider
          label="Sichtfeld (FOV)"
          hint="Horizontal bei 16:9"
          value={c.fov}
          range={r.fov}
          format={(v) => `${Math.round(v)}°`}
          onChange={(v) => set({ fov: v })}
        />
        <Toggle
          label="Sprinten"
          value={c.toggleSprint}
          onLabel="UMSCHALTEN"
          offLabel="HALTEN"
          onChange={(v) => set({ toggleSprint: v })}
        />
        <Toggle
          label="Ducken"
          value={c.toggleCrouch}
          onLabel="UMSCHALTEN"
          offLabel="HALTEN"
          onChange={(v) => set({ toggleCrouch: v })}
        />
        <Toggle
          label="Automatisch sprinten"
          hint="Beim Vorwärtslaufen"
          value={c.autoSprint}
          onChange={(v) => set({ autoSprint: v })}
        />
      </Section>

      <Section title="Gamepad">
        <Slider
          label="Empfindlichkeit horizontal"
          value={c.gamepadSensitivityX}
          range={r.gamepadSensitivity}
          format={fixed(2)}
          onChange={(v) => set({ gamepadSensitivityX: v })}
        />
        <Slider
          label="Empfindlichkeit vertikal"
          value={c.gamepadSensitivityY}
          range={r.gamepadSensitivity}
          format={fixed(2)}
          onChange={(v) => set({ gamepadSensitivityY: v })}
        />
        <Slider
          label="Totzone"
          value={c.gamepadDeadzone}
          range={r.gamepadDeadzone}
          format={pct}
          onChange={(v) => set({ gamepadDeadzone: v })}
        />
        <Toggle
          label="Y-Achse invertieren"
          value={c.gamepadInvertY}
          onChange={(v) => set({ gamepadInvertY: v })}
        />
        <Toggle
          label="Zielhilfe"
          hint="Nur mit Gamepad"
          value={c.aimAssist}
          onChange={(v) => set({ aimAssist: v })}
        />
        <Toggle label="Vibration" value={c.vibration} onChange={(v) => set({ vibration: v })} />
        <ActionRow label="Vibration testen">
          <button
            type="button"
            class="menu-btn menu-btn--small"
            onClick={() =>
              deps.input.rumble(MENU.rumbleTest.strong, MENU.rumbleTest.weak, MENU.rumbleTest.durationMs)
            }
          >
            Testen
          </button>
        </ActionRow>
      </Section>

      <Section title="Tastenbelegung">
        <KeybindingList deps={deps} layout={layout} />
      </Section>

      <div class="menu-tab__footer">
        <button
          type="button"
          class="menu-btn menu-btn--ghost"
          onClick={() => deps.settings.resetSection('controls')}
        >
          Alle Steuerungs-Standardwerte
        </button>
      </div>
    </div>
  );
}
