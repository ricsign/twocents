"use client";

/**
 * The waiting room: who has arrived, who has briefed, and the link to send.
 *
 * It polls `GET /api/session` rather than opening anything, and it polls the
 * *existing* endpoint rather than a leaner one built for it. `session-view.ts`
 * makes the argument in its own header — a second, parallel idea of "what you
 * may see" is one more place a reviewer has to check before they know what a
 * browser can learn — and the payload is a few kilobytes at half a request per
 * second per phone, which is nothing on one Node process.
 *
 * What it draws is public by observation: who is sitting down, and whether
 * they have said anything to their agent yet. Never a word of what they said.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PARTICIPANT_IDS } from "@/lib/characters";
import { sessionViewSchema, type SessionView } from "@/lib/session-view";
import { Avatar } from "@/components/ui/Sprite";
import { PixelButton, PixelLink } from "@/components/ui/PixelButton";
import { CheckIcon } from "@/components/ui/PixelIcons";

/** Four phones at 0.5rps is nothing, and it reads as live. */
const POLL_MS = 2000;

export function LobbyScreen({
  initialView,
  code,
}: {
  initialView: SessionView;
  code: string;
}) {
  const router = useRouter();
  const [view, setView] = useState<SessionView>(initialView);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;

    async function poll(): Promise<void> {
      try {
        const response = await fetch("/api/session", { cache: "no-store" });
        if (response.ok) {
          const parsed = sessionViewSchema.safeParse(await response.json());
          if (parsed.success && !stopped) setView(parsed.data);
        }
      } catch {
        // A dropped poll is a missed beat. Every read is of the whole view, so
        // the next one catches up on its own.
      } finally {
        // A phone in a pocket should not keep asking.
        if (!stopped) {
          timer = window.setTimeout(
            () => void poll(),
            document.visibilityState === "hidden" ? POLL_MS * 4 : POLL_MS,
          );
        }
      }
    }

    timer = window.setTimeout(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  /**
   * The host started it. Everybody follows.
   *
   * This is the whole four-phone coordination story: one timestamp in the
   * session, seen by three polls, and three browsers navigate themselves.
   */
  useEffect(() => {
    if (view.runStartedAt !== null) router.push("/town");
  }, [router, view.runStartedAt]);

  const seats = PARTICIPANT_IDS.map((id) => {
    if (id === view.viewerId) {
      return {
        id,
        name: view.you.name,
        claimed: view.you.claimed,
        briefed: view.you.briefed,
        mine: true,
      };
    }
    const other = view.others.find((entry) => entry.participantId === id);
    return {
      id,
      name: other?.name ?? id,
      claimed: other?.claimed ?? false,
      briefed: other?.briefed ?? false,
      mine: false,
    };
  });

  // Nobody waits on an empty chair: a seat with no human in it is played by
  // the app and is ready by definition.
  const waitingOn = seats.filter((seat) => seat.claimed && !seat.briefed);
  const ready = waitingOn.length === 0 && view.you.briefed;

  async function copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/join/${code}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused. The code is on screen in 40px type,
      // which is the fallback and arguably the better one across a table.
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-8 px-4 pt-10 pb-12 sm:px-8">
      <header className="flex flex-col gap-3">
        <h1 className="head m-0 text-[40px] leading-none font-bold text-ink">
          {view.tripName}
        </h1>
        <p className="m-0 text-[15px] leading-relaxed text-bark">
          Everyone opens the same link and picks themselves. Then each of you tells your
          own agent the thing you would not type in the chat.
        </p>
      </header>

      <section className="flex flex-col gap-3 border-[3px] border-ink bg-card p-5">
        <span className="disp text-[7px] text-bark">SEND THEM THIS</span>
        <p className="head m-0 text-[40px] leading-none font-bold tracking-[0.12em] text-ink">
          {code}
        </p>
        <PixelButton variant="dark" onClick={() => void copyLink()} className="h-11 px-4">
          {copied ? "LINK COPIED" : "COPY THE LINK"}
        </PixelButton>
      </section>

      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {seats.map((seat) => (
          <li
            key={seat.id}
            className="flex items-center gap-4 border-[3px] border-ink bg-card p-4"
          >
            <Avatar id={seat.id} size={44} className="shrink-0" names={{ [seat.id]: seat.name }} />
            <span className="flex min-w-0 flex-col">
              <span className="text-[17px] font-bold text-ink">
                {seat.name}
                {seat.mine ? " (you)" : ""}
              </span>
              <span className="text-[13px] leading-snug text-bark">
                {!seat.claimed
                  ? "empty seat — their agent runs on what the chat said"
                  : seat.briefed
                    ? "briefed their agent"
                    : "joined, still talking to their agent"}
              </span>
            </span>
            {seat.briefed ? (
              <span className="ml-auto shrink-0">
                <CheckIcon size={16} />
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {!view.you.briefed ? (
        <PixelLink href="/brief" variant="primary" raised className="h-16 w-full text-[11px]">
          BRIEF YOUR AGENT →
        </PixelLink>
      ) : view.you.isHost ? (
        <>
          <PixelLink
            href="/town"
            variant={ready ? "primary" : "ghost"}
            raised
            className="h-16 w-full text-[11px]"
          >
            {ready ? "SEND THEM IN →" : "START ANYWAY →"}
          </PixelLink>
          {!ready ? (
            <p className="disp m-0 text-center text-[7px] leading-relaxed text-bark">
              STILL BRIEFING: {waitingOn.map((seat) => seat.name.toUpperCase()).join(", ")}
            </p>
          ) : null}
        </>
      ) : (
        <p className="disp m-0 border-[3px] border-ink bg-paper p-4 text-center text-[8px] leading-relaxed text-bark">
          {ready
            ? "EVERYONE IS READY. WAITING FOR THE HOST TO START."
            : "WAITING FOR THE OTHERS TO BRIEF THEIR AGENTS."}
        </p>
      )}

      <PixelLink href="/personality" variant="ghost" className="h-11 px-4 text-[9px]">
        CHANGE HOW YOUR AGENT SOUNDS
      </PixelLink>
    </main>
  );
}
