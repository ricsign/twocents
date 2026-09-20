"use client";

/**
 * Step 4, assembled: the group's plan on the left, your agent's on the right.
 *
 * The one piece of machinery here is the cold load. `/plan` is a real URL — a
 * judge reloads it, a link gets opened on a second laptop, the dev server
 * restarts between the town screen and this one — and in every one of those
 * cases the session comes back with `plan: null`. An empty state would be the
 * worst possible thing to show at the 1:30 beat of the demo, so instead the
 * screen runs the negotiation itself: it POSTs `/api/negotiate` at the highest
 * speed the route accepts and drains the stream without rendering a frame of
 * it. The route persists the plan, the fairness report and the private reports
 * to the session as they land, and this screen reads the session while that is
 * happening — so it paints at the moment the room settles rather than at the
 * end of the stream, and renders exactly as if the town had been watched. The
 * town screen is the cinema; this is the same run, fast-forwarded with the
 * lights off.
 *
 * `initialView` is the same narrowing done on the server, so a reload after a
 * finished run paints the plan in the first frame instead of flashing a
 * loading line at a judge. It is null exactly when the cold path has work.
 *
 * The cold path can also lose the race. `/api/negotiate` allows one run per
 * session and answers 409 to the second, so a judge who taps the step-3 pip
 * while this screen is still draining gets the town's run instead of a second
 * one writing over it. That refusal is not an error here: the run that won is
 * writing the plan this screen is waiting for, so the screen stops asking and
 * watches the session until it lands.
 *
 * The plan arrives before the private report does. The engine announces the
 * agreement the instant the room settles and writes the reports afterwards, so
 * a session can hold a plan and a fairness meter with `report: null` for the
 * length of four model calls. The screen renders on what it has and keeps
 * reading the session until the report lands — the same poll the cold path
 * uses, carried one step further.
 *
 * The two links at the bottom are the way out. This was the end of a one-way
 * flow: approve, and then nothing, with the browser's back button the only
 * exit and a re-running town screen on the other side of it. Back to the town
 * now repaints the run that produced this plan, and the judges' round is one
 * tap from the screen a judge is looking at when you offer them a turn.
 */

import { useCallback, useEffect, useState } from "react";
import { PixelLink } from "@/components/ui/PixelButton";
import { YOU } from "@/lib/characters";
import { sessionViewSchema } from "@/lib/session-view";
import { planViewFrom, type PlanView } from "./view";
import { AgentReportCard, AgentReportPending } from "./AgentReportCard";
import { ApprovalRow } from "./ApprovalRow";
import { FairnessMeter } from "./FairnessMeter";
import { PlanHeadline } from "./PlanHeadline";
import { RunStats } from "./RunStats";

/** Fast-forward for the headless run. `/api/negotiate` clamps speed at 8x. */
const HEADLESS_SPEED = 8;

/** The route's answer when another screen already has this session's run. */
const ALREADY_RUNNING = 409;

/**
 * How long to watch the session for somebody else's run to land.
 *
 * Generous on purpose: the run that beat us to it may be the town's, played at
 * 1x for an audience, which is half a minute of screen time before the `done`
 * frame is written.
 */
const POLL_MS = 1000;
const POLL_TRIES = 90;

type Status = "loading" | "negotiating" | "ready" | "error";

/**
 * Your view of the session. Null while the agents are still out.
 *
 * The route narrows before it answers — the response carries your brief and
 * your report and nobody else's — so this is a reshaping, not a redaction.
 */
async function loadView(): Promise<PlanView | null> {
  const res = await fetch(`/api/session?viewer=${YOU}`, { cache: "no-store" });
  if (!res.ok) return null;
  const parsed = sessionViewSchema.safeParse((await res.json()) as unknown);
  return parsed.success ? planViewFrom(parsed.data) : null;
}

/** Resolves after `ms`, or at once if the caller has already given up. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Reads the session until it holds a plan, and then until that plan has your
 * report, handing over whatever it has as soon as it has it.
 *
 * One loop rather than two, because it is one wait seen twice: the plan is
 * written the moment the room settles and the report several model calls
 * later. Publishing on the way past is what lets the screen paint the plan at
 * the first instant it exists and fill the right-hand card in behind it.
 *
 * The first read happens immediately, so the ordinary path — our own headless
 * run, already finished and written — costs exactly one request.
 *
 * Resolves to whether a plan was ever seen. The report is best-effort: a run
 * that never writes one leaves that card in its in-progress state rather than
 * failing a screen that has the plan on it.
 */
