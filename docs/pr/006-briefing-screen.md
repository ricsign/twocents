# PR #6 — feat: the private briefing screen

## Summary

Screen 1 of 4. A person tells their own agent what they actually want,
including the number they would never put in the group chat, and the agent
acknowledges it without repeating it. This is the beat the whole demo turns on.

## What's in it

- **`src/app/api/brief/route.ts`** — takes the conversation, returns the
  agent's reply, the updated structured `Brief`, and a `keptPrivate` label.
- **`src/components/brief/BriefChat.tsx`** — the chat card: bottom-aligned
  message log, the three blinking squares while the agent thinks, Enter to
  send, optimistic append, auto-scroll.
- **`src/components/brief/AgentKnowsPanel.tsx`** — Destination, Dates, the
  dark **Real budget** row with its lock and "Never said out loud.", and
  Dealbreaker.
- **`src/components/brief/BriefedRoster.tsx`** — the four portraits, ticks for
  the briefed, "You" for Maya.
- **`src/components/brief/BriefScreen.tsx`** — owns the shared brief state so
  `page.tsx` can stay a server component, and swallows a failed request into
  the scripted reply rather than showing the room an error.

## One detail worth keeping

The "Kept private: $600 budget" badge is derived from `secretsFromBrief()`,
not from the sentence the model wrote. The badge and the redactor therefore
read the same source and cannot disagree about what is being held — which
matters, because the badge is the demo's visible proof of the invariant.

## Deviations from the mockup

- The typing indicator is state-driven rather than always-on as in the static
  mockup, and its fixed `38px` width becomes `w-fit` — the mockup is
  content-box, Tailwind is border-box, and 38px would crush the dots.
- Below 1100px the columns stack and the chat log scrolls internally instead
  of growing the page.

## Verification

`tsc --noEmit` and `eslint` clean. Rendered markup diffed against
`design/01-brief.clean.html` section by section: header copy, `PRIVATE`, all
four seeded messages, `Kept private: $600 budget`, the four panel rows,
`Never said out loud.`, `3 OF 4 BRIEFED`, the roster and `NEXT: PERSONALITY`
all match in order.
