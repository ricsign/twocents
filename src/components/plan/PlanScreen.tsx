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
 * to the session as they land, so once the stream ends a second GET returns a
 * finished session and the screen renders exactly as if the town had been
 * watched. The town screen is the cinema; this is the same run, fast-forwarded
 * with the lights off.
 *
 * `initialView` is the same narrowing done on the server, so a reload after a
 * finished run paints the plan in the first frame instead of flashing a
 * loading line at a judge. It is null exactly when the cold path has work.
 */

import { useCallback, useEffect, useState } from "react";
import { YOU } from "@/lib/characters";
import { sessionViewSchema } from "@/lib/session-view";
import { planViewFrom, type PlanView } from "./view";
import { AgentReportCard } from "./AgentReportCard";
import { ApprovalRow } from "./ApprovalRow";
import { FairnessMeter } from "./FairnessMeter";
import { PlanHeadline } from "./PlanHeadline";
import { RunStats } from "./RunStats";

/** Fast-forward for the headless run. `/api/negotiate` clamps speed at 8x. */
const HEADLESS_SPEED = 8;

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

/** Runs the negotiation with nothing on screen, then resolves. */
async function runHeadless(signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/negotiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speed: HEADLESS_SPEED }),
    signal,
  });
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

  const bootstrap = useCallback(async (signal: AbortSignal): Promise<void> => {
    const existing = await loadView();
    if (signal.aborted) return;
    if (existing) {
      setView(existing);
      setStatus("ready");
      return;
    }

    setStatus("negotiating");
    await runHeadless(signal);
    if (signal.aborted) return;

    const finished = await loadView();
    if (signal.aborted) return;
    if (!finished) throw new Error("the negotiation produced no plan");
    setView(finished);
    setStatus("ready");
  }, []);

  useEffect(() => {
    // Nothing to fetch when the server already handed over a finished plan.
    if (initialView) return;
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
        <PlanHeadline plan={view.plan} />
        <div className="mt-auto flex flex-col gap-6 pt-2">
          <FairnessMeter fairness={view.fairness} />
          <RunStats
            usage={view.usage}
            agreedInMs={view.plan.agreedInMs}
            sessionId={view.sessionId}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-8">
        {view.report ? <AgentReportCard report={view.report} you={YOU} /> : null}
        <div className="mt-auto pt-2">
          <ApprovalRow
            you={YOU}
            approvals={view.approvals}
            sessionId={view.sessionId}
          />
        </div>
      </div>
    </main>
  );
}
