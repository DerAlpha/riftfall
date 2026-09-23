/** Small, keyboard-friendly form widgets for the settings menus. */
import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import type { RangeDef } from '../../defs/ui';

export function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="menu-section">
      <h3 class="menu-section__title">{title}</h3>
      <div class="menu-section__body">{children}</div>
    </section>
  );
}

/** Hint for a setting whose system arrives in a later milestone (the control is disabled until then). */
export const fromMilestone = (milestone: number): string => `Verfügbar ab Meilenstein ${milestone}`;

function Row({
  label,
  labelFor,
  hint,
  disabled = false,
  children,
}: {
  label: string;
  labelFor?: string;
  hint?: string;
  disabled?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class={`menu-row${disabled ? ' menu-row--disabled' : ''}`}>
      <div class="menu-row__label">
        {labelFor ? <label for={labelFor}>{label}</label> : <span>{label}</span>}
        {hint ? <span class="menu-row__hint">{hint}</span> : null}
      </div>
      <div class="menu-row__control">{children}</div>
    </div>
  );
}

export function Slider({
  label,
  value,
  range,
  format,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  range: RangeDef;
  format: (v: number) => string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const v = Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, value)) : range.min;
  const pct = range.max > range.min ? ((v - range.min) / (range.max - range.min)) * 100 : 0;
  return (
    <Row label={label} labelFor={id} hint={hint}>
      <input
        id={id}
        class="menu-slider"
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={v}
        style={{ '--fill': `${pct.toFixed(1)}%` }}
        onInput={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n)) onChange(n);
        }}
      />
      <output class="menu-value" for={id}>
        {format(v)}
      </output>
    </Row>
  );
}

export function Toggle({
  label,
  value,
  hint,
  onLabel = 'AN',
  offLabel = 'AUS',
  disabled = false,
  onChange,
}: {
  label: string;
  value: boolean;
  hint?: string;
  onLabel?: string;
  offLabel?: string;
  /** Shown but not changeable (no system reads the setting yet). */
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  return (
    <Row label={label} labelFor={id} hint={hint} disabled={disabled}>
      <button
        id={id}
        type="button"
        role="switch"
        disabled={disabled}
        aria-checked={value}
        class={`menu-toggle${value ? ' is-on' : ''}`}
        onClick={() => onChange(!value)}
      >
        <span class="menu-toggle__knob" />
        <span class="menu-toggle__text">{value ? onLabel : offLabel}</span>
      </button>
    </Row>
  );
}

export interface Option<T> {
  value: T;
  label: string;
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  hint,
  disabled = false,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly Option<T>[];
  hint?: string;
  /** Shown but not changeable (no system reads the setting yet). */
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <Row label={label} hint={hint} disabled={disabled}>
      <div class="menu-segmented" role="radiogroup" aria-label={label} aria-disabled={disabled}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            disabled={disabled}
            aria-checked={o.value === value}
            class={`menu-segmented__opt${o.value === value ? ' is-active' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

export function ActionRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <Row label={label} hint={hint}>
      {children}
    </Row>
  );
}

export const pct = (v: number): string => `${Math.round(v * 100)} %`;
export const fixed =
  (digits: number) =>
  (v: number): string =>
    v.toFixed(digits).replace('.', ',');
