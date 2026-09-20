import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { BriefScreen } from "@/components/brief/BriefScreen";
import type { ChatMessage } from "@/components/brief/BriefChat";
import { PARTICIPANT_IDS, YOU, type ParticipantId } from "@/lib/characters";
import { hasBriefed } from "@/lib/flow";
import { SAMPLE_BRIEF } from "@/lib/seed";
import { getOrCreateDefault } from "@/lib/session";
import { displayNamesOf, type Brief, type DemoSession } from "@/lib/types";

export const metadata: Metadata = {
  title: "Brief your agent — twocents.ai",
  description:
    "Tell your agent what you actually want, including the number you would never say in the group chat.",
};

/** The session is per-process and the judges' round rewrites the names in it. */
export const dynamic = "force-dynamic";

/**
 * The first thing the agent says when there is nothing to come back to.
 *
 * Only used on an empty transcript. Once the human has said anything, the
 * stored conversation is what renders, opening line included.
 */
const OPENING_QUESTION =
  "Before I go argue with the others: where do you want to go, when, and what’s the real number?";

/**
 * Who has already talked to their agent, derived rather than listed.
 *
 * A hardcoded roster was right exactly once, at time zero. It said the same
 * three names after the human had briefed their own agent, and it would say
 * them in a judges' round where all four seats were filled at the same moment.
 */
function briefedIn(session: DemoSession): ParticipantId[] {
  return PARTICIPANT_IDS.filter((id) => hasBriefed(session.participants[id].brief));
}

/** The stored conversation, or the one line that starts one. */
function openingMessages(brief: Brief): ChatMessage[] {
  if (brief.rawTranscript.length === 0) {
    return [{ id: "m0", role: "agent", text: OPENING_QUESTION }];
  }
  return brief.rawTranscript.map((message, index) => ({
    ...message,
    id: `stored-${index}`,
  }));
}

/**
 * Step 1. Opens on whatever this person has already told their agent, which on
 * a fresh session is nothing: one question, an empty panel, and the sample
 * brief a demo can reach for instead of typing.
 */
export default function BriefPage() {
  const session = getOrCreateDefault();
  const brief = session.participants[YOU].brief;

  return (
    <div className="flex min-h-screen flex-col bg-parchment min-[1100px]:h-screen min-[1100px]:overflow-hidden">
      <TopBar step={1} tripName={session.tripName} />
      <BriefScreen
        participantId={YOU}
        briefed={briefedIn(session)}
        initialMessages={openingMessages(brief)}
        initialBrief={brief}
        sampleBrief={SAMPLE_BRIEF}
        names={displayNamesOf(session)}
      />
    </div>
  );
}
