import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { TownScreen } from "@/components/town/TownScreen";

export const metadata: Metadata = {
  title: "The Town — twocents.ai",
  description:
    "Four agents meet around a table and negotiate the trip out loud, without ever repeating what their humans told them in private.",
};

/**
 * Step 3. The negotiation runs itself: the screen opens, the stream opens with
 * it, and the first bubble is up before a judge has finished reading the title.
 */
export default function TownPage() {
  return (
    <div className="flex min-h-screen flex-col bg-parchment min-[1100px]:h-screen min-[1100px]:overflow-hidden">
      <TopBar step={3} />
      <TownScreen />
    </div>
  );
}
