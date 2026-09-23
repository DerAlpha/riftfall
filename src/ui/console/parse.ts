/** Dev console line parsing: tokenizer with quotes/escapes and small value parsers. Pure, unit-tested. */

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  '\\': '\\',
  '"': '"',
  "'": "'",
  ' ': ' ',
  ';': ';',
};

/**
 * Split a command line into tokens. Whitespace separates tokens; "double" or 'single' quotes group
 * (an unterminated quote runs to the end of the line); a backslash escapes the next character
 * (\n and \t are translated). Empty quoted strings produce an empty token.
 */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && i + 1 < line.length) {
      const next = line[++i]!;
      cur += ESCAPES[next] ?? next;
      inToken = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
      continue;
    }
    cur += ch;
    inToken = true;
  }
  if (inToken) out.push(cur);
  return out;
}

/** Split a line into commands at unquoted, unescaped semicolons. Empty commands are dropped. */
export function splitCommands(line: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ';') {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Index where the last `;`-separated command of `line` starts (0 if there is no unquoted separator). */
export function lastCommandStart(line: string): number {
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ';') start = i + 1;
  }
  return start;
}

/** Quote a token for re-insertion into the input line (completion). */
export function quoteArg(s: string): string {
  if (s === '') return '""';
  if (!/[\s"'\\;]/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Number parser accepting "1.5", German "1,5", "-2", "1e3", "0x1f"; null for anything else. */
export function parseNumber(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === '') return null;
  if (/^[+-]?0x[0-9a-f]+$/i.test(t)) {
    const neg = t.startsWith('-');
    const v = parseInt(t.replace(/^[+-]/, ''), 16);
    return neg ? -v : v;
  }
  const normalized = /^[+-]?\d+,\d+$/.test(t) ? t.replace(',', '.') : t;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(normalized)) return null;
  const v = Number(normalized);
  return Number.isFinite(v) ? v : null;
}

const TRUE_WORDS: ReadonlySet<string> = new Set(['1', 'on', 'true', 'yes', 'an', 'ein', 'ja']);
const FALSE_WORDS: ReadonlySet<string> = new Set(['0', 'off', 'false', 'no', 'aus', 'nein']);

/** Boolean parser (English + German words); null if not a boolean. */
export function parseBool(s: string | undefined): boolean | null {
  if (s === undefined) return null;
  const t = s.trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  return null;
}

/** Longest common prefix (case-sensitive) of all strings; '' for an empty list. */
export function commonPrefix(list: readonly string[]): string {
  if (list.length === 0) return '';
  let p = list[0]!;
  for (let i = 1; i < list.length && p.length > 0; i++) {
    const s = list[i]!;
    let j = 0;
    while (j < p.length && j < s.length && p[j] === s[j]) j++;
    p = p.slice(0, j);
  }
  return p;
}

export interface CompletionResult {
  /** New input line (unchanged when nothing matched). */
  line: string;
  /** All candidates matching the partial word (for listing when ambiguous). */
  matches: string[];
}

/**
 * Complete the last word of `line` from `candidates` (case-insensitive prefix match). A unique match
 * is inserted followed by a space; several matches are reduced to their common prefix.
 */
export function completeLastWord(line: string, candidates: readonly string[]): CompletionResult {
  const tokens = tokenize(line);
  const endsWithSpace = line.length > 0 && /\s$/.test(line) && !isInsideQuote(line);
  const partial = endsWithSpace || tokens.length === 0 ? '' : tokens[tokens.length - 1]!;
  const head = endsWithSpace ? tokens : tokens.slice(0, -1);
  const lower = partial.toLowerCase();
  const matches = [...new Set(candidates)].filter((c) => c.toLowerCase().startsWith(lower)).sort();
  if (matches.length === 0) return { line, matches };
  const rebuild = (word: string, finished: boolean): string =>
    [...head.map(quoteArg), finished ? quoteArg(word) : word].join(' ') + (finished ? ' ' : '');
  if (matches.length === 1) return { line: rebuild(matches[0]!, true), matches };
  const prefix = commonPrefix(matches.map((m) => m.toLowerCase()));
  // Keep the user's text if the common prefix does not extend it.
  const extended = prefix.length > partial.length ? matches[0]!.slice(0, prefix.length) : partial;
  return { line: head.length === 0 && extended === '' ? line : rebuild(extended, false), matches };
}

function isInsideQuote(line: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
  }
  return quote !== null;
}
