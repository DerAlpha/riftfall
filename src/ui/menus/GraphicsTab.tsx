import { MENU } from '../../defs/ui';
import type { GraphicsSettings, QualityLevel, QualityPreset } from '../../save/settingsSchema';
import { useSettings, type MenuDeps } from './context';
import { individualPatch, PRESET_ORDER, presetPatch } from './presets';
import { fixed, fromMilestone, pct, Section, Segmented, Slider, Toggle, type Option } from './widgets';

const PRESET_LABELS: Readonly<Record<QualityPreset, string>> = {
  low: 'Niedrig',
  medium: 'Mittel',
  high: 'Hoch',
  ultra: 'Ultra',
};

const LEVELS: readonly Option<QualityLevel>[] = [
  { value: 'off', label: 'Aus' },
  { value: 'low', label: 'Niedrig' },
  { value: 'medium', label: 'Mittel' },
  { value: 'high', label: 'Hoch' },
  { value: 'ultra', label: 'Ultra' },
];

const TEXTURES: readonly Option<GraphicsSettings['textureQuality']>[] = [
  { value: 'low', label: 'Niedrig' },
  { value: 'medium', label: 'Mittel' },
  { value: 'high', label: 'Hoch' },
];

const AA: readonly Option<GraphicsSettings['antialiasing']>[] = [
  { value: 'off', label: 'Aus' },
  { value: 'fxaa', label: 'FXAA' },
  { value: 'smaa', label: 'SMAA' },
];

const TONEMAP: readonly Option<GraphicsSettings['toneMapping']>[] = [
  { value: 'agx', label: 'AgX' },
  { value: 'aces', label: 'ACES' },
  { value: 'neutral', label: 'Neutral' },
];

const FPS_LIMITS: readonly Option<number>[] = MENU.fpsLimitOptions.map((v) => ({
  value: v,
  label: v === 0 ? 'Aus' : String(v),
}));
const TARGET_FPS: readonly Option<number>[] = MENU.targetFpsOptions.map((v) => ({
  value: v,
  label: String(v),
}));
const ANISO: readonly Option<number>[] = MENU.anisotropyOptions.map((v) => ({ value: v, label: `${v}×` }));

export function GraphicsTab({ deps }: { deps: MenuDeps }) {
  const s = useSettings(deps);
  const g = s.graphics;
  const set = (patch: Partial<GraphicsSettings>): void =>
    deps.settings.update('graphics', individualPatch(g, patch));
  const info = deps.getInfo();
  const r = MENU.ranges;

  return (
    <div class="menu-tab">
      <Section title="Qualitätsstufe">
        <div class="menu-presets" role="radiogroup" aria-label="Grafik-Preset">
          {PRESET_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={g.preset === p}
              class={`menu-preset${g.preset === p ? ' is-active' : ''}`}
              onClick={() => deps.settings.update('graphics', presetPatch(p))}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
          <span
            class={`menu-preset menu-preset--custom${g.preset === 'custom' ? ' is-active' : ''}`}
            aria-hidden="true"
          >
            Benutzerdefiniert
          </span>
        </div>
        <div class="menu-gpu">
          <span class="menu-gpu__label">GPU</span>
          <span class="menu-gpu__name">{info.gpuName || 'unbekannt'}</span>
        </div>
      </Section>

      <Section title="Auflösung & Leistung">
        <Slider
          label="Render-Skalierung"
          hint="Obergrenze; die dynamische Auflösung regelt darunter"
          value={g.renderScale}
          range={r.renderScale}
          format={pct}
          onChange={(v) => set({ renderScale: v })}
        />
        <Toggle
          label="Dynamische Auflösung"
          hint="Hält die Ziel-Framerate"
          value={g.dynamicResolution}
          onChange={(v) => set({ dynamicResolution: v })}
        />
        <Segmented
          label="Ziel-FPS"
          value={g.targetFps}
          options={TARGET_FPS}
          onChange={(v) => set({ targetFps: v })}
        />
        <Segmented
          label="FPS-Limit"
          value={g.fpsLimit}
          options={FPS_LIMITS}
          onChange={(v) => set({ fpsLimit: v })}
        />
        <Slider
          label="Max. Pixeldichte"
          hint="Begrenzt HiDPI-Bildschirme"
          value={g.maxPixelRatio}
          range={r.maxPixelRatio}
          format={(v) => `${fixed(2)(v)}×`}
          onChange={(v) => set({ maxPixelRatio: v })}
        />
        <Toggle label="FPS anzeigen" value={g.showFps} onChange={(v) => set({ showFps: v })} />
      </Section>

      <Section title="Licht & Effekte">
        <Segmented
          label="Schatten"
          value={g.shadows}
          options={LEVELS}
          onChange={(v) => set({ shadows: v })}
        />
        <Segmented
          label="Umgebungsverdeckung"
          value={g.ambientOcclusion}
          options={LEVELS}
          onChange={(v) => set({ ambientOcclusion: v })}
        />
        <Segmented label="Bloom" value={g.bloom} options={LEVELS} onChange={(v) => set({ bloom: v })} />
        <Segmented
          label="Volumetrisches Licht"
          value={g.volumetrics}
          options={LEVELS}
          onChange={(v) => set({ volumetrics: v })}
        />
        <Segmented
          label="Partikel"
          hint={fromMilestone(MENU.plannedMilestone.particles)}
          disabled
          value={g.particles}
          options={LEVELS}
          onChange={(v) => set({ particles: v })}
        />
        <Segmented
          label="Texturqualität"
          value={g.textureQuality}
          options={TEXTURES}
          onChange={(v) => set({ textureQuality: v })}
        />
        <Segmented
          label="Anisotrope Filterung"
          value={g.anisotropy}
          options={ANISO}
          onChange={(v) => set({ anisotropy: v })}
        />
      </Section>

      <Section title="Nachbearbeitung">
        <Segmented
          label="Kantenglättung"
          value={g.antialiasing}
          options={AA}
          onChange={(v) => set({ antialiasing: v })}
        />
        <Toggle label="Bewegungsunschärfe" value={g.motionBlur} onChange={(v) => set({ motionBlur: v })} />
        <Toggle
          label="Tiefenunschärfe beim Zielen"
          value={g.depthOfField}
          onChange={(v) => set({ depthOfField: v })}
        />
        <Toggle label="Filmkorn" value={g.filmGrain} onChange={(v) => set({ filmGrain: v })} />
        <Toggle
          label="Chromatische Aberration"
          value={g.chromaticAberration}
          onChange={(v) => set({ chromaticAberration: v })}
        />
        <Toggle label="Vignette" value={g.vignette} onChange={(v) => set({ vignette: v })} />
        <Segmented
          label="Tone Mapping"
          value={g.toneMapping}
          options={TONEMAP}
          onChange={(v) => set({ toneMapping: v })}
        />
        <Slider
          label="Helligkeit"
          value={g.exposure}
          range={r.exposure}
          format={pct}
          onChange={(v) => set({ exposure: v })}
        />
      </Section>
    </div>
  );
}
