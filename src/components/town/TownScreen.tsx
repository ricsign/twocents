"use client";

/**
 * Step 3, assembled: the room on the left, the record on the right.
 *
 * The negotiation starts on mount because the screen has one job and there is
 * no state in which an empty room is the right thing to show a judge.
 */

import { useEffect } from "react";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { PixelLink } from "@/components/ui/PixelButton";
import { useNegotiation } from "@/hooks/useNegotiation";
import { useRoomTurns } from "./useRoomTurns";
import { Room } from "./Room";
import { TownControls } from "./TownControls";
import { Transcript } from "./Transcript";

export function TownScreen({
  names,
  sessionId,
  you,
  canRun = true,
}: {
  names?: DisplayNames;
  sessionId?: string;
  /** Whose screen this is. Only used to label their own seat in the room. */
  you?: ParticipantId;
  /**
   * Whether this browser is the one that runs the negotiation.
   *
   * One run per room, and the host's browser owns it. Four town screens each
   * opening the stream would be four full negotiations over one session —
   * four times the model spend, four pacing loops, and four writes racing to
   * be the transcript that sticks. So the other three watch instead: they poll
   * the session and fill the same transcript a beat behind, which costs them
   * the speech bubbles and nothing else.
   *
   * Defaults true, because a solo run has no host and must not lock the one
   * person present out of their own demo.
   */
  canRun?: boolean;
}) {
  const negotiation = useNegotiation(sessionId);
  const { start, status } = negotiation;

  useEffect(() => {
    if (canRun) start();
  }, [canRun, start]);

  // Only polls when this browser is not the one running the stream.
  const watched = useRoomTurns(canRun ? null : sessionId ?? "");

  const paused = status === "paused";
  const turns = canRun ? negotiation.turns : watched.turns;
  const hasPlan = canRun ? negotiation.plan !== null : watched.hasPlan;

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
          live={canRun ? status === "running" : watched.live}
          names={names}
          you={you}
        >
          {canRun ? (
            <TownControls
              paused={paused}
              speed={negotiation.speed}
              disabled={status === "idle"}
              onTogglePause={paused ? negotiation.resume : negotiation.pause}
              onSpeed={negotiation.setSpeed}
              onReset={negotiation.reset}
            />
          ) : (
            <p className="disp text-[8px] leading-relaxed text-bark">
              {watched.live
                ? "THE AGENTS ARE TALKING…"
                : hasPlan
                  ? "THEY AGREED."
                  : "WAITING FOR THE ROOM TO START…"}
            </p>
          )}
        </Room>
      </div>

      <div className="flex min-h-[420px] flex-col gap-5 min-[1100px]:min-h-0">
        <Transcript
          turns={turns}
          thinkingSpeaker={canRun ? negotiation.thinkingSpeaker : null}
          names={names}
        />

        {hasPlan ? (
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
