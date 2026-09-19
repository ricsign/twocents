# PR #1 — feat: scaffold the app and lift the design system out of the mockups

## Summary

Stands up the Next.js 16 / React 19 / TypeScript / Tailwind v4 application and
translates the four HackMIT mockups into a reusable design system, so every
later feature is assembled from primitives rather than re-deriving pixel
values from the mockup HTML.

## What's in it

- **Repo + toolchain.** Next 16 App Router, TS strict, Tailwind v4,
  ESLint, `@anthropic-ai/sdk` and `zod`.
- **Design tokens** (`src/app/globals.css`). The mockups' palette is now a
  Tailwind `@theme` block: `ink`, `parchment`, `card`, `gold`, `coral`,
  `leaf`, `sky`, `plum`, `bark`, `wood`. Three font families wired through
  `next/font/google` — Nunito for prose, Press Start 2P for the `.disp`
  micro-labels, Pixelify Sans for `.head` headings.
- **Pixel primitives.** `px-frame` (the hard 4px outline), `px-shadow` (the
  6px offset drop-shadow), `px-press` (shadow collapses on click), `.seg`
  (fairness segment), and the `bob` / `blink` / `talk` / `pop` keyframes,
  all suppressed under `prefers-reduced-motion`.
- **Components.** `TopBar` with the four-step pip row, `PixelButton` /
  `PixelLink`, `Avatar` / `CharacterSprite` / `Scenery`, and `CoinIcon` /
  `LockIcon` / `CheckIcon` drawn as 8x8 SVG rect grids.
- **Sprites.** The character sheets, portraits and scenery were extracted
  from the mockup bundle into `public/sprites/` with real names. Character
  sheets are 16x48 — three stacked 16x16 frames that `.talk` steps through.
- **Characters** (`src/lib/characters.ts`). The four friends, their accent
  colours and sprite paths, as the single source of truth.
- **Title screen** at `/` and a `/brief` placeholder.
- **Docs.** `docs/DESIGN.md` (token and rule reference) and
  `docs/ARCHITECTURE.md` (module map, the two hard rules, the SSE event
  contract).

## Notes

The mockups render at a fixed 1440x900. The components are built fluid, with
the mockup proportions as the target at that width.

## Verification

`npx tsc --noEmit` clean.
