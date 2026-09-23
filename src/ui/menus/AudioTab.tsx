import { MENU } from '../../defs/ui';
import type { AudioSettings } from '../../save/settingsSchema';
import { useSettings, type MenuDeps } from './context';
import { pct, Section, Slider, Toggle } from './widgets';

const BUSES: readonly { key: keyof Omit<AudioSettings, 'muteInBackground'>; label: string }[] = [
  { key: 'master', label: 'Gesamtlautstärke' },
  { key: 'music', label: 'Musik' },
  { key: 'sfx', label: 'Effekte' },
  { key: 'voice', label: 'Sprache' },
  { key: 'ui', label: 'Oberfläche' },
];

export function AudioTab({ deps }: { deps: MenuDeps }) {
  const a = useSettings(deps).audio;
  const set = (patch: Partial<AudioSettings>): void => deps.settings.update('audio', patch);
  return (
    <div class="menu-tab">
      <Section title="Lautstärke">
        {BUSES.map((b) => (
          <Slider
            key={b.key}
            label={b.label}
            value={a[b.key]}
            range={MENU.ranges.volume}
            format={pct}
            onChange={(v) => set({ [b.key]: v })}
          />
        ))}
      </Section>
      <Section title="Verhalten">
        <Toggle
          label="Im Hintergrund stummschalten"
          hint="Wenn der Tab nicht aktiv ist"
          value={a.muteInBackground}
          onChange={(v) => set({ muteInBackground: v })}
        />
      </Section>
      <div class="menu-tab__footer">
        <button
          type="button"
          class="menu-btn menu-btn--ghost"
          onClick={() => deps.settings.resetSection('audio')}
        >
          Standardwerte
        </button>
      </div>
    </div>
  );
}
