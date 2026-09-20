# The 3-minute demo

One story: four friends, one grad trip, and four agents who sort it out in two
minutes. Everything below is a click, not a slide.

## Before you start

- [ ] `npm run dev`, open `http://localhost:3000`, leave it on `/`.
- [ ] Decide on the key. With `ANTHROPIC_API_KEY` set the agents are live and
      the run takes 60–90 seconds of real model time. With it unset the run is
      offline: deterministic, identical every time, and finished in about two
      seconds of engine time — which is what you want for a rehearsal and a safe
      fallback, but the live run is the one that earns the "agreed in" figure.
      Offline, the grad trip plays the scripted lines the mockups were built
      around, and any *other* session — the judges' round included — is
      generated from the briefs it was actually given.
- [ ] Warm the run up. `/brief` → **USE THE SAMPLE BRIEF** → `/personality` →
      `/town`, and let a run finish. That warms the route, the fonts and the
      sprites so the first bubble on stage is instant. `/personality` and
      `/town` both bounce back to `/brief` while the seat is empty, which is
      why the sample brief comes first.
- [ ] Press **RESET DEMO** on the town screen. It reseeds the session and puts
      you on `/brief`, which is where a fresh seed belongs: three agents
      pre-briefed, Will's seat empty again, and no run started — a room whose
      fourth agent has been told nothing has nothing to argue. RESET DEMO is
      the one that reseeds; RUN AGAIN beside it keeps the room and argues it
      out a second time. Navigate back to `/` and you are on stage.
- [ ] Know where the speed control lives. It starts at 1x every time the town
      screen is opened — it is stream state, not session state — so 2x is
      something you tap during the run at 0:45, not something you set now. A
      full run at 2x is about forty seconds, which is the budget the script
      gives the town. On a run that was painted from the session rather than
      streamed, pause and the speed buttons are both dimmed: there is no
      stream behind them.
- [ ] Have the recorded run open in a second tab. You will not need it.
- [ ] Projector check: the room is the left column at 1440x900. If the browser
      is narrow the layout stacks and the town drops below the fold.

## The run sheet

| Time | Beat | What you do | What they see |
|------|------|-------------|---------------|
| 0:00 | The pain | Stay on `/`. Say the line, then let them read the four cards for two seconds. | "Our grad trip chat ran three weeks and booked nothing, because nobody said what they really wanted." Under the sprites: which one is you, that the other three are already briefed, and the four steps by name. |
| 0:15 | The Briefing | PRESS START → `/brief`. Type Will's brief live: somewhere warm, **$600 max, don't tell them**, nothing before 8am. Point at the "your agent knows" panel as the budget line lands with a lock on it. | A human telling an agent the thing they would not type in the group chat. |
| 0:35 | The Personality | Next → `/personality`. Read the opening preview line first — it is already arguing Will's brief against Richard's Cancun — then drag to diplomatic-but-firm and read it again. | The sliders change the sentence under them. The agent is going to sound like him. |
| 0:45 | The Town | Next → `/town`. Tap **2x** as the first bubble lands — it restarts the stream, which at that point is one line. Then say nothing for ten seconds: "Will's agent is steering away from Cancun. It has never said why, and it never will." | Four characters at a table. Speech bubbles. A transcript filling on the right. |
| 1:30 | The Plan | SEE THE PLAN → `/plan`. Read the fairness meter: "Richard gave up the resort. Nobody was overruled — that is computed, not claimed." Then the private report: "$540 a head, $60 under your number. Nobody heard your number." Tap APPROVE. | One plan, a runner-up, four bars, and a note only Will can see. |
| 1:50 | The receipts | Point at the run-stats strip under the fairness meter. "Agreed in 1:52, against three weeks in the group chat. Twenty-odd calls on the small model, the plan and the four reports on the large one — the same run on one model costs about forty percent more." | Two numbers, both measured from the run they just watched. |
| 2:00 | The flip | Back to `/personality` — the step-2 pip in the top bar is a link — drag Will from easygoing to stubborn, then press **SEND MY AGENT TO THE TOWN**. Tap 4x. | A different argument and a different plan, from one slider. Moving the slider cleared the old plan, so the town runs itself the moment you arrive; the only button you press is the one that took you there. |
| 2:20 | Judges' round | JUDGES' ROUND — the gold button is on the town screen and on the plan screen → `/judges`. Hand over the keyboard. Four names, four one-line wants, four private budgets — or just press START, it is prefilled with a dinner. Works with or without a key. | Their dinner, argued by four agents, in about forty seconds. |
| 2:50 | The close | "Humans brief. Agents haggle. Humans approve. Nobody has the awkward conversation." | — |

