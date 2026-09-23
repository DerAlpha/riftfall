# RIFTFALL

Sci-Fi-Horror-Wellenshooter für den Browser: Ein interdimensionaler Riss hat eine Forschungsstation überrannt.
Das Spiel läuft komplett im Browser (WebGL2) als statischer Build, ohne Plugin und ohne Download.

> Stand: **Meilenstein 2** – Renderer, Post-FX-Pipeline, Kalibrierungshalle (Testraum), FPS-Controller mit vollem
> Movement und Waffensystem (Pistole, Sturmgewehr, Schrotflinte) mit Viewmodel, Rückstoß, Trefferfeedback, Decals,
> Partikeln und Trainingszielen. Details, Architektur und Konventionen stehen in [CLAUDE.md](CLAUDE.md).

## Schnellstart

```bash
npm install
npm run assets   # optional: CC0-Assets von Poly Haven laden (ohne sie wird prozedural generiert)
npm run dev      # http://localhost:5173
```

Produktions-Build (auf beliebigem Webspace, auch in Unterordnern, deploybar):

```bash
npm run build    # -> dist/
npm run preview
```

## Steuerung (Standard, frei belegbar im Pausenmenü)

| Aktion                          | Tastatur/Maus    | Gamepad               |
| ------------------------------- | ---------------- | --------------------- |
| Bewegen                         | W A S D          | linker Stick          |
| Umsehen                         | Maus             | rechter Stick         |
| Springen / Doppelsprung         | Leertaste        | A                     |
| Ducken / Sliden (beim Sprinten) | C                | B                     |
| Sprinten                        | Shift            | linker Stick drücken  |
| Dash                            | Q                | RB                    |
| Feuern                          | linke Maustaste  | RT                    |
| Zielen (über Kimme und Korn)    | rechte Maustaste | LT                    |
| Nachladen                       | R                | X                     |
| Nahkampf                        | V                | rechter Stick drücken |
| Waffe wechseln                  | 1–4 / Mausrad    | Y                     |
| Waffe inspizieren               | I                | Steuerkreuz rechts    |
| Pause                           | Esc / P          | Start                 |
| Debug-Overlay                   | F3               | –                     |
| Entwickler-Konsole              | ^                | –                     |

Mantling passiert automatisch: gegen eine niedrige Kante springen oder im Sprung nach vorne drücken.

## Entwicklung

```bash
npm run check    # Typecheck + ESLint + Vitest
npm run smoke    # Headless-Chromium-Smoke-Test (nach npm run build)
```

Nützliche Konsolenbefehle (`^`): `help`, `noclip`, `god`, `tp spawn`, `preset ultra`, `hurt 30`, `timescale 0.3`, `stats`,
`give rifle`, `infammo`, `targets`, `explode 4 fire`, `decals`.

Credits und Lizenzen: [CREDITS.md](CREDITS.md).
