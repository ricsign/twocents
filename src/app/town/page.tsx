import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/ui/TopBar";
import { TownScreen } from "@/components/town/TownScreen";
import type { FinishedRun } from "@/hooks/useNegotiation";
import { YOU } from "@/lib/characters";
import { hasBriefed } from "@/lib/flow";
import { getOrCreateDefault } from "@/lib/session";
import { displayNamesFromView, sessionViewFor } from "@/lib/session-view";

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
 * Unless it has already run. A finished run is handed to the screen as its
 * opening state so browser-back from `/plan` repaints the transcript that
 * produced that plan instead of streaming a fresh argument over the top of it.
 * Editing a brief or a slider clears the plan, so the auto-run still fires
 * everywhere it used to.
 *
 * The session is read through `sessionViewFor` rather than handed over whole.
 * The town is the one screen where every line in the room is on display, and
 * the narrowing is what keeps the three private reasons behind those lines off
 * this page: `view.turns` carries this viewer's own `privateReasonKept` and
 * strips everybody else's, which is exactly the rule `/api/negotiate` applies
 * frame by frame to the live stream.
 */
export default function TownPage() {
  const session = getOrCreateDefault();
  const view = sessionViewFor(session, YOU);

  // Four agents, one of whom was told nothing, is not a negotiation.
  if (!hasBriefed(view.you.brief)) redirect("/brief");

  const finished: FinishedRun | null = view.plan
    ? { turns: view.turns, plan: view.plan }
    : null;

  return (
    <div className="flex min-h-screen flex-col bg-parchment min-[1100px]:h-screen min-[1100px]:overflow-hidden">
      <TopBar step={3} tripName={view.tripName} />
      <TownScreen names={displayNamesFromView(view)} finished={finished} />
    </div>
  );
}
