# twocents.ai — design reference

Everything here is lifted from the HackMIT mockups in `design/*.clean.html`.
Those four files are the source of truth for layout; this doc is the shorthand.

## Screens

| # | Route | File | What it is |
|---|-------|------|------------|
| 1 | `/brief` | `design/01-brief.clean.html` | Private briefing chat + "your agent knows" panel |
| 2 | `/personality` | `design/02-personality.clean.html` | Four sliders, presets, bio, live voice preview |
| 3 | `/town` | `design/03-town.clean.html` | Pixel room, four agents negotiating, transcript |
| 4 | `/plan` | `design/04-plan.clean.html` | Agreed plan, fairness meter, private report, approvals |

Every screen is `1440x900` in the mockup: a 60px dark `TopBar`, then a
two-column grid with `56px` side padding. Build them fluid (the grid's left
column is `minmax(0,1fr)`), but the mockup proportions are the target at
1440px wide.

## Colour tokens

Defined in `src/app/globals.css` under `@theme`, so Tailwind exposes them as
`bg-ink`, `text-bark`, `border-coral`, etc.

| Token | Hex | Used for |
|-------|-----|----------|
| `ink` | `#2B1E14` | All borders, the top bar, primary text |
| `ink-soft` | `#5A4634` | Inactive step pips |
| `parchment` | `#F4E9D0` | Page background |
| `card` | `#FFF9EC` | Panels, offer cards, secondary buttons |
| `paper` | `#FFFFFF` | Speech bubbles, inputs, agent messages |
| `gold` | `#F2B84B` | Accent on dark, current step, logo |
| `gold-deep` | `#B07A1B` | Coin shading |
| `coral` | `#E2593F` | Primary action, "you" messages, Richard |
| `rust` / `rust-deep` | `#B8432B` / `#8F3220` | Links, "pushes back" label |
| `leaf` / `leaf-deep` | `#5C9E4A` / `#3D7A34` | Done pips, checks, Will |
| `sky` | `#3B82C4` | Focus rings, Angela |
| `plum` | `#8B5CC7` | Tsai |
| `bark` | `#7A5A3A` | Muted labels and captions |
| `sand` / `cream-dim` | `#B9A98B` / `#E9DCC0` | Muted text on dark |
| `wood` / `wood-deep` / `wall` | `#B5804A` / `#8A5A32` / `#D9B98C` | The room |
| `track` | `#E5D6B4` | Slider track |

## Type

Three families, loaded in `src/app/layout.tsx` via `next/font/google`:

- **Nunito** — body. Weight 600 is the default; 700 for emphasis. This is
  everything that is a sentence.
- **Press Start 2P** — class `.disp`. ALL CAPS micro-labels and buttons only,
  sizes 7–12px. Never for a sentence.
- **Pixelify Sans** — class `.head`. Headings, names, numbers. Sizes 18–88px.

## Rules that make it look right

- **No rounded corners anywhere.** `border-radius: 0` is enforced globally on
  buttons and inputs.
- **Borders are 3px**, or 4px on the outermost frame of a panel and on
  step-advancing buttons.
- **Primary buttons carry `px-shadow`** — a hard `6px 6px 0 0 ink` offset, no
  blur. `px-press` collapses it on click.
- **Sprites are `image-rendering: pixelated`**, always drawn at an integer
  multiple of 16px (48, 64, 96, 112, 224).
- **Speech bubbles** are white, 3px ink border, with a hand-built tail: a
  20x11 div with left/right/bottom borders, positioned `bottom: -14px`.
- **Shadows on scenery** are flat `rgba(43,30,20,0.28)` rectangles, not blurs.

## Sprites (`public/sprites/`)

| File | Source size | Draw at | What |
|------|-------------|---------|------|
| `{maya,jordan,sam,priya}.png` | 16x16 | 28–64px | Portrait for transcript rows and rosters |
| `{maya,jordan,sam,priya}-sheet.png` | 16x48 | 112px (bg-size `112px 336px`) | Three stacked frames; `.talk` steps through them |
| `table.png` | 48x16 | 336x112 | The negotiating table |
| `window.png` | 32x16 | 192x96 | Wall window |
| `plant.png` | 16x16 | 112x112 | Corner plant |

Use `<CharacterSprite>` / `<Avatar>` / `<Scenery>` from
`src/components/ui/Sprite.tsx` rather than raw `<img>`.

## Animations

All defined in `globals.css` and disabled under `prefers-reduced-motion`.

- `.bob` / `.bob-tall` — idle float, 1.6s
- `.blink` — typing dots and the recording light
- `.talk` — sprite frame cycle while an agent speaks, `steps(3)`
- `.pop` — a speech bubble appearing

## Copy voice

Short, concrete, no marketing. "Argues for you. Never repeats you."
"Kept private: $600 budget." "Nobody overruled." Numbers are specific.
The em-dash-free, plain register of the mockups is deliberate — match it.
