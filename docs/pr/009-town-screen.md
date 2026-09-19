# PR #9 — feat: the Town — four agents negotiating, live

## Summary

Screen 3 of 4, and the twenty seconds the project is remembered for. Four
pixel characters stand around a table and haggle out loud: bubbles pop, the
transcript fills, and a lock marker appears whenever an agent steers the group
without saying why.

## What's in it

- **`src/hooks/useNegotiation.ts`** — owns the SSE connection and derives every
  piece of screen state from the event stream. `fetch` + `ReadableStream`
  rather than `EventSource`, since the endpoint takes a POST body.
- **`Room` / `RoomBackdrop` / `Agent`** — the 888x768 pixel room on a scaled
  inner layer, so sprites stay on integer sizes at any viewport width.
- **`SpeechBubble`** — with the hand-built tail and the "Reason kept private"
  marker.
- **`Transcript`** — the accessible record; offer turns render as cream cards,
  plain turns as quoted lines.
- **`TownControls`** — pause, 1x/2x/4x, RESET.

## Bubble lifetime

A bubble carries an `expiresAt` measured against **a run clock that only
advances while the negotiation is running**, so pausing freezes the bubbles
for free and no timer ever needs rescheduling. A speaker's new line replaces
their own bubble, and at most two are mounted at once — three turns the room
into noise. The four anchors are hard-coded from the mockup, mutually
disjoint, and bottom-anchored so a long line grows upward instead of creeping
down over a face.

## Pause buffering

Wire → queue → pump → React. The reader keeps draining the response body while
paused; the pump returns early, so frames pile up rather than being applied.
Resume releases the backlog one frame every `260/speed` ms, so it replays as a
conversation instead of dumping. When the queue is empty the pump applies
inline, so the server's pacing is the pacing. `[DONE]` is queued as an ordinary
item and can never overtake buffered frames.

## Verification

`tsc`, `eslint` and `next build` clean. The live stream was captured and
replayed through the parser and reducer: 23 frames, 8 turns, 2 offers each
attached to the right turn, 0 orphans, **max 2 bubbles on screen**, 2 private
markers. 1x pacing measures a line every ~1.5s.

**Secret check: no `speak` text in the stream contains `600`, `$600` or `six
hundred`.** The figure exists only in `privateReasonKept`, which the room
renders as the words "Reason kept private" and never as a number.
