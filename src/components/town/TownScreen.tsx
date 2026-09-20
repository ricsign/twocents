"use client";

/**
 * Step 3, assembled: the room on the left, the record on the right.
 *
 * The negotiation used to start on mount unconditionally, which was right
 * exactly once — the first time anybody reached this screen. Every remount
 * after that, and browser-back from `/plan` is the common one, opened a second
 * stream that overwrote the session's plan, fairness report and private
 * reports with a different outcome; the judge then went forward again and read
 * a plan that no longer matched the one they had just approved.
 *
 * So the run auto-starts only when there is nothing to show. An edit to a brief
 * or a slider already clears the plan, so arriving here after briefing, or
 * after the personality flip, still runs itself — that beat is untouched. What
 * changed is that arriving at a finished run now paints it and stops.
 */

import { useEffect } from "react";
import type { DisplayNames } from "@/lib/characters";
import { PixelLink } from "@/components/ui/PixelButton";
import { useNegotiation, type FinishedRun } from "@/hooks/useNegotiation";
import { Room } from "./Room";
import { TownControls } from "./TownControls";
import { Transcript } from "./Transcript";

export function TownScreen({
  names,
  finished = null,
}: {
  names?: DisplayNames;
  /** The run the session is already holding, narrowed for this viewer. */
  finished?: FinishedRun | null;
}) {
  const negotiation = useNegotiation({ finished });
  const { start, status } = negotiation;

  // Depends on the boolean rather than the object: a server render hands over
  // a new `finished` every time, and re-running this effect on identity alone
  // would restart a stream that is halfway through.
  const alreadyRun = finished !== null;

  useEffect(() => {
    if (alreadyRun) return;
    start();
  }, [alreadyRun, start]);

  const paused = status === "paused";

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-8 px-4 pt-6 pb-8 sm:px-8 min-[1100px]:grid-cols-[minmax(0,1fr)_400px] min-[1100px]:gap-10 min-[1100px]:px-14 min-[1100px]:py-8">
      <div className="relative min-w-0">
        <Room
          currentSpeaker={negotiation.currentSpeaker}
          thinkingSpeaker={negotiation.thinkingSpeaker}
          bubbles={negotiation.bubbles}
          round={negotiation.round}
          roundsTotal={negotiation.roundsTotal}
          elapsedMs={negotiation.elapsedMs}
          live={status === "running"}
          names={names}
        >
          <TownControls
            paused={paused}
            speed={negotiation.speed}
            disabled={status === "idle"}
            onTogglePause={paused ? negotiation.resume : negotiation.pause}
            onSpeed={negotiation.setSpeed}
            onRerun={negotiation.rerun}
            onReset={negotiation.reset}
          />
        </Room>
      </div>

      <div className="flex min-h-[420px] flex-col gap-5 min-[1100px]:min-h-0">
        <Transcript
          turns={negotiation.turns}
          thinkingSpeaker={negotiation.thinkingSpeaker}
          names={names}
        />

        {negotiation.plan ? (
          <PixelLink
            href="/plan"
            variant="primary"
            raised
            className="h-[60px] w-full text-center leading-tight"
          >
            SEE THE PLAN
          </PixelLink>
        ) : null}

        <PixelLink
          href="/judges"
          variant="gold"
          raised
          className="h-[60px] w-full px-2 text-center text-[9px] leading-tight min-[1100px]:text-[10px]"
        >
          JUDGES’ ROUND: BRIEF YOUR OWN AGENTS
        </PixelLink>
      </div>
    </main>
  );
}
