/**
 * Developer console (Quake style). Toggled with the physical key left of "1" ("^" on German, "`" on
 * US layouts). Commands are registered by the composition root (src/game/devCommands.ts).
 * While open, `ui:console` { open: true } tells the game to disable gameplay input.
 */
import type { ConsoleCommand, DevConsoleApi } from '../../core/contracts';
import type { EventBus } from '../../core/EventBus';
import type { GameEvents } from '../../core/events';
import { createLogger, getLogHistory, onLog, type LogEntry } from '../../core/log';
import { DEV_CONSOLE } from '../../defs/ui';
import { isConsoleToggleKey } from '../../input/bindings';
import { completeLastWord, lastCommandStart, splitCommands, tokenize } from './parse';

const log = createLogger('Console');

type LineKind = 'info' | 'warn' | 'error' | 'input';

/** Characters the toggle key can leave behind in the input (dead-key compositions). */
const TOGGLE_CHARS = /[\^`°~]/g;
const TRAILING_TOGGLE_CHARS = /[\^`°~]+$/;

export class DevConsole implements DevConsoleApi {
  private _open = false;
  private readonly commands = new Map<string, ConsoleCommand>();
  /** Primary commands (no aliases), in registration order, for help. */
  private readonly primary: ConsoleCommand[] = [];
  private history: string[] = [];
  private historyPos = -1;
  private draft = '';
  private suppressCharsUntil = 0;
  private lineCount = 0;
  /** Consecutive identical log lines are collapsed into one line with a counter (warning spam). */
  private lastLog: { text: string; el: HTMLElement; count: number } | null = null;
  /** Element focused before the console opened (menus), restored on close. */
  private returnFocus: HTMLElement | null = null;

