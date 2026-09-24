/**
 * Dev console commands of the dynamic music (register next to registerDevCommands):
 *   music                          status (state, theme, intensity + source, layers, voices, renders)
 *   music state <menu|intermission|wave|boss|gameover|off>   force a state · `music state auto` releases it
 *   music intensity <0..1>         force the intensity (dev source) · `music intensity auto` releases it
 *   music theme <mapId>            play another map's theme (arctic, biodome, reactor, orbital, rift, …)
 *   music sting <id>               play a sting (rate limited like in the game)
 *   music boss <themeId|off>       the M6 boss hook (`boss` = generic boss theme)
 */
import type { ConsoleCommand } from '../../core/contracts';
import { MUSIC, MUSIC_STATES, MUSIC_STING_IDS, type MusicState, type MusicStingId } from '../../defs/music';
import { themeIdForMap } from './composer';
import type { MusicSystem } from './MusicSystem';

export interface MusicCommandDeps {
  music: Pick<
    MusicSystem,
    'status' | 'forceState' | 'setIntensity' | 'setMapTheme' | 'sting' | 'setBossTheme'
  >;
}

const SUBCOMMANDS = ['state', 'intensity', 'theme', 'sting', 'boss'];

const pct = (v: number): string => `${Math.round(v * 100)} %`;

export function musicStatus(deps: MusicCommandDeps): string {
  const s = deps.music.status;
  return [
    `Musik: ${s.enabled ? 'an' : 'aus'} (Lautstärke ${pct(s.volume)}) · Kontext ${s.context} · Timer ${s.timer ? 'läuft' : 'steht'}${s.hold ? ' · hält den Kontext wach' : ''}`,
    `Zustand: ${s.state}${s.forced ? ' (erzwungen)' : ''} (Spiel: ${s.autoState}) · Thema ${s.theme}` +
      ` (spielt: ${s.playing ?? '–'}${s.route ? `, Route ${s.route}` : ''}${s.pendingTheme ? `, rendert ${s.pendingTheme}` : ''})`,
    `Tempo ${s.tempo} BPM · Takt ${s.bar} · Intensität ${s.intensity.toFixed(2)} (${s.source}; Modell ${s.model.toFixed(2)})`,
    `Ebenen: ${s.layers.length > 0 ? s.layers.join(' ') : '–'} · Stimmen ${s.voices} (verworfen ${s.dropped})`,
    `Gerenderte Themen: ${s.renderedThemes} (${s.megabytes.toFixed(1)} MB)`,
  ].join('\n');
}

export function createMusicCommands(deps: MusicCommandDeps): ConsoleCommand[] {
  const themeIds = Object.keys(MUSIC.mapThemes);
  return [
    {
      name: 'music',
      aliases: ['musik'],
      description: 'Dynamische Musik: Status, Zustand, Intensität, Thema, Stings',
      usage:
        'music [state <zustand|auto> | intensity <0..1|auto> | theme <karte> | sting <id> | boss <thema|off>]',
      complete: (args) => {
        if (args.length <= 1) return SUBCOMMANDS;
        switch (args[0]) {
          case 'state':
            return [...MUSIC_STATES, 'auto'];
          case 'intensity':
            return ['0', '0.25', '0.5', '0.75', '1', 'auto'];
          case 'theme':
            return themeIds;
          case 'sting':
            return [...MUSIC_STING_IDS];
          case 'boss':
            return [MUSIC.bossTheme, 'off'];
          default:
            return [];
        }
      },
      run: ([sub, arg]) => {
        const m = deps.music;
        switch (sub) {
          case undefined:
            return musicStatus(deps);
          case 'state': {
            if (arg === 'auto') {
              m.forceState(null);
              return `Musikzustand folgt wieder dem Spiel (${m.status.state})`;
            }
            if (!arg || !(MUSIC_STATES as readonly string[]).includes(arg)) {
              throw new Error(`Zustand: ${MUSIC_STATES.join(', ')} oder auto`);
            }
            m.forceState(arg as MusicState);
            return `Musikzustand erzwungen: ${arg}`;
          }
          case 'intensity': {
            if (arg === 'auto') {
              m.setIntensity(null, 'dev');
              return 'Intensität folgt wieder Modell / Spawn-Director';
            }
            const v = Number(arg);
            if (arg === undefined || !Number.isFinite(v) || v < 0 || v > 1)
              throw new Error('Intensität: 0..1 oder auto');
            m.setIntensity(v, 'dev');
            return `Intensität erzwungen: ${v.toFixed(2)}`;
          }
          case 'theme': {
            if (!arg) throw new Error(`Karte: ${themeIds.join(', ')}`);
            m.setMapTheme(arg);
            const id = themeIdForMap(arg);
            return id === arg ? `Kartenthema: ${id}` : `Unbekannte Karte „${arg}“ – Thema ${id}`;
          }
          case 'sting': {
            if (!arg || !(MUSIC_STING_IDS as readonly string[]).includes(arg)) {
              throw new Error(`Sting: ${MUSIC_STING_IDS.join(', ')}`);
            }
            return m.sting(arg as MusicStingId)
              ? `Sting ${arg}`
              : `Sting ${arg} gedrosselt (zu kurz nacheinander)`;
          }
          case 'boss': {
            if (!arg) throw new Error(`boss <${MUSIC.bossTheme}|off>`);
            m.setBossTheme(arg === 'off' ? null : arg);
            return arg === 'off' ? 'Bossmusik beendet' : `Bossmusik: ${arg}`;
          }
          default:
            throw new Error(`Unterbefehl: ${SUBCOMMANDS.join(', ')}`);
        }
      },
    },
  ];
}
