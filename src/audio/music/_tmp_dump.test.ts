import { it } from 'vitest';
import { composeTheme } from './composer';
import { MUSIC_LAYERS } from '../../defs/music';
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nn = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
it('dump', () => {
  for (const id of (process.env.THEMES ?? 'lab').split(',')) {
    const t = composeTheme(id);
    const out: string[] = [`== ${id} ${t.def.scale} key ${nn(t.def.key)} tempo ${t.def.tempo}`];
    t.phrases.forEach((ph, pi) => {
      out.push(` phrase ${pi} progression ${ph.progression.join(' ')}`);
      ph.bars.forEach((b, bi) => {
        const by = (slot: string) => b.events.filter((e) => e.slot === slot);
        const pad = by('pad').map((e) => nn(e.note)).join(' ');
        const bass = by('bass').filter((e) => e.tier <= 0.45).map((e) => `${e.step}:${nn(e.note)}`).join(' ');
        const lead = by('lead').map((e) => `${e.step}:${nn(e.note)}/${e.dur}`).join(' ');
        const arp = by('arp').filter((e) => e.tier === 0).map((e) => nn(e.note)).join(' ');
        const kick = by('kick').filter((e) => e.layer === 2 && e.tier === 0).map((e) => e.step).join(',');
        const snare = by('snare').filter((e) => e.layer === 2).map((e) => e.step).join(',');
        out.push(`  bar ${bi} (${b.steps}) chord ${b.chord.join(',')} | pad ${pad} | bass ${bass}`);
        out.push(`        arp ${arp} | lead ${lead} | kick ${kick} snare ${snare} | holds ${b.holds.length} ev ${b.events.length}`);
      });
    });
    console.info(out.join('\n'));
    void MUSIC_LAYERS;
  }
});
