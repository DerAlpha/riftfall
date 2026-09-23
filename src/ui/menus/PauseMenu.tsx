import type { ComponentType } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PointerLockProblem } from '../../input/InputSystem';
import { AccessibilityTab } from './AccessibilityTab';
import { AudioTab } from './AudioTab';
import {
  usePointerLockProblem,
  type MenuDeps,
  type MenuInfo,
  type MenuMemory,
  type SettingsTab,
} from './context';
import { ControlsTab } from './ControlsTab';
import { GraphicsTab } from './GraphicsTab';

const SAVE_LABELS: Readonly<Record<MenuInfo['saveBackend'], string>> = {
  indexeddb: 'Browser-Datenbank',
  localStorage: 'Lokaler Speicher',
  memory: 'Nur diese Sitzung',
};

const LOCK_HINTS: Readonly<Record<PointerLockProblem, string>> = {
  unsupported:
    'Dieser Browser unterstützt keine Mauszeiger-Sperre (Pointer Lock). Das Spiel läuft ohne – Umsehen mit der Maus oder dem Gamepad.',
  denied:
    'Mauszeiger konnte nicht gesperrt werden – der Browser oder die Einbettung erlaubt keinen Pointer Lock.',
};

/**
 * Focus sits in a text field outside the menu – the dev console, when a tab switch opened the menu
 * under it. Opening the menu must not steal it (typing and Enter would hit "Fortsetzen").
 */
function textFieldFocusedOutside(menu: HTMLElement | null): boolean {
  const a = document.activeElement;
  const textField =
    a instanceof HTMLTextAreaElement ||
    (a instanceof HTMLInputElement && a.type === 'text') ||
    (a instanceof HTMLElement && a.isContentEditable);
  return textField && !(menu?.contains(a) ?? false);
}

const TABS: readonly { id: SettingsTab; label: string; component: ComponentType<{ deps: MenuDeps }> }[] = [
  { id: 'graphics', label: 'Grafik', component: GraphicsTab },
  { id: 'audio', label: 'Audio', component: AudioTab },
  { id: 'controls', label: 'Steuerung', component: ControlsTab },
  { id: 'accessibility', label: 'Barrierefreiheit', component: AccessibilityTab },
];

function SettingsView({ deps, memory, onBack }: { deps: MenuDeps; memory: MenuMemory; onBack: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(memory.tab);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;
  const Body = current.component;

  const select = (id: SettingsTab): void => {
    memory.tab = id;
    setTab(id);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

  useEffect(() => {
    tabRefs.current[TABS.findIndex((t) => t.id === tab)]?.focus({ preventScroll: true });
    // Focus only on open; tab changes keep focus where the user put it.
  }, []);

  const onTabKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    select(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  return (
    <div class="menu-panel menu-panel--settings">
      <header class="menu-panel__header">
        <h2 class="menu-title">Einstellungen</h2>
        <div class="menu-tabs" role="tablist" aria-label="Einstellungen" onKeyDown={onTabKey}>
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`menu-tab-${t.id}`}
              aria-selected={t.id === tab}
              aria-controls="menu-tabpanel"
              tabIndex={t.id === tab ? 0 : -1}
              class={`menu-tabs__tab${t.id === tab ? ' is-active' : ''}`}
              onClick={() => select(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>
      <div
        ref={bodyRef}
        class="menu-panel__body"
        id="menu-tabpanel"
        role="tabpanel"
        aria-labelledby={`menu-tab-${tab}`}
      >
        <Body deps={deps} />
      </div>
      <footer class="menu-panel__footer">
        <span class="menu-hint">Änderungen werden sofort übernommen und gespeichert.</span>
        <button type="button" class="menu-btn" onClick={onBack}>
          Zurück <kbd>Esc</kbd>
        </button>
      </footer>
    </div>
  );
}

export function PauseMenu({ deps, memory }: { deps: MenuDeps; memory: MenuMemory }) {
  const [view, setView] = useState<'main' | 'settings'>('main');
  const rootRef = useRef<HTMLDivElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const info = deps.getInfo();
  const lockProblem = usePointerLockProblem(deps);

  useEffect(() => {
    if (view === 'main' && !textFieldFocusedOutside(rootRef.current)) {
      resumeRef.current?.focus({ preventScroll: true });
    }
  }, [view]);

  useEffect(
    () =>
      deps.events.on('ui:console', ({ open }) => {
        // The console closed over the menu and left focus nowhere: keyboard/pad users land on "Fortsetzen".
        const a = document.activeElement;
        if (!open && view === 'main' && (a === null || a === document.body)) {
          resumeRef.current?.focus({ preventScroll: true });
        }
      }),
    [deps.events, view],
  );

  useEffect(() => {
    // Escape inside settings goes back (pointer lock is already released while the menu is open).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (view === 'settings') {
        e.preventDefault();
        setView('main');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  return (
    <div class="pause" ref={rootRef}>
      <div class="pause__backdrop" aria-hidden="true" />
      {view === 'main' ? (
        <div class="menu-panel menu-panel--pause" role="dialog" aria-label="Pausenmenü">
          <h2 class="menu-title menu-title--big">Pausiert</h2>
          <div class="pause__sub">Kalibrierungshalle</div>
          <nav class="pause__nav">
            <button
              ref={resumeRef}
              type="button"
              class="menu-btn menu-btn--primary"
              // Without the API a lock request can only fail again: resume lock-less right away.
              onClick={() => deps.onResume(lockProblem === 'unsupported' ? { lockless: true } : undefined)}
            >
              Fortsetzen
            </button>
            {lockProblem === 'denied' ? (
              <button type="button" class="menu-btn" onClick={() => deps.onResume({ lockless: true })}>
                Ohne Mauszeiger-Sperre fortsetzen
              </button>
            ) : null}
            <button type="button" class="menu-btn" onClick={() => setView('settings')}>
              Einstellungen
            </button>
          </nav>
          {lockProblem ? (
            <p class="pause__warn" role="alert">
              {LOCK_HINTS[lockProblem]}
            </p>
          ) : null}
          {info.saveBackend === 'memory' ? (
            <p class="pause__warn">
              Speichern nicht möglich – Einstellungen und Tastenbelegung gehen beim Neuladen verloren.
            </p>
          ) : null}
          <div class="pause__info">
            <span>v{info.version}</span>
            <span>{info.gpuName}</span>
            <span>Speicher: {SAVE_LABELS[info.saveBackend] ?? info.saveBackend}</span>
          </div>
        </div>
      ) : (
        <SettingsView deps={deps} memory={memory} onBack={() => setView('main')} />
      )}
    </div>
  );
}
