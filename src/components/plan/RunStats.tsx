"use client";

/**
 * What the run actually cost, in one strip.
 *
 * Two sponsor stories live here and both of them are numbers, not claims:
 *
 * - **Time.** `Plan.agreedInMs` is wall clock from the first round to the
 *   agreement. It goes next to the three weeks the group chat took, because a
 *   figure with nothing beside it is a figure nobody can read.
 * - **Tokens.** The engine accumulates real input and output counts per call,
 *   and `TIER_FOR_TASK` sends the twenty-odd banter turns to the cheap model
 *   and only the plan and the four private reports to the expensive one. The
 *   comparison figure is that same run priced as if every call had gone to the
 *   large model: identical token counts, one rate card. It is computed from
 *   what the run reported, not written down in advance.
 *
 * When the run was offline — no key, or the network went — there are no tokens
 * to price and the strip says so rather than printing a $0.00 that reads like
 * a claim. The round still happened; it just was not billed. And while the run
 * is still going there is nothing to say either way yet, which is its own
 * state: the plan lands five model calls before the tally does, and a panel
 * that reads an empty tally as "offline" tells a judge there is no key while
 * the run is spending money.
 *
 * Deliberately quiet: three-px border, muted labels, and it sits under the
 * fairness meter. The private report is what a judge should be reading.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PRICING, estimateCost } from "@/lib/llm/provider";
import type { Usage } from "@/lib/types";

/** What a three-week planning thread costs, which is the point of comparison. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used by the temporarily hidden AGREED IN cell
const GROUP_CHAT_BASELINE = "three weeks in the group chat";

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `1:52`. Rounded rather than floored, to match the `AGREED IN` micro-label
 * `PlanHeadline` prints from the same field: two figures for one fact that
 * disagree by a second is the sort of thing a judge notices and nobody can
 * explain from the stage.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used by the temporarily hidden AGREED IN cell
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** `12.4K`. Exact under a thousand, because 840 tokens is a readable number. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used by the temporarily hidden MODEL CALLS cell
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}K`;
}

/**
 * Four decimals, because a whole run of this thing costs cents and `$0.04`
 * throws away the digit the comparison turns on.
 */
function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/* -------------------------------------------------------------------------- */
/* What the strip may claim yet                                                */
/* -------------------------------------------------------------------------- */

/**
 * The three honest things this panel can say about money.
 *
 * `usage` reaches the screen on the run's last frame — the route writes the
 * tally beside the four private reports — while the plan arrives five
 * model calls earlier, the instant the room settles. So an empty tally has
 * two meanings and they are opposites: nothing was billed, or nothing has
 * been counted yet. The panel used to read the first one off both and tell a
 * judge there was no API key while a live run was spending money three feet
 * away.
 *
 * `calls` is what separates them, because a finished run has made at least
 * one call whatever that call cost. `running` is the same window the report
 * card fills with STILL WRITING, and it ends on the same frame.
 */
type CostState = "running" | "offline" | "billed";

function costStateOf(usage: Usage): CostState {
  if (usage.calls === 0) return "running";
  return usage.inputTokens + usage.outputTokens === 0 ? "offline" : "billed";
}

/* -------------------------------------------------------------------------- */
/* Cells                                                                       */
/* -------------------------------------------------------------------------- */

