# PR #8 — feat: the personality screen

## Summary

Screen 2 of 4. Four sliders and a one-line bio decide how your agent argues
for you. The demo's "personality flip" beat lives here: drag one slider, the
sample line changes, rerun, and the negotiation lands somewhere else. That is
what tells a judge the agents aren't scripted, so the slider has to answer
instantly.

## What's in it

- `src/app/api/voice/route.ts` — a sample line for the current sliders.
- `src/components/personality/sampleLine.ts` — the pure local generator.
- `SliderRow`, `PresetRow`, `PersonalityStage`, and `PersonalityScreen` which
  owns the state.
- `useDebouncedEffect` — debounce with skip-first and abort-on-change.

## The instant/debounced split

Every change runs through one `apply()` that sets the sliders and the sample
line in the same event handler. No effect, no network: the sentence changes in
the same frame as the thumb. 350ms after the drag stops, `/api/voice` upgrades
the line; 500ms after, `/api/session` persists. Both skip the first render, so
an untouched screen makes no calls, and both abort in flight when the sliders
move again, so a stale answer can never overwrite a newer position.

`sampleLine` reads the same `PERSONALITY_THRESHOLDS` that `describePersonality`
feeds into the real prompt, so the preview and the agent's actual instructions
cannot drift apart. It ignores `bio`, so the line doesn't thrash while someone
is typing.

## One privacy note

The voice route is sent the personality and nothing else. The brief never
enters that prompt, so a ceiling cannot leak into a preview line — it was
never there to leak.

## Verification

`tsc`, `eslint` and `next build` clean. Six distinct lines across slider
extremes; bulldog at 88/60/85/70 gives *"If we're spending this, we're
spending it on the catamaran day. I'm not moving on that."* against
easygoing-splurgy's *"Whatever the group lands on works for me."*
`aria-valuetext` reads in words ("strongly frugal"), not numbers. Single
column below 1100px, no horizontal scroll at 390px.
