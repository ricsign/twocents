# The 3-minute demo

One story: four friends, one grad trip, and four agents who sort it out in two
minutes. Everything below is a click, not a slide.

## Before you start

- [ ] `npm run dev`, open `http://localhost:3000`, leave it on `/`.
- [ ] Decide on the key. With `ANTHROPIC_API_KEY` set the agents are live and
      the run takes 60–90 seconds of real model time. With it unset the run is
      scripted, identical every time, and finishes in about two seconds of
      engine time — which is what you want for a rehearsal and a safe fallback,
      but the live run is the one that earns the "agreed in" figure.
- [ ] Hit `/town` once and let a run finish, then press RESET. That warms the
      route, the fonts and the sprites so the first bubble on stage is instant.
- [ ] Press RESET one last time so you go on stage with a briefed-but-
      unnegotiated session: three agents pre-briefed, Maya's transcript empty.
- [ ] Set the speed control to 2x. A full run at 2x is about forty seconds,
      which is the budget the script gives the town.
- [ ] Have the recorded run open in a second tab. You will not need it.
- [ ] Projector check: the room is the left column at 1440x900. If the browser
      is narrow the layout stacks and the town drops below the fold.

## The run sheet

| Time | Beat | What you do | What they see |
|------|------|-------------|---------------|
| 0:00 | The pain | Stay on `/`. Say the line. | "Our grad trip chat ran three weeks and booked nothing, because nobody said what they really wanted." |
| 0:15 | The Briefing | PRESS START → `/brief`. Type Maya's brief live: somewhere warm, **$600 max, don't tell them**, nothing before 8am. Point at the "your agent knows" panel as the budget line lands with a lock on it. | A human telling an agent the thing they would not type in the group chat. |
| 0:35 | The Personality | Next → `/personality`. Drag Maya to diplomatic-but-firm. Read the live voice preview out loud. | The sliders change the sentence under them. The agent is going to sound like her. |
| 0:45 | The Town | Next → `/town`. Say nothing for ten seconds. Then: "Maya's agent is steering away from Cancun. It has never said why, and it never will." | Four characters at a table. Speech bubbles. A transcript filling on the right. |
| 1:30 | The Plan | SEE THE PLAN → `/plan`. Read the fairness meter: "Sam gave up the resort. Nobody was overruled — that is computed, not claimed." Then the private report: "$540 a head, $60 under your number. Nobody heard your number." Tap APPROVE. | One plan, a runner-up, four bars, and a note only Maya can see. |
| 1:50 | The receipts | Point at the run-stats strip under the fairness meter. "Agreed in 1:52, against three weeks in the group chat. Twenty-odd calls on the small model, the plan and the four reports on the large one — the same run on one model costs about forty percent more." | Two numbers, both measured from the run they just watched. |
| 2:00 | The flip | Back to `/personality`, drag Priya from easygoing to stubborn, then `/town` and RESET at 4x. | A different argument and a different plan, from one slider. |
| 2:20 | Judges' round | JUDGES' ROUND on the town screen → `/judges`. Hand over the keyboard. Four names, four one-line wants, four private budgets — or just press START, it is prefilled with a dinner. | Their dinner, argued by four agents, in about forty seconds. |
| 2:50 | The close | "Humans brief. Agents haggle. Humans approve. Nobody has the awkward conversation." | — |

## Notes on the beats

**The kept secret is the demo.** Everything before 0:45 exists so the audience
has seen Maya say "$600, don't tell them" with their own eyes. When her agent
says "Cancun doesn't work for us, how about Puerto Rico?" the room does the
work for you. Do not explain it.

**The flip has to be one slider.** Change exactly one thing and rerun. Two
changes and a judge cannot tell which one mattered.

**The judges' round wants a key.** Offline, the scripted provider replays the
grad-trip lines whatever topic a judge typed, which reads as canned. If you are
running without a key, keep the judges' round short — show the briefing form
and the room filling, and land on the private report rather than the transcript.

**RESET is total.** The button on the town screen and the one on the plan
screen both replace the session object outright: plan, approvals, transcript
and token tally all go, briefs and personalities come back seeded. It takes
about fifteen milliseconds. There is no state a previous judge can leave behind
for the next one.

## If the wifi dies

Nothing happens. The app already runs with no network at all: fonts and sprites
are local, and with no key — or when a call fails, or takes too long — the
model layer falls back to a scripted run that produces the same events at the
same cadence. You lose the live model calls and nothing else.

If you want to guarantee that path rather than discover it, set
`TWOCENTS_FORCE_OFFLINE=1` before the demo and the run is deterministic. Say so
from the stage if the cost strip reads NOT BILLED — it says "offline fallback"
for exactly this reason, and a demo that survives a dead network is a better
story than one that pretends it was online.
