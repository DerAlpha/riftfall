/** Tiny DOM helpers of the economy HUD widgets (no framework; everything built once, then patched). */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: Element,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  parent?.appendChild(el);
  return el;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Readonly<Record<string, string | number>>,
  parent?: Element,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  parent?.appendChild(el);
  return el;
}

/** A 24×24 stroke-glyph icon (PERK_GLYPHS / POWERUP_GLYPHS path data); returns its path. */
export function glyphIcon(className: string, parent: Element, d = ''): SVGPathElement {
  const svg = svgEl('svg', { class: className, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, parent);
  return svgEl('path', { d }, svg);
}

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Restart a CSS entry animation without forcing layout: two identically shaped animation classes
 * (`<base>-a` / `<base>-b`) alternate. Returns the new phase.
 */
export function restartAnim(el: Element, base: string, phase: boolean): boolean {
  const next = !phase;
  el.classList.toggle(`${base}-a`, next);
  el.classList.toggle(`${base}-b`, !next);
  return next;
}
