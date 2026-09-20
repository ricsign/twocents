"use client";

/**
 * "Who are you?" — four names and a tap.
 *
 * The one screen that exists purely to attach a person to a seat. It is kept
 * to one question on purpose: somebody has just opened a link on their phone,
 * probably while standing up, and the next screen is where they do the actual
 * work.
 *
 * A taken seat is not hidden, it is greyed and labelled, with a way to take it
 * anyway. The failure this is built around is mundane and very likely: the
 * first person taps the wrong name. Without a way back that seat is gone for
 * the life of the room and the person it belonged to has nowhere to sit.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CHARACTERS, type ParticipantId } from "@/lib/characters";
import { Avatar } from "@/components/ui/Sprite";
import { PixelButton } from "@/components/ui/PixelButton";

export interface JoinableSeat {
  participantId: ParticipantId;
  name: string;
  taken: boolean;
  /** What the chat said they wanted, so a name alone is not the only clue. */
  want: string;
}

export function SeatPicker({
  code,
  tripName,
  seats,
}: {
  code: string;
  tripName: string;
  seats: JoinableSeat[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ParticipantId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** The seat we are asking "are you sure" about, after a 409. */
  const [contested, setContested] = useState<ParticipantId | null>(null);

  async function claim(participantId: ParticipantId, force: boolean): Promise<void> {
    if (busy) return;
    setBusy(participantId);
    setProblem(null);
    try {
      const response = await fetch("/api/room/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, participantId, ...(force ? { force: true } : {}) }),
      });

      if (response.status === 409) {
        const data = (await response.json()) as { name?: string };
        setContested(participantId);
        setProblem(`${data.name ?? "Somebody"} is already in that seat.`);
        setBusy(null);
        return;
      }
      if (!response.ok) throw new Error(`claim responded ${response.status}`);

      // `router.refresh()` first: the cookie was set on this response, and the
      // lobby is a server component that reads it.
      router.refresh();
      router.push("/lobby");
    } catch {
      setProblem("Could not join. Try that again.");
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-8 px-4 pt-10 pb-12 sm:px-8">
      <header className="flex flex-col gap-2">
        <p className="disp m-0 text-[8px] text-bark">ROOM {code}</p>
        <h1 className="head m-0 text-[40px] leading-none font-bold text-ink">Who are you?</h1>
        <p className="m-0 text-[15px] leading-relaxed text-bark">
          Pick yourself, and you get an agent that argues {tripName.toLowerCase()} on your
          side. What you tell it stays between the two of you.
        </p>
      </header>

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {seats.map((seat) => {
          const character = CHARACTERS[seat.participantId];
          const disabled = busy !== null;
          return (
            <li key={seat.participantId}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void claim(seat.participantId, false)}
                className={`flex w-full cursor-pointer items-center gap-4 border-[3px] border-ink p-4 text-left ${
                  seat.taken ? "bg-paper opacity-60" : "px-press px-shadow bg-card"
                } ${disabled ? "opacity-60" : ""}`}
              >
                <Avatar
                  id={seat.participantId}
                  size={48}
                  className="shrink-0"
                  names={{ [seat.participantId]: seat.name }}
                />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-[18px] font-bold text-ink" style={{ color: character.color }}>
                    {seat.name}
                  </span>
                  {seat.want ? (
                    <span className="truncate text-[13px] leading-snug text-bark">
                      wanted {seat.want}
                    </span>
                  ) : null}
                </span>
                <span className="disp ml-auto shrink-0 text-[7px] text-bark">
                  {busy === seat.participantId
                    ? "JOINING…"
                    : seat.taken
                      ? "ALREADY JOINED"
                      : "THAT'S ME"}
                </span>
              </button>

              {contested === seat.participantId ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 border-[3px] border-ink bg-paper p-3">
                  <span className="text-[13px] leading-relaxed text-ink">
                    Took it by mistake, or back on a different phone?
                  </span>
                  <PixelButton
                    variant="dark"
                    onClick={() => void claim(seat.participantId, true)}
                    disabled={busy !== null}
                    className="h-9 px-3 text-[8px]"
                  >
                    THAT&rsquo;S ACTUALLY ME
                  </PixelButton>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {problem && contested === null ? (
        <p className="m-0 border-[3px] border-ink bg-paper p-3 text-[14px] leading-relaxed text-ink">
          {problem}
        </p>
      ) : null}
    </main>
  );
}
