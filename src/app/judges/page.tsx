import type { Metadata } from "next";
import { TopBar } from "@/components/ui/TopBar";
import { JudgesScreen } from "@/components/judges/JudgesScreen";

export const metadata: Metadata = {
  title: "Judges’ round — twocents.ai",
  description:
    "Brief four agents for your own dinner in twenty seconds, then watch them negotiate it.",
};

/**
 * The judges' round.
 *
 * Deliberately outside the four-step flow: it is not step 5, it is step 1
 * again with somebody else's dinner in it. The top bar still shows step 1 so
 * the pips stay honest about where this lands — briefing agents — and the trip
 * name reads as the round rather than as the seeded grad trip.
 */
export default function JudgesPage() {
  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={1} tripName="Judges’ round" />
      <JudgesScreen />
    </div>
  );
}
