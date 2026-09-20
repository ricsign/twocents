import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/ui/TopBar";
import { LobbyScreen } from "@/components/lobby/LobbyScreen";
import { currentRoom, resolveSession } from "@/lib/room/identity";
import { sessionViewFor } from "@/lib/session-view";

export const metadata: Metadata = {
  title: "The room — twocents.ai",
  description: "Who has joined, who has briefed their agent, and the link to send the rest.",
};

/** Reads a cookie and a live session, so it can never be cached. */
export const dynamic = "force-dynamic";

/**
 * Between joining and briefing: the only screen that shows the room as a room.
 *
 * Reached only with a claim. A browser that has not joined anything has no
 * lobby to be in — it is in a solo run, where the four screens go in order and
 * there is nobody to wait for — so it is sent to the start of that instead of
 * shown an empty room.
 */
export default async function LobbyPage() {
  const { sessionId, seat, joined } = await currentRoom();
  if (!joined) redirect("/start");

  const session = resolveSession(sessionId);
  // The room expired underneath a cookie that outlived it.
  if (!session) redirect("/start");

  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={1} tripName={session.tripName} />
      <LobbyScreen initialView={sessionViewFor(session, seat)} code={session.id} />
    </div>
  );
}
