import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { PersonalityScreen } from "@/components/personality/PersonalityScreen";
import { YOU } from "@/lib/characters";
import { SEED_PERSONALITIES } from "@/lib/seed";
import { getOrCreateDefault } from "@/lib/session";
import { displayNamesOf } from "@/lib/types";

export const metadata: Metadata = {
  title: "Pick your agent’s personality — twocents.ai",
  description:
    "Four sliders and a line about you decide how hard your agent fights in the room, and how it sounds doing it.",
};

/**
 * Step 2. Opens on the line from `design/02-personality.clean.html` so the
 * first frame is the designed one; the moment a slider moves, the screen
 * writes its own.
 */
const OPENING_LINE =
  "Cancun’s a stretch for us. Puerto Rico has the same beaches, and I’ll fight you for the catamaran day.";

/** The session is per-process and the judges' round rewrites the names in it. */
export const dynamic = "force-dynamic";

export default function PersonalityPage() {
  const session = getOrCreateDefault();

  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={2} tripName={session.tripName} />
      <PersonalityScreen
        participantId={YOU}
        initialPersonality={SEED_PERSONALITIES[YOU]}
        initialLine={OPENING_LINE}
        names={displayNamesOf(session)}
      />
    </div>
  );
}
