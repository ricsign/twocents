import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/ui/TopBar";
import { PersonalityScreen } from "@/components/personality/PersonalityScreen";
import { sampleTopicFor } from "@/components/personality/sampleLine";
import { YOU } from "@/lib/characters";
import { hasBriefed } from "@/lib/flow";
import { getOrCreateDefault } from "@/lib/session";
import { displayNamesFromView, sessionViewFor } from "@/lib/session-view";

export const metadata: Metadata = {
  title: "Pick your agent’s personality — twocents.ai",
  description:
    "Four sliders and a line about you decide how hard your agent fights in the room, and how it sounds doing it.",
};

/** The session is per-process and the judges' round rewrites the names in it. */
export const dynamic = "force-dynamic";

/**
 * Step 2.
 *
 * Both of this page's inputs are read out of the session rather than assumed.
 * The sliders used to open on `SEED_PERSONALITIES[YOU]`, so a reload silently
 * reverted whatever the person had set — and worse than reverting, the next
 * nudge wrote that seed back over their real value, because the screen saves
 * the whole personality object on every change. The opening sample line used
 * to be a hardcoded sentence about Cancun, which nobody in the seat had said.
 *
 * Both now come from `sessionViewFor`: the stored personality as-is, and a
 * `SampleTopic` derived from the public mandates the room already exposes. The
 * narrowing is not ceremony here — it is what guarantees the preview is built
 * from the same sanitized view the other agents argue from, so no ceiling can
 * reach the one screen where a human watches words appear.
 *
 * Arriving with nothing briefed is a dead end: four sliders shaping an agent
 * that has been told nothing. That redirects back to step 1.
 */
export default function PersonalityPage() {
  const session = getOrCreateDefault();
  const view = sessionViewFor(session, YOU);

  if (!hasBriefed(view.you.brief)) redirect("/brief");

  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={2} tripName={view.tripName} />
      <PersonalityScreen
        participantId={YOU}
        initialPersonality={view.you.personality}
        topic={sampleTopicFor(view)}
        names={displayNamesFromView(view)}
      />
    </div>
  );
}
