# PR #15 — fix: narrow the negotiation stream to one viewer

## The leak

The SSE `done` event carried all four `AgentReport`s, each with its
`secretsKept` list — literally `"$600 budget"` and the private notes behind
it. Anyone watching `/api/negotiate` got all four people's secrets. `speak`
events carried `privateReasonKept` for every speaker, which names the real
reason a line was said.

Neither page rendered it, because both read the narrowed session view. But
"the UI doesn't happen to show it" is exactly the reasoning PR #11 rejected,
and the stream had simply been missed.

## The fix

`eventForViewer(event, viewerId)` sits directly beside `sessionViewFor` in
`session-view.ts`, so both narrowings are in one file and a reviewer sees them
together:

| event | narrowing |
|---|---|
| `done` | `reports` reduced to the viewer's own |
| `speak` | `privateReasonKept` dropped unless the viewer is the speaker |
| `round`, `thinking`, `offer`, `agreed` | returned by reference, provably unchanged |

`stripPrivateReason` is now generic over `{ privateReasonKept?: string }`, so
the stored turn and the live frame go through one function rather than two
ideas of what "public" means.

As in PR #11, the engine keeps emitting everything and the store keeps
recording everything — the narrowing is at the boundary. The existing
"don't starve the engine" comment was extended rather than duplicated.

## One schema change, forced

`done.reports` was `z.record(participantIdSchema, agentReportSchema)`, which in
Zod 4 is exhaustive: a one-report frame would have failed validation in
`useNegotiation` and been **silently dropped**. It is now `z.partialRecord`,
with a comment saying why.

## Verification

```
GET /api/negotiate?viewer=maya   600 -> 3 (hers)  900 -> 0  1400 -> 0  800 -> 0
GET /api/negotiate?viewer=sam    600 -> 0  900 -> 0  1400 -> 1 (his)  800 -> 0
?viewer=nobody                   400
```

Every frame from all three captures re-validated against the exact schema the
Town screen uses — 0 rejected. `session-view.check` grows from 21 to **35
assertions**, run for two viewers, asserting against the serialized wire form
and using `deepEqual` on the four public frame types so the narrowing cannot
quietly mangle them.
