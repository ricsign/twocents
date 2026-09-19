"use client";

/**
 * Step 3, assembled: the room on the left, the record on the right.
 *
 * The negotiation starts on mount because the screen has one job and there is
 * no state in which an empty room is the right thing to show a judge.
 */

import { useEffect } from "react";
import { PixelLink } from "@/components/ui/PixelButton";
import { useNegotiation } from "@/hooks/useNegotiation";
import { Room } from "./Room";
import { TownControls } from "./TownControls";
import { Transcript } from "./Transcript";

export function TownScreen() {
  const negotiation = useNegotiation();
  const { start, status } = negotiation;

  useEffect(() => {
    start();
  }, [start]);

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
        >
          <TownControls
            paused={paused}
            speed={negotiation.speed}
            disabled={status === "idle"}
            onTogglePause={paused ? negotiation.resume : negotiation.pause}
            onSpeed={negotiation.setSpeed}
            onReset={negotiation.reset}
          />
        </Room>
      </div>

      <div className="flex min-h-[420px] flex-col gap-5 min-[1100px]:min-h-0">
        <Transcript
          turns={negotiation.turns}
          thinkingSpeaker={negotiation.thinkingSpeaker}
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
          href="/brief"
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