## Notes on the beats

**The kept secret is the demo.** Everything before 0:45 exists so the audience
has seen Will say "$600, don't tell them" with their own eyes. When his agent
says "Cancun doesn't work for us, how about Puerto Rico?" the room does the
work for you. Do not explain it.

**The flip has to be one slider.** Change exactly one thing and rerun. Two
changes and a judge cannot tell which one mattered.

**Leave `/personality` by its own button.** SEND MY AGENT TO THE TOWN waits for
the slider to be saved before it navigates, and the save is what clears the
finished plan. The step-3 pip in the top bar is an ordinary link: press it
inside half a second of moving a slider and the town can be rendered from a
session that has not been told about the move yet, which paints the previous
run. The write still lands — RUN AGAIN then shows the flip — but on stage you
want the button.

**The judges' round works without a key.** Offline the agents argue about the
topic the judge actually typed: the scripted grad-trip lines are reserved for
the seeded session, and anything else is generated from that room's own names,
wants and private ceilings. Type "Dinner tonight" with no key and four agents
argue about dinner — the person with the most room opens with the expensive
place, the person with the tightest budget pushes back without ever saying why,
somebody trades for the one thing they came for, and the plan lands under the
lowest ceiling in the room.

Two things to know before you lean on it. The generated room is a fallback, not
the product: it picks between a handful of options per topic kind (a trip, a
meal, a night out, or a generic version of anything else), so a judge who types
something exotic gets the generic one arguing sensibly rather than a bespoke
scenario. And the plan header prints "1 nights" for a dinner, because the offer
card has a nights field and an evening does not. With a key, neither applies.

What does not change offline is the part being judged: no generated line states
anybody's ceiling — the prices the agents quote are chosen to sit clear of every
number in the room before they are ever said — and the fairness meter is still
computed from the real briefs, so it names whoever conceded.

**RUN AGAIN and RESET DEMO are different buttons.** RUN AGAIN argues the same
room out a second time: every brief and every slider survives, only the
transcript and the plan are replaced. RESET DEMO is total — it replaces the
session object outright, so plan, approvals, transcript and token tally all go
and the briefs and personalities come back seeded, Will's empty. It takes about
fifteen milliseconds, and it is what guarantees no state a previous judge left
behind reaches the next one. Reach for it between judges and never during the
flip: reseeding would throw the slider you just moved away with everything
else.

RESET DEMO also **leaves the town** and starts nothing. A seeded session is one
where the fourth agent has been told nothing, and `/town` and `/personality`
both send an empty seat back to `/brief` — so a reset that stayed put and
opened a fresh stream was arguing out a room the screen it ran on was already
being bounced off. It lands you on step 1, which is the beat the demo restarts
from anyway. The plan screen's **RESET FOR THE NEXT JUDGE** is the same act
pointed at the other entrance: it clears the session and drops you on
`/judges`, where four empty seats and a START button are exactly what a cleared
session is for.

**Two screens cannot argue the same room at once.** `/plan` runs the
negotiation itself when it is opened cold, and `/town` starts one whenever the
session has no plan, so tapping the step-3 pip while the plan screen is still
working used to open two runs writing over each other. `/api/negotiate` now
allows one per session and refuses the second; whichever screen loses waits for
the other's result and paints that. Nothing to do from the stage — it just
means the two screens cannot disagree about what was agreed.

**Going back does not re-argue the room.** The town screen only starts a run
when the session has no plan. Browser-back from `/plan`, or the step-3 pip in
the top bar, repaints the transcript that produced the plan you just showed
rather than streaming a different outcome over the top of it. The green pips
are links to every step already completed, and `/plan` carries its own way back
to the town and into the judges' round.

## If the wifi dies

Nothing happens. The app already runs with no network at all: fonts and sprites
are local, and with no key — or when a call fails, or takes too long — the
model layer falls back to a scripted run that produces the same events at the
same cadence. You lose the live model calls and nothing else.

If you want to guarantee that path rather than discover it, set
`TWOCENTS_FORCE_OFFLINE=1` before the demo and the run is deterministic — for
the seeded trip *and* for whatever a judge types. Say so
from the stage if the cost strip reads NOT BILLED — it says "offline fallback"
for exactly this reason, and a demo that survives a dead network is a better
story than one that pretends it was online.
