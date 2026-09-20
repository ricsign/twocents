import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { ItineraryScreen } from "@/components/itinerary/ItineraryScreen";
import { notFound } from "next/navigation";
import { currentRoom, resolveSession } from "@/lib/room/identity";

export const metadata: Metadata = {
  title: "The Itinerary — twocents.ai",
  description:
    "The agreed trip, day by day, with what each day costs and a real link for every booking.",
};

/** The session store lives in this process, so the page must not be cached. */
export const dynamic = "force-dynamic";

/**
 * The tail of step 4 rather than a step of its own.
 *
 * The top bar shows four pips because the demo has four beats, and this page is
 * what step 4 turns into once all four people have approved — not a fifth thing
 * to get through. Adding a fifth pip would change every screen's header to
 * announce a step that only exists after the demo is already over.
 */
export default async function ItineraryPage() {
  const { sessionId } = await currentRoom();
  const session = resolveSession(sessionId);
  // A room that is gone is a dead link, not an empty room.
  if (!session) notFound();

  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={4} tripName={session.tripName} />
      <ItineraryScreen sessionId={sessionId} />
    </div>
  );
}
