import { MENU } from '../../defs/ui';
import type { AccessibilitySettings, GameplaySettings } from '../../save/settingsSchema';
import { useSettings, type MenuDeps } from './context';
import { ActionRow, fromMilestone, pct, Section, Segmented, Slider, Toggle, type Option } from './widgets';

const COLORBLIND: readonly Option<AccessibilitySettings['colorblindMode']>[] = [
  { value: 'none', label: 'Aus' },
  { value: 'protanopia', label: 'Protanopie' },
  { value: 'deuteranopia', label: 'Deuteranopie' },
  { value: 'tritanopia', label: 'Tritanopie' },
];

const CROSSHAIRS: readonly Option<GameplaySettings['crosshair']>[] = [
  { value: 'dot', label: 'Punkt' },
  { value: 'cross', label: 'Kreuz' },
  { value: 'circle', label: 'Kreis' },
  { value: 'chevron', label: 'Chevron' },
];

export function AccessibilityTab({ deps }: { deps: MenuDeps }) {
  const s = useSettings(deps);
  const a = s.accessibility;
  const g = s.gameplay;
  const setA = (patch: Partial<AccessibilitySettings>): void => deps.settings.update('accessibility', patch);
  const setG = (patch: Partial<GameplaySettings>): void => deps.settings.update('gameplay', patch);
  const r = MENU.ranges;
  const later = MENU.plannedMilestone;
  return (
    <div class="menu-tab">
      <Section title="Sehen">
        <Segmented
          label="Farbenblind-Modus"
          value={a.colorblindMode}
          options={COLORBLIND}
          onChange={(v) => setA({ colorblindMode: v })}
        />
        <Toggle
          label="Blitzeffekte reduzieren"
          hint="Weniger Treffer-Blitze, Aberration und Pulsieren"
          value={a.reduceFlashing}
          onChange={(v) => setA({ reduceFlashing: v })}
        />
        <Toggle
          label="Untertitel"
          hint={fromMilestone(later.subtitles)}
          disabled
          value={a.subtitles}
          onChange={(v) => setA({ subtitles: v })}
        />
      </Section>

      <Section title="Bewegungsempfindlichkeit">
        <Slider
          label="Bildschirmwackeln"
          value={a.screenShake}
          range={r.screenShake}
          format={pct}
          onChange={(v) => setA({ screenShake: v })}
        />
        <Slider
          label="Kamerabewegung"
          hint="Kopfwippen und Neigung"
          value={a.cameraMotion}
          range={r.cameraMotion}
          format={pct}
          onChange={(v) => setA({ cameraMotion: v })}
        />
      </Section>

      <Section title="HUD & Fadenkreuz">
        <Slider
          label="HUD-Größe"
          value={a.hudScale}
          range={r.hudScale}
          format={pct}
          onChange={(v) => setA({ hudScale: v })}
        />
        <Segmented
          label="Fadenkreuz"
          value={g.crosshair}
          options={CROSSHAIRS}
          onChange={(v) => setG({ crosshair: v })}
        />
        <ActionRow label="Fadenkreuzfarbe">
          <div class="menu-swatches" role="radiogroup" aria-label="Fadenkreuzfarbe">
            {MENU.crosshairColors.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={g.crosshairColor.toLowerCase() === c}
                aria-label={c}
                class={`menu-swatch${g.crosshairColor.toLowerCase() === c ? ' is-active' : ''}`}
                style={{ '--swatch': c }}
                onClick={() => setG({ crosshairColor: c })}
              />
            ))}
            <input
              class="menu-color"
              type="color"
              aria-label="Eigene Farbe"
              value={/^#[0-9a-f]{6}$/i.test(g.crosshairColor) ? g.crosshairColor : MENU.crosshairColors[0]}
              onInput={(e) => setG({ crosshairColor: e.currentTarget.value })}
            />
          </div>
        </ActionRow>
        <Toggle
          label="Treffermarker"
          value={g.hitmarkers}
          onChange={(v) => setG({ hitmarkers: v })}
        />
        <Toggle
          label="Schadenszahlen"
          value={g.damageNumbers}
          onChange={(v) => setG({ damageNumbers: v })}
        />
      </Section>

      <div class="menu-tab__footer">
        <button
          type="button"
          class="menu-btn menu-btn--ghost"
          onClick={() => {
            deps.settings.resetSection('accessibility');
            deps.settings.resetSection('gameplay');
          }}
        >
          Standardwerte
        </button>
      </div>
    </div>
  );
}
