# Pride Mascot Assets

Drop lion mascot PNGs here to enable mascot-mode templates in
`pride-themes.ts` (themes with `mascot: true`).

## Where this lives

- **Source**: `src/agents/org/assets/mascots/` (this directory)
- **Built**: `dist/agents/org/assets/mascots/` (copied by `scripts/build-done.mjs`)
- **NOT** in `~/.brigade/workspace/` — that's user state. Brand assets
  belong with the code so `npm install brigade` always ships them.

## Filename conventions

The renderer (`pride-html.ts`) looks for the following by default:

| Filename                    | Used by                                  |
| --------------------------- | ---------------------------------------- |
| `lion-wave.png`             | Default mascot — waving lion             |
| `lion-flex.png`             | Alt mascot — flexing lion                |
| `lion-sit.png`              | Alt mascot — seated lion                 |
| `lion-roar.png`             | Alt mascot — roaring lion                |
| `lion-sleep.png`            | Alt mascot — sleeping lion (for taunts)  |

When a theme has `mascot: true`, the renderer picks one of the
available files (deterministically via the chart's rng seed). If no
PNGs are present, the theme falls back to the lion emoji 🦁.

## Format

- **PNG** with transparent background (so it sits cleanly on any theme bg)
- Roughly square aspect ratio (the renderer crops/scales to fit)
- Recommended size: 512×512 to 1024×1024 (will be downscaled per template)
- Embedded as base64 data URI in the HTML — no network request at render time
