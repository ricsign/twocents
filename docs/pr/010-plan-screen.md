# PR #10 — feat: the Plan screen

## Summary

Screen 4 of 4. The agents have agreed: one plan, what it costs each person,
who gave up what, and — privately, to you alone — what your agent got you and
what it traded away. Then four humans approve.

## What's in it

- `PlanHeadline` — the destination at `clamp(40px, 7.4vw, 88px)`, the dark
  price block, the runner-up line and the kept-wants checklist.
- `FairnessMeter` — five fixed segments per person filled in their accent
  colour. Each row is a `role="group"` labelled by its name and caption; the
  segment grid itself is `aria-hidden`, because five coloured boxes mean
  nothing to a screen reader and the caption already says it.
- `AgentReportCard` — the dark private card: GOT YOU, TRADED AWAY, WHY.
- `ApprovalRow` — optimistic approve with revert on failure.
- `PlanScreen` + `view.ts`.

## The cold-load path

Opening `/plan` directly, with no negotiation behind it, used to mean an empty
screen — which is exactly what happens when a judge clicks a link out of
order. It now shows "THE AGENTS ARE STILL TALKING…" and runs the negotiation
headlessly at `speed: 8`, draining the stream and discarding frames; the
endpoint already persists `agreed` and `done`, so reaching the end of the body
is the signal that a finished session is waiting. About two seconds.

## A privacy detail

`page.tsx` is a server component so a warm load paints in the first frame, but
it narrows the session through `planViewFor()` to the plan, the fairness
report, *your* report and the approvals. A screen whose premise is privacy
should not ship all four briefs in its page source. The same helper runs on
both sides, so server and client cannot disagree about what is visible.

## Bug fixed in passing

`FairnessRow.gaveUp` already contains its verb, so the caption was rendering
"gave up gave up the hotel". `captionFor` now only prefixes when the phrase
doesn't already start with it.

## Verification

`tsc`, `eslint`, `next build` clean. Cold `/plan` reaches a rendered plan in
about two seconds. Warm render contains `Puerto Rico`, `$540`, `$2,160`, the
runner-up, all four fairness rows, `Only you can see this` and the report.
Approve returns 200, the session reflects it, and a reload renders
`✓ YOU APPROVED` with `aria-pressed="true"` — label, glyph, colour and press
offset all change, not colour alone.

`600` appears nowhere in the rendered markup.