async function pollForPlan(
  signal: AbortSignal,
  publish: (view: PlanView) => void,
): Promise<boolean> {
  let seen = false;
  for (let attempt = 0; attempt < POLL_TRIES; attempt += 1) {
    const view = await loadView();
    if (signal.aborted) return seen;
    if (view) {
      publish(view);
      seen = true;
      if (view.report) return true;
    }
    await sleep(POLL_MS, signal);
    if (signal.aborted) return seen;
  }
  return seen;
}

/**
 * Runs the negotiation with nothing on screen, then resolves.
 *
 * A 409 means another screen already holds this session's run. Resolving
 * rather than throwing hands the caller straight to `waitForPlan`, which is
 * what it would do with our own run anyway.
 */
async function runHeadless(signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/negotiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speed: HEADLESS_SPEED }),
    signal,
  });
  if (res.status === ALREADY_RUNNING) return;
  if (!res.ok || !res.body) throw new Error(`negotiate responded ${res.status}`);

  // Every frame is discarded: the route writes the result to the session, and
  // the session is what this screen reads. Draining to the end is how we know
  // the `done` frame has been written.
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}

export function PlanScreen({
  initialView = null,
}: {
  initialView?: PlanView | null;
}) {
  const [view, setView] = useState<PlanView | null>(initialView);
  const [status, setStatus] = useState<Status>(initialView ? "ready" : "loading");

  const publish = useCallback((next: PlanView): void => {
    setView(next);
    setStatus("ready");
  }, []);

  const bootstrap = useCallback(async (signal: AbortSignal): Promise<void> => {
    const existing = await loadView();
    if (signal.aborted) return;
    if (existing) {
      publish(existing);
      // A plan with no report yet is a run still writing one. Keep reading.
      if (!existing.report) await pollForPlan(signal, publish);
      return;
    }

    setStatus("negotiating");

    // Drained and watched at the same time, rather than read once the stream
    // has ended. The route writes the plan to the session the instant the room
    // settles and the reports several model calls later, so a screen that
    // waits for the end of the stream waits for the write-up it could have
    // rendered without. `allSettled` because the two are independent: a run
    // that fails after the plan landed leaves a usable screen, and one that
    // fails before it falls through to the throw below.
    const settled = await Promise.allSettled([
      runHeadless(signal),
      pollForPlan(signal, publish),
    ]);
    if (signal.aborted) return;

    const poll = settled[1];
    if (poll.status === "rejected" || !poll.value) {
      throw new Error("the negotiation produced no plan");
    }
  }, [publish]);

  useEffect(() => {
    // Nothing to fetch when the server already handed over a finished plan.
    // A plan without a report is not finished: the run is still writing it,
    // and the poll below is what fills the card in.
    if (initialView?.report) return;
    const controller = new AbortController();
    // Everything below the first await, so no render is triggered from the
    // effect body itself.
    void (async () => {
      try {
        await bootstrap(controller.signal);
      } catch {
        if (!controller.signal.aborted) setStatus("error");
      }
    })();
    return () => controller.abort();
  }, [bootstrap, initialView]);

  if (!view) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="disp m-0 text-center text-[12px] leading-relaxed text-bark">
          {status === "error"
            ? "THE ROOM WENT QUIET. RELOAD TO RUN IT AGAIN."
            : "THE AGENTS ARE STILL TALKING…"}
        </p>
      </main>
    );
  }

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-10 px-4 pt-8 pb-10 sm:px-8 min-[1100px]:grid-cols-[minmax(0,1fr)_440px] min-[1100px]:gap-16 min-[1100px]:px-14 min-[1100px]:py-12">
      <div className="flex min-w-0 flex-col gap-9">
        <PlanHeadline plan={view.plan} fairness={view.fairness} />
        <div className="mt-auto flex flex-col gap-6 pt-2">
          <FairnessMeter fairness={view.fairness} names={view.names} />
          <RunStats
            usage={view.usage}
            agreedInMs={view.plan.agreedInMs}
            sessionId={view.sessionId}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-8">
        {view.report ? (
          <AgentReportCard report={view.report} you={YOU} names={view.names} />
        ) : (
          <AgentReportPending you={YOU} names={view.names} />
        )}
        <div className="mt-auto flex flex-col gap-5 pt-2">
          <ApprovalRow
            you={YOU}
            approvals={view.approvals}
            sessionId={view.sessionId}
            names={view.names}
          />
          <div className="flex flex-wrap gap-3">
            <PixelLink
              href="/town"
              variant="ghost"
              className="h-12 flex-1 px-4 text-center text-[9px] leading-tight"
            >
              ← BACK TO THE TOWN
            </PixelLink>
            <PixelLink
              href="/judges"
              variant="gold"
              className="h-12 flex-1 px-4 text-center text-[9px] leading-tight"
            >
              JUDGES’ ROUND
            </PixelLink>
          </div>
        </div>
      </div>
    </main>
  );
}
