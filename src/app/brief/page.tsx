import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { BriefScreen } from "@/components/brief/BriefScreen";
import {
  SEED_BRIEF,
  SEED_BRIEFED,
  SEED_MESSAGES,
  SEED_PARTICIPANT,
} from "@/components/brief/seed";
import { getOrCreateDefault } from "@/lib/session";
import { displayNamesOf } from "@/lib/types";

export const metadata: Metadata = {
  title: "Brief your agent — twocents.ai",
  description:
    "Tell your agent what you actually want, including the number you would never say in the group chat.",
};

/** The session is per-process and the judges' round rewrites the names in it. */
export const dynamic = "force-dynamic";

/**
 * Step 1. Opens mid-conversation, with Maya's number already locked, so the
 * kept-secret beat is on screen from the first frame.
 *
 * Only the names come from the session; the conversation on screen is still
 * the seeded one.
 */
export default function BriefPage() {
  const session = getOrCreateDefault();

  return (
    <div className="flex min-h-screen flex-col bg-parchment min-[1100px]:h-screen min-[1100px]:overflow-hidden">
      <TopBar step={1} tripName={session.tripName} />
      <BriefScreen
        participantId={SEED_PARTICIPANT}
        briefed={SEED_BRIEFED}
        initialMessages={SEED_MESSAGES}
        initialBrief={SEED_BRIEF}
        names={displayNamesOf(session)}
      />
    </div>
  );
}
