import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TopBar } from "@/components/ui/TopBar";
import { BriefScreen } from "@/components/brief/BriefScreen";
import { chatMessagesFrom } from "@/components/brief/chatMessages";
import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import { hasBriefed } from "@/lib/flow";
import { currentRoom, resolveSession } from "@/lib/room/identity";
import { SAMPLE_BRIEF } from "@/lib/seed";
import { displayNamesOf, type DemoSession } from "@/lib/types";

export const metadata: Metadata = {
  title: "Brief your agent — twocents.ai",
  description:
    "Tell your agent what you actually want, including the number you would never say in the group chat.",
};

/** The session is per-process and the judges' round rewrites the names in it. */
export const dynamic = "force-dynamic";

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

/**
 * Step 1. Opens on whatever this person has already told their agent, which on
 * a fresh session is nothing: one question, an empty panel, and the sample
 * brief a demo can reach for instead of typing.
 *
 * In a room it opens on whatever the group chat said they wanted, with the
 * caveat that we read it rather than heard it — and the first thing they type
 * replaces the guess and clears the caveat.
 */
export default async function BriefPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const { sessionId, seat, url } = await currentRoom(searchParams);
  const session = resolveSession(sessionId);
  // A room that is gone is a dead link, not an empty room: minting one here
  // would answer a stale join URL with four strangers.
  if (!session) notFound();

  const you = session.participants[seat];
  if (!you) notFound();

  return (
    <div className="flex min-h-screen flex-col bg-parchment min-[1100px]:h-screen min-[1100px]:overflow-hidden">
      <TopBar step={1} tripName={session.tripName} />
      <BriefScreen
        participantId={seat}
        sessionId={sessionId}
        url={url}
        briefed={briefedIn(session)}
        initialMessages={chatMessagesFrom(you.brief.rawTranscript)}
        initialBrief={you.brief}
        sampleBrief={SAMPLE_BRIEF}
        names={displayNamesOf(session)}
      />
    </div>
  );
}
