import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { BriefScreen } from "@/components/brief/BriefScreen";
import { chatMessagesFrom } from "@/components/brief/seed";
import { PARTICIPANT_IDS, YOU } from "@/lib/characters";
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
 * Has this person actually told their agent anything?
 *
 * Read off the brief rather than off a list of names, because the roster has to
 * be true for a judges' round and for a run somebody is halfway through, not
 * only for the scripted one. A seeded friend has wants from the first frame; a
 * person who has said nothing yet has none.
 */
function hasBriefed(brief: Brief | undefined): boolean {
  if (!brief) return false;
  return (
    brief.wants.length > 0 ||
    brief.budgetCeiling !== null ||
    brief.destinationWant.trim().length > 0
  );
}

function briefedIn(session: DemoSession): typeof PARTICIPANT_IDS[number][] {
  return PARTICIPANT_IDS.filter(
    (id) => id !== YOU && hasBriefed(session.participants[id]?.brief),
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
export default function BriefPage() {
  const session = getOrCreateDefault();
  const you = session.participants[YOU];

  return (
    <div className="flex min-h-screen flex-col bg-parchment min-[1100px]:h-screen min-[1100px]:overflow-hidden">
      <TopBar step={1} tripName={session.tripName} />
      <BriefScreen
        participantId={YOU}
        briefed={briefedIn(session)}
        initialMessages={chatMessagesFrom(you?.brief.rawTranscript ?? [])}
        initialBrief={you.brief}
        names={displayNamesOf(session)}
      />
    </div>
  );
}
