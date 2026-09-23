# RIFTFALL

Sci-Fi-Horror-Wellenshooter für den Browser: Ein interdimensionaler Riss hat eine Forschungsstation überrannt.
Das Spiel läuft komplett im Browser (WebGL2) als statischer Build, ohne Plugin und ohne Download.

> Stand: **Meilenstein 1** – Renderer, Post-FX-Pipeline, Kalibrierungshalle (Testraum) und FPS-Controller mit vollem
> Movement. Details, Architektur und Konventionen stehen in [CLAUDE.md](CLAUDE.md).

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

| Aktion                          | Tastatur/Maus    | Gamepad              |
| ------------------------------- | ---------------- | -------------------- |
| Bewegen                         | W A S D          | linker Stick         |
| Umsehen                         | Maus             | rechter Stick        |
| Springen / Doppelsprung         | Leertaste        | A                    |
| Ducken / Sliden (beim Sprinten) | Strg / C         | B                    |
| Sprinten                        | Shift            | linker Stick drücken |
| Dash                            | Q                | RB                   |
| Zielen (Tiefenschärfe-Test)     | rechte Maustaste | LT                   |
| Pause                           | Esc / P          | Start                |
| Debug-Overlay                   | F3               | –                    |
| Entwickler-Konsole              | ^                | –                    |

Mantling passiert automatisch: gegen eine niedrige Kante springen oder im Sprung nach vorne drücken.

## Entwicklung

```bash
npm run check    # Typecheck + ESLint + Vitest
npm run smoke    # Headless-Chromium-Smoke-Test (nach npm run build)
```

Nützliche Konsolenbefehle (`^`): `help`, `noclip`, `god`, `tp spawn`, `preset ultra`, `hurt 30`, `timescale 0.3`, `stats`.

Credits und Lizenzen: [CREDITS.md](CREDITS.md).
