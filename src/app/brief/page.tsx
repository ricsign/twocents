import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TopBar } from "@/components/ui/TopBar";
import { BriefScreen } from "@/components/brief/BriefScreen";
import { chatMessagesFrom } from "@/components/brief/seed";
import { PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";
import { currentRoom, resolveSession } from "@/lib/room/identity";
import { displayNamesOf, hasBriefed, type DemoSession } from "@/lib/types";

export const metadata: Metadata = {
  title: "Brief your agent — twocents.ai",
  description:
    "Tell your agent what you actually want, including the number you would never say in the group chat.",
};

/** The session is per-process and the judges' round rewrites the names in it. */
export const dynamic = "force-dynamic";

function briefedIn(session: DemoSession, seat: ParticipantId): ParticipantId[] {
  return PARTICIPANT_IDS.filter(
    (id) => id !== seat && hasBriefed(session.participants[id]?.brief),
  );
}

/**
 * Step 1: your agent, asking you what you want.
 *
 * Everything on screen comes from the session, so the conversation, the panel
 * beside it and the roster underneath all survive a reload, a navigation to
 * step 2 and back, and a restarted server. On a fresh session the transcript is
 * empty and `chatMessagesFrom` supplies the agent's opening question; the
 * scripted mid-conversation open is `TWOCENTS_SEED_BRIEF_CHAT=1`.
 */
export default async function BriefPage() {
  const { sessionId, seat } = await currentRoom();
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
        briefed={briefedIn(session, seat)}
        initialMessages={chatMessagesFrom(you.brief.rawTranscript)}
        initialBrief={you.brief}
        names={displayNamesOf(session)}
      />
    </div>
  );
}
