import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { TownScreen } from "@/components/town/TownScreen";
import { getOrCreateDefault } from "@/lib/session";
import { displayNamesOf } from "@/lib/types";

export const metadata: Metadata = {
  title: "The Town — twocents.ai",
  description:
    "Four agents meet around a table and negotiate the trip out loud, without ever repeating what their humans told them in private.",
};

/**
 * The session lives in this process and the judges' round rewrites it, so the
 * name tags have to be read per request rather than baked at build time.
 */
export const dynamic = "force-dynamic";

/**
 * Step 3. The negotiation runs itself: the screen opens, the stream opens with
 * it, and the first bubble is up before a judge has finished reading the title.
 *
 * Only the names are read from the session here — no brief, no ceiling. The
 * stream carries everything else.
 */
export default function TownPage() {
  const session = getOrCreateDefault();

  return (
    <div className="flex min-h-screen flex-col bg-parchment min-[1100px]:h-screen min-[1100px]:overflow-hidden">
      <TopBar step={3} tripName={session.tripName} />
      <TownScreen names={displayNamesOf(session)} />
    </div>
  );
}
