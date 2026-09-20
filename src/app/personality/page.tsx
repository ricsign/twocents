import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { PersonalityScreen } from "@/components/personality/PersonalityScreen";
import { notFound } from "next/navigation";
import { currentRoom, resolveSession } from "@/lib/room/identity";
import { displayNamesOf } from "@/lib/types";

export const metadata: Metadata = {
  title: "Pick your agent’s personality — twocents.ai",
  description:
    "Four sliders and a line about you decide how firmly your agent holds your side in the room, and how it sounds doing it.",
};

/**
 * Step 2. Opens on the line from `design/02-personality.clean.html` so the
 * first frame is the designed one; the moment a slider moves, the screen
 * writes its own.
 */
const OPENING_LINE =
  "Cancun’s a stretch for us. Puerto Rico has the same beaches, and I’d like to keep the catamaran day if we can.";

/** The session is per-process and the judges' round rewrites the names in it. */
export const dynamic = "force-dynamic";

/**
 * The sliders come from the session, not from the seed, so coming back to this
 * screen — after step 3, after a reload, after a restarted server — shows the
 * agent the person actually built. `PersonalityScreen` saves every change to
 * the same place half a second after the hand stops.
 */
export default async function PersonalityPage() {
  const { sessionId, seat } = await currentRoom();
  const session = resolveSession(sessionId);
  // A room that is gone is a dead link, not an empty room.
  if (!session) notFound();
  const you = session.participants[seat];
  if (!you) notFound();

  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={2} tripName={session.tripName} />
      <PersonalityScreen
        participantId={seat}
        sessionId={sessionId}
        initialPersonality={you.personality}
        initialLine={OPENING_LINE}
        names={displayNamesOf(session)}
      />
    </div>
  );
}
