import { describe, expect, it } from 'vitest';
import {
  commonPrefix,
  completeLastWord,
  lastCommandStart,
  parseBool,
  parseNumber,
  quoteArg,
  splitCommands,
  tokenize,
} from './parse';

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('  tp  1 2   3 ')).toEqual(['tp', '1', '2', '3']);
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });

  it('groups quoted text and keeps empty quotes', () => {
    expect(tokenize('echo "hallo welt" \'a b\'')).toEqual(['echo', 'hallo welt', 'a b']);
    expect(tokenize('echo ""')).toEqual(['echo', '']);
    expect(tokenize('echo pre"mid dle"post')).toEqual(['echo', 'premid dlepost']);
  });

  it('handles escapes', () => {
    expect(tokenize('echo a\\ b')).toEqual(['echo', 'a b']);
    expect(tokenize('echo "sag \\"hi\\""')).toEqual(['echo', 'sag "hi"']);
    expect(tokenize('echo zeile1\\nzeile2')).toEqual(['echo', 'zeile1\nzeile2']);
    expect(tokenize('echo c:\\\\pfad')).toEqual(['echo', 'c:\\pfad']);
  });

  it('runs an unterminated quote to the end', () => {
    expect(tokenize('echo "offen bis zum ende')).toEqual(['echo', 'offen bis zum ende']);
  });
});

describe('splitCommands', () => {
  it('splits at unquoted semicolons', () => {
    expect(splitCommands('god on; noclip on ;;')).toEqual(['god on', 'noclip on']);
    expect(splitCommands('echo "a;b"; echo c')).toEqual(['echo "a;b"', 'echo c']);
    expect(splitCommands('echo a\\;b')).toEqual(['echo a\\;b']);
    expect(tokenize(splitCommands('echo a\\;b')[0]!)).toEqual(['echo', 'a;b']);
  });
});

describe('value parsers', () => {
  it('parses numbers incl. German decimal comma', () => {
    expect(parseNumber('1.5')).toBe(1.5);
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('-2')).toBe(-2);
    expect(parseNumber('.5')).toBe(0.5);
    expect(parseNumber('1e3')).toBe(1000);
    expect(parseNumber('0x1f')).toBe(31);
    expect(parseNumber('-0x10')).toBe(-16);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('1,2,3')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber(undefined)).toBeNull();
    expect(parseNumber('Infinity')).toBeNull();
  });

  it('parses booleans in English and German', () => {
    for (const t of ['1', 'on', 'TRUE', 'an', 'ein', 'ja']) expect(parseBool(t)).toBe(true);
    for (const f of ['0', 'off', 'false', 'aus', 'nein']) expect(parseBool(f)).toBe(false);
    expect(parseBool('vielleicht')).toBeNull();
    expect(parseBool(undefined)).toBeNull();
  });

  it('quotes arguments only when needed', () => {
    expect(quoteArg('abc')).toBe('abc');
    expect(quoteArg('a b')).toBe('"a b"');
    expect(quoteArg('')).toBe('""');
    expect(tokenize(`echo ${quoteArg('sag "x" \\ y')}`)).toEqual(['echo', 'sag "x" \\ y']);
  });

  it('computes common prefixes', () => {
    expect(commonPrefix(['noclip', 'nobody', 'no'])).toBe('no');
    expect(commonPrefix(['abc'])).toBe('abc');
    expect(commonPrefix([])).toBe('');
    expect(commonPrefix(['x', 'y'])).toBe('');
  });
});

describe('completeLastWord', () => {
  const cmds = ['god', 'noclip', 'help', 'heal', 'hurt'];

  it('completes a unique command and appends a space', () => {
    expect(completeLastWord('noc', cmds)).toEqual({ line: 'noclip ', matches: ['noclip'] });
    expect(completeLastWord('GO', cmds).line).toBe('god ');
  });

  it('extends to the common prefix when ambiguous', () => {
    const r = completeLastWord('h', cmds);
    expect(r.matches).toEqual(['heal', 'help', 'hurt']);
    expect(r.line).toBe('h');
    expect(completeLastWord('he', cmds)).toEqual({ line: 'he', matches: ['heal', 'help'] });
    expect(completeLastWord('hel', cmds).line).toBe('help ');
  });

  it('completes arguments after a space', () => {
    expect(completeLastWord('preset u', ['low', 'medium', 'high', 'ultra']).line).toBe('preset ultra ');
    expect(completeLastWord('preset ', ['low', 'medium']).matches).toEqual(['low', 'medium']);
  });

  it('leaves the line unchanged without matches', () => {
    expect(completeLastWord('xyz', cmds)).toEqual({ line: 'xyz', matches: [] });
  });
});

describe('lastCommandStart', () => {
  it('finds the start of the last chained command, ignoring quoted/escaped semicolons', () => {
    expect(lastCommandStart('god on')).toBe(0);
    expect(lastCommandStart('god on; noc')).toBe(7);
    expect(lastCommandStart('echo "a;b" x')).toBe(0);
    expect(lastCommandStart('echo a\\;b')).toBe(0);
    expect(lastCommandStart('a;b;')).toBe(4);
  });
});