  private readonly panel: HTMLDivElement;
  private readonly output: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    root: HTMLElement,
    private readonly events: EventBus<GameEvents>,
  ) {
    this.panel = document.createElement('div');
    this.panel.className = 'dev-console';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Entwicklerkonsole');
    this.panel.setAttribute('aria-hidden', 'true');

    const header = document.createElement('div');
    header.className = 'dev-console__header';
    header.innerHTML =
      '<span class="dev-console__title">RIFTFALL // KONSOLE</span><span class="dev-console__hint">help · Tab ergänzt · ↑↓ Verlauf · ^ / Esc schließt</span>';

    this.output = document.createElement('div');
    this.output.className = 'dev-console__output';
    this.output.setAttribute('role', 'log');
    this.output.setAttribute('aria-live', 'polite');

    const row = document.createElement('label');
    row.className = 'dev-console__inputrow';
    const prompt = document.createElement('span');
    prompt.className = 'dev-console__prompt';
    prompt.textContent = DEV_CONSOLE.prompt;
    this.input = document.createElement('input');
    this.input.className = 'dev-console__input';
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('aria-label', 'Konsolenbefehl');
    this.input.tabIndex = -1;
    row.append(prompt, this.input);

    this.panel.append(header, this.output, row);
    root.appendChild(this.panel);

    this.loadHistory();
    this.registerBuiltins();

    window.addEventListener('keydown', this.onWindowKey, true);
    this.input.addEventListener('keydown', this.onInputKey);
    this.input.addEventListener('input', this.onInputChange);
    this.unsubs.push(onLog(this.onLogEntry));

    this.print('RIFTFALL Entwicklerkonsole – „help“ listet alle Befehle.', 'info');
    const recent = getLogHistory().filter((e) => e.level === 'warn' || e.level === 'error');
    for (const e of recent.slice(-DEV_CONSOLE.recentWarnings)) this.printLog(e);
  }

  get open(): boolean {
    return this._open;
  }

  register(cmd: ConsoleCommand): void {
    const names = [cmd.name, ...(cmd.aliases ?? [])].map((n) => n.toLowerCase());
    for (const n of names) {
      if (this.commands.has(n)) log.warn(`Befehl „${n}“ wird überschrieben`);
      this.commands.set(n, cmd);
    }
    const idx = this.primary.findIndex((c) => c.name.toLowerCase() === cmd.name.toLowerCase());
    if (idx >= 0) this.primary[idx] = cmd;
    else this.primary.push(cmd);
  }

  print(text: string, kind: LineKind = 'info'): void {
    this.lastLog = null;
    this.appendLine(text, kind);
  }

  private appendLine(text: string, kind: LineKind): HTMLElement {
    const line = document.createElement('div');
    line.className = `dev-console__line dev-console__line--${kind}`;
    line.textContent = text;
    this.output.appendChild(line);
    this.lineCount++;
    while (this.lineCount > DEV_CONSOLE.maxLines && this.output.firstChild) {
      this.output.removeChild(this.output.firstChild);
      this.lineCount--;
    }
    if (this._open) this.output.scrollTop = this.output.scrollHeight;
    return line;
  }

  async execute(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed === '') return;
    this.print(`${DEV_CONSOLE.prompt} ${trimmed}`, 'input');
    for (const part of splitCommands(trimmed)) await this.runOne(part);
  }

  toggle(force?: boolean): void {
    const next = force ?? !this._open;
    if (next === this._open) return;
    this._open = next;
    this.panel.classList.toggle('dev-console--open', next);
    this.panel.setAttribute('aria-hidden', next ? 'false' : 'true');
    this.suppressCharsUntil = performance.now() + DEV_CONSOLE.toggleCharSuppressMs;
    if (next) {
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement && active !== document.body ? active : null;
      this.input.value = this.input.value.replace(TRAILING_TOGGLE_CHARS, '');
      this.input.focus({ preventScroll: true });
      this.output.scrollTop = this.output.scrollHeight;
    } else {
      const back = this.returnFocus;
      this.returnFocus = null;
      // Keyboard users in a menu get their focus back instead of losing it to <body>.
      if (back && back.isConnected && back !== this.input) back.focus({ preventScroll: true });
      else this.input.blur();
    }
    this.events.emit('ui:console', { open: next });
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onWindowKey, true);
    this.input.removeEventListener('keydown', this.onInputKey);
    this.input.removeEventListener('input', this.onInputChange);
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.panel.remove();
  }

  // -------------------------------------------------------------------------

  private async runOne(text: string): Promise<void> {
    const tokens = tokenize(text);
    const name = tokens[0]?.toLowerCase();
    if (!name) return;
    const cmd = this.commands.get(name);
    if (!cmd) {
      this.print(`Unbekannter Befehl: „${tokens[0]}“ – „help“ listet alle Befehle.`, 'error');
      return;
    }
    try {
      const result = await cmd.run(tokens.slice(1));
      if (typeof result === 'string' && result.length > 0) this.print(result, 'info');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.print(`${cmd.name}: ${msg}${cmd.usage ? `  (Verwendung: ${cmd.usage})` : ''}`, 'error');
    }
  }

  private registerBuiltins(): void {
    this.register({
      name: 'help',
      aliases: ['?', 'hilfe'],
      description: 'Befehle auflisten oder Hilfe zu einem Befehl',
      usage: 'help [befehl]',
      complete: () => this.primary.map((c) => c.name),
      run: ([topic]) => {
        if (topic) {
          const c = this.commands.get(topic.toLowerCase());
          if (!c) throw new Error(`unbekannter Befehl „${topic}“`);
          const aliases = c.aliases?.length ? `\nAliase: ${c.aliases.join(', ')}` : '';
          return `${c.name} – ${c.description}\nVerwendung: ${c.usage ?? c.name}${aliases}`;
        }
        const sorted = [...this.primary].sort((a, b) => a.name.localeCompare(b.name));
        const width = Math.max(...sorted.map((c) => (c.usage ?? c.name).length));
        return sorted.map((c) => `${(c.usage ?? c.name).padEnd(width)}  ${c.description}`).join('\n');
      },
    });
    this.register({
      name: 'clear',
      aliases: ['cls'],
      description: 'Ausgabe leeren',
      run: () => {
        this.output.replaceChildren();
        this.lineCount = 0;
        this.lastLog = null;
      },
    });
    this.register({
      name: 'echo',
      description: 'Text ausgeben',
      usage: 'echo <text…>',
      run: (args) => args.join(' '),
    });
  }

  private complete(): void {
    // Only the last command of a `a; b` chain is completed; everything before it is kept verbatim.
    const full = this.input.value;
    const start = lastCommandStart(full);
    const before = full.slice(0, start);
    const value = full.slice(start).replace(/^\s+/, '');
    const glue = before !== '' ? ' ' : '';
    const tokens = tokenize(value);
    const typingName = tokens.length === 0 || (tokens.length === 1 && !/\s$/.test(value));
    let candidates: string[];
    if (typingName) {
      candidates = [...this.commands.keys()].filter((n) => n !== '?');
    } else {
      const cmd = this.commands.get(tokens[0]!.toLowerCase());
      if (!cmd?.complete) return;
      const args = tokens.slice(1);
      if (/\s$/.test(value)) args.push('');
      try {
        candidates = cmd.complete(args);
      } catch (err) {
        log.warn(`Vervollständigung für „${cmd.name}“ fehlgeschlagen`, err);
        return;
      }
    }
    const { line, matches } = completeLastWord(value, candidates);
    if (matches.length > 1) this.print(matches.join('   '), 'info');
    const next = before + glue + line;
    this.input.value = next;
    this.input.setSelectionRange(next.length, next.length);
  }

  private readonly onWindowKey = (e: KeyboardEvent): void => {
    if (!isConsoleToggleKey(e.code, e.key)) return;
    // Keep the "^" / "`" out of whatever has focus (and out of our own input).
    e.preventDefault();
    if (e.repeat) return;
    this.toggle();
  };

  private readonly onInputKey = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'Enter': {
        e.preventDefault();
        const line = this.input.value;
        this.input.value = '';
        this.pushHistory(line);
        void this.execute(line);
        break;
      }
      case 'Escape':
        e.preventDefault();
        this.toggle(false);
        break;
      case 'Tab':
        e.preventDefault();
        this.complete();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.browseHistory(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.browseHistory(1);
        break;
      default:
        break;
    }
    // Typing must never reach gameplay handlers or global hotkeys.
    e.stopPropagation();
  };

  private readonly onInputChange = (): void => {
    if (performance.now() < this.suppressCharsUntil) {
      const cleaned = this.input.value.replace(TOGGLE_CHARS, '');
      if (cleaned !== this.input.value) this.input.value = cleaned;
    }
  };

  private readonly onLogEntry = (e: LogEntry): void => {
    if (e.level === 'warn' || e.level === 'error') this.printLog(e);
  };

  private printLog(e: LogEntry): void {
    const text = `[${e.tag}] ${e.message}`;
    const last = this.lastLog;
    if (last && last.text === text && last.el.isConnected) {
      last.count++;
      last.el.textContent = `${text}  (×${last.count})`;
      return;
    }
    const el = this.appendLine(text, e.level === 'error' ? 'error' : 'warn');
    this.lastLog = { text, el, count: 1 };
  }

  // --- history (sessionStorage) ---

  private pushHistory(line: string): void {
    const t = line.trim();
    this.historyPos = -1;
    this.draft = '';
    if (t === '' || this.history[this.history.length - 1] === t) return;
    this.history.push(t);
    if (this.history.length > DEV_CONSOLE.historySize)
      this.history.splice(0, this.history.length - DEV_CONSOLE.historySize);
    try {
      sessionStorage.setItem(DEV_CONSOLE.historyStorageKey, JSON.stringify(this.history));
    } catch {
      /* storage unavailable (privacy mode): history stays in memory */
    }
  }

  private loadHistory(): void {
    try {
      const raw = sessionStorage.getItem(DEV_CONSOLE.historyStorageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        this.history = parsed
          .filter((x): x is string => typeof x === 'string')
          .slice(-DEV_CONSOLE.historySize);
      }
    } catch {
      this.history = [];
    }
  }

  private browseHistory(dir: -1 | 1): void {
    if (this.history.length === 0) return;
    if (this.historyPos === -1) {
      if (dir === 1) return;
      this.draft = this.input.value;
      this.historyPos = this.history.length - 1;
    } else {
      this.historyPos += dir;
      if (this.historyPos < 0) this.historyPos = 0;
      if (this.historyPos >= this.history.length) {
        this.historyPos = -1;
        this.input.value = this.draft;
        return;
      }
    }
    const v = this.history[this.historyPos] ?? '';
    this.input.value = v;
    this.input.setSelectionRange(v.length, v.length);
  }
}
