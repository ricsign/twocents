# PR #29 — fix: the demo screens fit the window they are shown on

## Summary

On a laptop or a projector — wide and, once the browser's chrome is off it,
not very tall — the town's controls and the brief's step-forward button sat
below the bottom edge of a page that cannot scroll. The only way to reach
them was the browser's zoom control, which is not a thing a judge should
have to discover mid-demo.

Both screens now size themselves to the window they are given.

## What was wrong

Above 1100px `/town` and `/brief` are fixed viewports: `h-screen
overflow-hidden`, the flow of a slide rather than a page. Anything taller
than the window is not scrolled to, it is gone.

- **The town.** The room took the full width of its column and let its
  888x768 ratio choose its height. At a 1200px-wide column that is over
  1000px tall, so on a 1080px screen the room's own bottom corner — pause,
  1x/2x/4x, RUN AGAIN, RESET DEMO — fell off the page, and the grid row it
  inflated pushed SEE THE PLAN and the judges' round off with it.
- **The brief.** The right-hand column stacked "What your agent knows",
  the roster and the CTA at their natural heights; on a 780px-tall window
  that is ~65px more than there is room for, and NEXT: PERSONALITY was the
  part that did not fit.

## What's in it

- **`Room`** — fits the frame to the box it is given rather than to its
  width alone. `useFitScale` measures both axes and takes whichever runs
  out first, and the frame is then sized to exactly `ROOM_W/H × scale`, so
  the room keeps its ratio and centres in whatever space is left over. The
  measurement is a layout effect, so the fitted size is in place before the
  first paint; `null` until then means the server still renders the old
  width-driven box.
- **`TownScreen`** — the desktop grid gets `grid-rows-[minmax(0,1fr)]`, a
  row that is exactly the viewport's leftover height. That is what gives
  the room a height to read, and it stops the transcript column being
  pushed down by its neighbour.
- **`BriefScreen`** — the two panels take the leftover height and scroll
  inside it; the CTA block is pinned below them and is on screen at every
  size.

## The mobile layout is untouched

Below 1100px the page scrolls in one column and the box is as tall as
whatever it contains — which is the room itself. Reading a height there
would be measuring the fit function's own output, so the hook watches
`(min-width: 1100px)` and lets width alone decide below it. The stacked
layout measures the same as before this change.

## Checks

Measured at 1920x940, 1600x820, 1440x780, 1440x620, 1100x700 (the
breakpoint edge), 1000x700 (stacked) and 375x812 (mobile): no page
overflow above the breakpoint, no interactive element outside the
viewport, and the room's aspect ratio holds at 1.156 throughout. `tsc`
and `eslint` clean.
