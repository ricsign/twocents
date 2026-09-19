import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { BriefScreen } from "@/components/brief/BriefScreen";
import {
  SEED_BRIEF,
  SEED_BRIEFED,
  SEED_MESSAGES,
  SEED_PARTICIPANT,
} from "@/components/brief/seed";

export const metadata: Metadata = {
  title: "Brief your agent — twocents.ai",
  description:
    "Tell your agent what you actually want, including the number you would never say in the group chat.",
};

/**
 * Step 1. Opens mid-conversation, with Maya's number already locked, so the
 * kept-secret beat is on screen from the first frame.
 */
export default function BriefPage() {
  return (
    <div className="flex min-h-screen flex-col bg-parchment min-[1100px]:h-screen min-[1100px]:overflow-hidden">
      <TopBar step={1} />
      <BriefScreen
        participantId={SEED_PARTICIPANT}
        briefed={SEED_BRIEFED}
        initialMessages={SEED_MESSAGES}
        initialBrief={SEED_BRIEF}
      />
    </div>
  );
}