function Cell({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="disp text-[7px] text-bark">{label}</span>
      <span className="head text-[26px] leading-none font-bold text-ink">
        {value}
      </span>
      <span className="text-[12px] leading-snug font-semibold text-bark">
        {note}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The reset affordance                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Clears the session and sends the next judge back to the briefing screen.
 *
 * `POST /api/session {action:"reset"}` replaces the session object outright, so
 * the plan, the four approvals, the transcript and the token tally all go at
 * once. The judge then lands on `/judges`, which is where a cleared session is
 * useful: four empty seats and a START button.
 *
 * `router.refresh()` before the push is not decoration. Every screen here
 * renders the session on the server, so the router's cached payload for the
 * page we are leaving would otherwise still describe the run that just ended.
 * It is the same pair of calls the town's RESET DEMO makes on its way to
 * `/brief` and the judges' START makes on its way to `/town`: clear the
 * session, drop the cache, land somewhere the new session can actually
 * render. Only the destination differs, and it differs because the two resets
 * are pointed at different entrances — this one at the judges' round, the
 * town's at step 1 of the demo.
 */
function ResetRun({ sessionId }: { sessionId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function reset(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reset",
          ...(sessionId ? { sessionId } : {}),
        }),
      });
    } catch {
      // A failed reset still has to land somewhere clean, and `/judges` seeds
      // the session from scratch on START regardless of what is in it now.
    }
    router.refresh();
    router.push("/judges");
  }

  return (
    <button
      type="button"
      onClick={() => void reset()}
      disabled={busy}
      className="disp px-press h-11 shrink-0 cursor-pointer self-center border-[3px] border-ink bg-card px-4 text-[9px] text-ink disabled:opacity-45"
    >
      {busy ? "CLEARING…" : "RESET FOR THE NEXT JUDGE"}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* The strip                                                                   */
/* -------------------------------------------------------------------------- */

export function RunStats({
  usage,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- read by the temporarily hidden AGREED IN cell
  agreedInMs,
  sessionId,
}: {
  usage: Usage;
  /** `Plan.agreedInMs` — real elapsed time of the negotiation. */
  agreedInMs: number;
  sessionId?: string;
}) {
  const state = costStateOf(usage);

  // The honest comparison: this run's own token counts, every call priced at
  // the large model's rate instead of the tier the task was routed to.
  const oneModelCost = estimateCost("smart", usage.inputTokens, usage.outputTokens);
  const saved = oneModelCost - usage.estimatedCostUsd;
  const savedPct =
    oneModelCost > 0 ? Math.round((saved / oneModelCost) * 100) : 0;

  return (
    <section
      aria-label="What this run cost"
      className="flex flex-col gap-4 border-[3px] border-ink bg-card px-5 py-4 min-[1100px]:flex-row min-[1100px]:items-start min-[1100px]:gap-8"
    >
      {/* TEMPORARILY HIDDEN: the AGREED IN and MODEL CALLS cells. The plan
          headline already prints the agreed time, and the call count is not
          what the demo is selling. Restore by uncommenting — `formatDuration`,
          `formatTokens`, `GROUP_CHAT_BASELINE` and the `agreedInMs` prop are
          all still here for it.

      <Cell
        label="AGREED IN"
        value={formatDuration(agreedInMs)}
        note={`against ${GROUP_CHAT_BASELINE}`}
      />

      <Cell
        label="MODEL CALLS"
        value={String(usage.calls)}
        note={
          state === "offline"
            ? "scripted run, nothing sent"
            : `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out`
        }
      />
      */}

      <Cell
        label="COST"
        value={
          state === "running"
            ? "STILL RUNNING"
            : state === "offline"
              ? "NOT BILLED"
              : formatUsd(usage.estimatedCostUsd)
        }
        note={
          state === "running"
            ? "the agents are still working — the bill lands with the last report"
            : state === "offline"
              ? "offline fallback — no key, no tokens, no charge"
              : `one model for every call: ${formatUsd(oneModelCost)}${
                  savedPct > 0 ? ` (${savedPct}% more)` : ""
                }`
        }
      />

      <p className="m-0 max-w-[280px] text-[12px] leading-snug font-semibold text-bark min-[1100px]:ml-auto">
        {state === "running"
          ? "Banter runs on the small model and only the plan and the four private reports run on the large one. The split is priced here as soon as the run finishes."
          : state === "offline"
            ? "Banter runs on the small model and only the plan and the four private reports run on the large one. With a key set, the split is priced here."
            : `Banter on the small model at $${PRICING.fast.inputPerMTok}/$${PRICING.fast.outputPerMTok} per Mtok; the plan and the four reports on the large one at $${PRICING.smart.inputPerMTok}/$${PRICING.smart.outputPerMTok}.`}
      </p>

      <ResetRun sessionId={sessionId} />
    </section>
  );
}
