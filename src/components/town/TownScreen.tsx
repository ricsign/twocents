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
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { PixelLink } from "@/components/ui/PixelButton";
import { useNegotiation, type FinishedRun } from "@/hooks/useNegotiation";
import { useRoomTurns } from "./useRoomTurns";
import { withIdentity, type UrlIdentity } from "@/lib/room/links";
import { Room } from "./Room";
import { TownControls } from "./TownControls";
import { Transcript } from "./Transcript";

export function TownScreen({
  names,
  sessionId,
  you,
  url,
  canRun = true,
  finished = null,
}: {
  names?: DisplayNames;
  sessionId?: string;
  /** The run the session is already holding, narrowed for this viewer. */
  finished?: FinishedRun | null;
  /** Whose screen this is. Only used to label their own seat in the room. */
  you?: ParticipantId;
  /** Threaded back into this screen's links, so a tab keeps its own identity. */
  url?: UrlIdentity;

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
  const negotiation = useNegotiation({ sessionId, finished });
  const { start, status } = negotiation;

  // Depends on the boolean rather than the object: a server render hands over
  // a new `finished` every time, and re-running this effect on identity alone
  // would restart a stream that is halfway through.
  const alreadyRun = finished !== null;

  useEffect(() => {
    if (alreadyRun || !canRun) return;
    start();
  }, [alreadyRun, canRun, start]);

  // Only polls when this browser is not the one running the stream.
  const watched = useRoomTurns(canRun ? null : (sessionId ?? ""));

  const paused = status === "paused";
  const turns = canRun ? negotiation.turns : watched.turns;
  const hasPlan = canRun ? negotiation.plan !== null : watched.hasPlan;

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-8 px-4 pt-6 pb-8 sm:px-8 min-[1100px]:grid-cols-[minmax(0,1fr)_400px] min-[1100px]:grid-rows-[minmax(0,1fr)] min-[1100px]:gap-10 min-[1100px]:px-14 min-[1100px]:py-8">
      {/* A row that is exactly the viewport's leftover height, not the room's
          natural one: the room reads this box and fits itself to it, and the
          transcript column beside it scrolls inside it instead of running off
          the bottom of a page that cannot scroll. */}
      <div className="relative flex min-h-0 min-w-0">
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
              // Nothing to pause or re-pace before a run starts, and nothing to
              // pause or re-pace on a finished one that was painted rather than
              // streamed. Speed is applied by restarting the stream, which a
              // replayed run has none of, so the buttons dim with the pause.
              disabled={status === "idle" || status === "done"}
              onTogglePause={paused ? negotiation.resume : negotiation.pause}
              onSpeed={negotiation.setSpeed}
              onRerun={negotiation.rerun}
              onReset={negotiation.reset}
            />
          ) : (
            // A spectator has nothing to pause: the pace belongs to the
            // browser running it, and rerun and reset are the host's to press
            // because both throw away what everyone else is watching.
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
            href={withIdentity("/plan", url)}
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
