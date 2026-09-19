import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { PlanScreen } from "@/components/plan/PlanScreen";
import { planViewFor } from "@/components/plan/view";
import { YOU } from "@/lib/characters";
import { getOrCreateDefault } from "@/lib/session";

export const metadata: Metadata = {
  title: "The Plan — twocents.ai",
  description:
    "One trip, what it costs each person, who gave up what, and the private note your agent wrote to you alone.",
};

/** The session store lives in this process, so the page must not be cached. */
export const dynamic = "force-dynamic";

/**
 * Step 4.
 *
 * The session is read here as well as in the browser, for one reason: a reload
 * after the negotiation has run should paint the plan in the first frame. When
 * the run has not happened yet this hands over null and `PlanScreen` goes and
 * makes it happen.
 */
export default function PlanPage() {
  const session = getOrCreateDefault();

  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={4} tripName={session.tripName} />
      <PlanScreen initialView={planViewFor(session, YOU)} />
    </div>
  );
}
