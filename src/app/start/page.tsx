import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { StartScreen } from "@/components/start/StartScreen";

export const metadata: Metadata = {
  title: "Start from the group chat — twocents.ai",
  description:
    "Upload the chat that has been going nowhere. We work out who is in it and what each of them asked for, and hand everyone their own agent.",
};

/**
 * Step zero, and still step one on the top bar.
 *
 * `/judges` already set the precedent: a side entrance reuses `step={1}` with
 * its own trip name rather than growing a fifth pip, because a fifth pip would
 * change the header on every other screen to announce a step most runs skip.
 *
 * Static — nothing here reads the session or a cookie. The room does not exist
 * yet; making one is what this screen is for.
 */
export default function StartPage() {
  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={1} tripName="The group chat" />
      <StartScreen />
    </div>
  );
}
