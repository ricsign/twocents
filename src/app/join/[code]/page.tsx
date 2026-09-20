import type { Metadata } from "next";
import { PARTICIPANT_IDS, displayNameFor } from "@/lib/characters";
import { normalizeRoomCode, resolveSession } from "@/lib/room/identity";
import { displayNamesOf } from "@/lib/types";
import { TopBar } from "@/components/ui/TopBar";
import { PixelLink } from "@/components/ui/PixelButton";
import { SeatPicker, type JoinableSeat } from "@/components/join/SeatPicker";

export const metadata: Metadata = {
  title: "Join the room — twocents.ai",
  description: "Pick who you are, and your agent takes your side.",
};

/** Reads a room out of the URL and this browser's claim out of a cookie. */
export const dynamic = "force-dynamic";

/**
 * The join link, and the app's only dynamic segment.
 *
 * The code is in the path rather than a cookie because this is the one screen
 * reached by somebody who has never been here — there is nothing in their jar
 * to read yet, and the link is the whole invitation. Everything afterwards
 * goes back to the cookie, which is why no other page needs a segment.
 *
 * `params` is a Promise in this version of Next and has to be awaited.
 */
export default async function JoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code: raw } = await params;
  const code = normalizeRoomCode(raw);
  const session = code ? resolveSession(code) : undefined;

  if (!code || !session) {
    return (
      <div className="flex min-h-screen flex-col bg-parchment">
        <TopBar step={1} tripName="Join a room" />
        <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col items-center gap-6 px-6 pt-16 text-center">
          <h1 className="head m-0 text-[32px] leading-tight font-bold text-ink">
            That room is gone
          </h1>
          <p className="m-0 text-[15px] leading-relaxed text-bark">
            Links last as long as the room does. Ask whoever sent it for a new one, or
            start your own from the group chat.
          </p>
          <PixelLink href="/start" variant="primary" raised className="h-14 px-6">
            START A ROOM
          </PixelLink>
        </main>
      </div>
    );
  }

  const names = displayNamesOf(session);
  const seats: JoinableSeat[] = PARTICIPANT_IDS.map((id) => {
    const state = session.participants[id];
    return {
      participantId: id,
      name: displayNameFor(names, id),
      taken: state?.claimedAt != null,
      want: state?.brief.destinationWant ?? "",
    };
  });

  return (
    <div className="flex min-h-screen flex-col bg-parchment">
      <TopBar step={1} tripName={session.tripName} />
      <SeatPicker code={code} tripName={session.tripName} seats={seats} />
    </div>
  );
}
