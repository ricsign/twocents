# PR #28 — fix(negotiate): a lease outliving its run deadlocked the plan

## The bug

Walk from the town to the plan while the agents are still talking — which a
presenter does — and `/plan` sat on "THE AGENTS ARE STILL TALKING…" and never
recovered. Observed: `POST /api/negotiate → 409`, then ninety one-second polls
of a session whose `turns` stayed at `0`.

Two halves.

**The lease.** PR #26 gave each session one run at a time, released in a
`finally` at the end of the stream's `start`. That covers a run that finishes,
throws, or notices `signal.aborted` between frames. It does not cover a client
that navigates away while the generator is suspended inside a model call: the
stream is dropped, `start` never resumes, and the lease sits there for its full
180 seconds. The run was gone and its lease was all that survived it.

**The wait.** A 409 tells the plan screen that somebody else's run is writing
the plan it wants, so it stops asking and watches the session. That is right
while the other run is alive and wrong the moment it is not, and the screen had
no way to tell the difference.

## The fix

The lease is released from an `abort` listener as well as from the `finally`,
so it is a property of the request rather than of the code path that ends it.
`releaseRun` only drops an entry that is still its own, so releasing twice is
releasing once.

And a refusal is no longer the end of the conversation: when `runHeadless` was
turned away and the poll then produced nothing, the screen asks once more. By
then the abandoned run's lease is gone and the route answers.

## Verification

Reproduced against the running dev server — navigate away from `/town`
mid-negotiation, land on `/plan`, watch it hang. After the change the same walk
produces a finished plan: Cancun at $1,150, the runner-up and its reason, four
fairness rows and a real cost figure.
