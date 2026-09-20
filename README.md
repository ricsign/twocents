# twocents.ai

Four friends. Four agents. One plan nobody loses on.

Group plans fail because the real constraints never get said out loud. Nobody
types "I can only afford $600" into the group chat. But you will tell your own
agent. twocents.ai gives every person a private agent, sends the four agents
into a pixel room to negotiate, and brings back one plan — with each person's
number still their own.

Four friends, four agents, one plan, zero awkward conversations.

## How it works

Four screens, in order.

1. **Brief** (`/brief`) — you chat privately with your agent. Where you want to
   go, the dates, the real budget, the dealbreakers. This conversation is
   yours; it never leaves your agent's context.
2. **Personality** (`/personality`) — four sliders and a short bio decide how
   your agent argues. Stubborn or easygoing, frugal or splurgy, blunt or
   diplomatic, cautious or adventurous.
3. **The Town** (`/town`) — the four agents walk to a table and negotiate, in
   capped rounds, as speech bubbles and a running transcript. Your agent argues
   your side and never states your number.
4. **The Plan** (`/plan`) — one agreed trip and a runner-up, a fairness meter
   that shows nobody was overruled, the private report your agent wrote to you
   alone, and four approvals.

There is a fifth screen, `/judges`, which is the whole thing in twenty seconds:
name four people, give each a one-line want and a private budget. It makes a
room, the same as a screenshot does — a judge with no group chat to hand still
gets a join link they can pass around.

### Or start from the group chat

`/start` takes the conversation that has been going nowhere. Upload a screenshot
or four, and a vision call reads who is in it and what each of them asked for.
You correct whatever it got wrong, press one button, and get a room code to send
the others. They open the link, answer **"Who are you?"**, and land on the same
briefing screen with their half of the chat already filled in.

No screenshot to hand? The same screen types them in — a name and a line about
what each person wants, on the same review step a reading lands on, because it
is the same four seats going to the same room. A seat left blank is a chair
somebody can still claim. Either way there is no budget field: that number is
the one thing a host must not enter on somebody else's behalf.

**The photo seeds a draft, never a fact.** The schema the model answers against
has no field that can hold a figure — money comes back as one of four words, not
a number — so a screenshot cannot decide somebody else's ceiling even when the
chat contains one. Each person gives their own number to their own agent, on the
one screen that has always been for exactly that.

Nothing about a solo run changed. A browser that has not joined a room is still
Richard, still in the demo session, and still walks the four screens in order.

**The trust model, plainly:** the room code *is* the credential. Anyone with the
link can take any free seat, and the cookie that remembers which seat is not
signed. That is the same trust model `?viewer=` has always had, and about the
right amount of ceremony for a trip with friends — it is not a login.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

**It works with no API key.** With `ANTHROPIC_API_KEY` unset, every model call
is answered by a scripted provider that produces the same event shapes at the
same cadence as a live run: the briefing chat replies, the agents negotiate, a
plan comes out, the private reports are written. Nothing is stubbed out and no
screen shows an error. This is a supported mode, not a degraded one — it is how
the app survives a conference network.

Set `ANTHROPIC_API_KEY` and the agents are live: they write their own lines,
build their own offers and reason about each other's positions. The judges'
round in particular is much better with a key, because a live agent can argue
about the topic a judge actually typed.

### Environment

Every variable is optional. Copy `.env.example` to `.env.local` to set any.

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(unset)* | Makes the agents live. Leave it empty for the scripted run. |
| `TWOCENTS_FORCE_OFFLINE` | *(unset)* | Set to `1` to use the scripted run even when a key is present. Useful for rehearsing the demo. |
| `TWOCENTS_MODEL_FAST` | `claude-haiku-4-5` | The small model. Briefing replies, voice previews, and every negotiation turn. |
| `TWOCENTS_MODEL_SMART` | `claude-sonnet-4-5` | The large model. The final plan and the four private reports, and nothing else. |
| `TWOCENTS_MODEL_VISION` | `claude-opus-5` | The model that reads the group-chat screenshot. One call per room, before the demo clock starts. |
| `TWOCENTS_CHAT_PHOTO_TIMEOUT_MS` | `60000` | Ceiling on that one call. Four screenshots do not fit in the 20s the rest get. |
| `TWOCENTS_LLM_TIMEOUT_MS` | `20000` | Wall-clock ceiling on one model call. A call that runs past it falls back to the scripted answer. Read per call, so a change takes effect without a restart. |
| `TWOCENTS_BEAT_MS` | `1100` | The Town screen's pace at 1x, in milliseconds per spoken line. Lower it for a faster room. |

### Checks

```bash
npx tsc --noEmit
npx eslint src
npm run build
```

## Architecture, in five sentences

Next.js 16 App Router, React 19, TypeScript and Tailwind v4, with no database:
the whole demo is a server-side in-memory session store, so a reset is one map
write and cannot fail on stage. `src/lib/negotiation/engine.ts` runs the round
loop — each agent gets one turn per round, every line is scanned for leaks
before it can be spoken, and convergence on a single offer is computed
arithmetically rather than asked of a model. `/api/negotiate` streams that loop
to the browser as server-sent events and paces it, so the Town screen reads as
a conversation instead of a log dump, and writes the result back to the session
so `/plan` can be opened cold. `src/lib/llm/` puts a live Anthropic provider
and a scripted offline one behind one interface, with a wrapper that degrades
from the first to the second on any failure. `docs/ARCHITECTURE.md` has the
file map, the two hard rules and the event table.

## The privacy design

The claim is that your agent knows your number and nobody else ever does. Three
things hold it up, and all three are code rather than prompt text.

**The Brief/PublicMandate split.** A `Brief` is what you told your agent: the
real ceiling, the private dealbreakers, the notes you would not repeat. A
`PublicMandate` is derived from it and is the only thing a shared prompt ever
sees — the ceiling has become a *stance* ("must be cheap", "flexible") and the
lines you marked `private:` are gone. `src/lib/negotiation/prompts.ts` enforces
this with its signatures: the function that builds an agent's public system
prompt takes a `PublicMandate` and cannot reach a budget, because the argument
it was handed does not have one.

**The redaction guard.** Prompts are advice. `src/lib/negotiation/redaction.ts`
is the guarantee: every generated public line is scanned against that speaker's
own secrets — the figure, its grouped form, its spelled-out form — and a line
that leaks is rejected and re-rolled with a correction. There is no path from a
model response to the wire that skips it, including the retry and the fallback.

**The scoped session API.** The session object holds all four real ceilings, so
handing it out over HTTP would undo the product with one `curl`.
`src/lib/session-view.ts` is the only place a session is narrowed for a human,
and `GET /api/session?viewer=` plus every POST response go through it: you get
your own brief and your own report, and the other three arrive as the same
`PublicMandate` their agents argued from. Writes are scoped the same way — you
may change your own participant and no one else's.

The engine is deliberately outside this: it takes the whole session, because
redaction, fairness scoring and the private reports are all built on it holding
the real briefs. Only the wire narrows.

## Credit

The idea of a little pixel town full of agents who talk to each other comes
from [AI Town](https://github.com/a16z-infra/ai-town) (a16z-infra, MIT). The
framing of an agent as an identity plus a memory of what it was told plus a
reflection step before it speaks comes from Generative Agents (Park et al.,
2023).

This is an original implementation, not a fork of either. No code from either
project is in this repository: the room, the negotiation loop, the redaction
guard, the fairness scoring and the model layer were all written for this app,
and the negotiation is a capped, structured round loop rather than free-roaming
conversation. The debt is to the ideas.
