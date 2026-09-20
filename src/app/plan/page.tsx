import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { PlanScreen } from "@/components/plan/PlanScreen";
import { planViewFor } from "@/components/plan/view";
import { notFound } from "next/navigation";
import { currentRoom, resolveSession } from "@/lib/room/identity";

export const metadata: Metadata = {
  title: "The Plan — twocents.ai",
  description:
    "One trip, what it costs each person, who gave up what, and the private note your agent wrote to you alone.",
};

/** The session store lives in this process, so the page must not be cached. */
export const dynamic = "force-dynamic";

/**
 * Step 4.
 *
 * The session is read here as well as in the browser, for one reason: a reload
 * after the negotiation has run should paint the plan in the first frame. When
 * the run has not happened yet this hands over null and `PlanScreen` goes and
 * makes it happen.
 */
export default async function PlanPage() {
  const { sessionId, seat } = await currentRoom();
  const session = resolveSession(sessionId);
  // A room that is gone is a dead link, not an empty room.
  if (!session) notFound();

  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={4} tripName={session.tripName} />
      <PlanScreen
        initialView={planViewFor(session, seat)}
        sessionId={sessionId}
        // Only the host may kick off a headless run, and only before one has
        // started: four people landing here early would otherwise each start
        // their own negotiation on the same session.
        canRun={
          (session.hostSeat === null || session.hostSeat === seat) &&
          session.runStartedAt === null
        }
      />
    </div>
  );
}
