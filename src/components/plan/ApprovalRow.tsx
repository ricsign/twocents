"use client";

/**
 * Four humans, one tap each. The last thing that happens in the demo.
 *
 * The button owns its own write rather than lifting it to the screen, because
 * the approval is the only piece of state on this page that a person changes:
 * the tap flips it locally and the POST follows, so the button never waits on
 * the network to look pressed. A failed write reverts it — an approve that
 * silently did not land is worse than one that visibly did not.
 */

import { useState } from "react";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { PARTICIPANT_IDS, displayNameFor } from "@/lib/characters";
import { Avatar } from "@/components/ui/Sprite";

export function ApprovalRow({
  you,
  approvals,
  sessionId,
  names,
}: {
  you: ParticipantId;
  /** Who has approved, as the session knows it. */
  approvals: Record<ParticipantId, boolean>;
  sessionId?: string;
  /** What the other three are called. You are always "You". */
  names?: DisplayNames;
}) {
  const [mine, setMine] = useState(approvals[you] ?? false);
  const [failed, setFailed] = useState(false);

  // You sit last, the way the mockup reads: the others, then the gap you fill.
  const order: ParticipantId[] = [
    ...PARTICIPANT_IDS.filter((id) => id !== you),
    you,
  ];
  const allIn = order.every((id) => (id === you ? mine : approvals[id]));

  async function approve(): Promise<void> {
    if (mine) return;
    setMine(true);
    setFailed(false);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          // You approve as yourself: the route rejects any write aimed at
          // another participant, so the two ids are deliberately the same one.
          viewer: you,
          participantId: you,
          ...(sessionId ? { sessionId } : {}),
        }),
      });
      if (!res.ok) throw new Error(`approve responded ${res.status}`);
    } catch {
      setMine(false);
      setFailed(true);
    }
  }

  return (
    <section className="flex flex-col gap-[18px]">
      <ul className="m-0 flex list-none flex-wrap items-end gap-x-6 gap-y-4 p-0">
        {order.map((id) => {
          const isYou = id === you;
          const done = isYou ? mine : (approvals[id] ?? false);
          return (
            <li key={id} className="flex flex-col items-center gap-1.5">
              <Avatar id={id} size={48} names={names} />
              <span
                className={`text-[13px] font-bold ${
                  done ? "text-leaf-deep" : "text-bark"
                }`}
              >
                {isYou
                  ? done
                    ? "You ✓"
                    : "You"
                  : `${displayNameFor(names, id)}${done ? " ✓" : ""}`}
              </span>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={() => void approve()}
        disabled={mine}
        aria-pressed={mine}
        // `px-press` is dropped once approved: its `:disabled` rule dims the
        // button to 45%, and an approval should read as done, not unavailable.
        className={`disp h-16 w-full border-4 border-ink text-[11px] ${
          mine
            ? "translate-x-[4px] translate-y-[4px] cursor-default bg-leaf text-ink px-shadow-sm"
            : "px-press px-shadow cursor-pointer bg-coral text-white"
        }`}
      >
        {mine ? "✓ YOU APPROVED" : "APPROVE THE PLAN"}
      </button>

      <p
        aria-live="polite"
        className={`m-0 text-[13px] font-semibold ${
          failed ? "text-rust" : "text-bark"
        }`}
      >
        {failed
          ? "That didn’t save. Tap it again."
          : allIn
            ? "That’s all four. The trip is the plan now."
            : "Nothing gets booked until all four approve."}
      </p>
    </section>
  );
}
