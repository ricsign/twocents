"use client";

import { useState } from "react";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import type { Brief } from "@/lib/types";
import { PixelLink } from "@/components/ui/PixelButton";
import { AgentKnowsPanel } from "./AgentKnowsPanel";
import { BriefChat } from "./BriefChat";
import { BriefedRoster } from "./BriefedRoster";
import { chatMessagesFrom, type ChatMessage } from "./seed";

/**
 * Holds the one piece of state both columns need: the brief, which the chat
 * writes and the panel reads. A client boundary rather than two islands,
 * because the panel filling in as you talk is half of what sells the screen.
 */
export function BriefScreen({
  participantId,
  briefed,
  initialMessages,
  initialBrief,
  names,
}: {
  participantId: ParticipantId;
  briefed: ParticipantId[];
  initialMessages: ChatMessage[];
  initialBrief: Brief;
  /** Read from the session on the server, so a judges' round renames the room. */
  names?: DisplayNames;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [brief, setBrief] = useState<Brief>(initialBrief);
  const [pending, setPending] = useState(false);

  /**
   * Forget this conversation and go back to the agent's opening question.
   *
   * The screen clears first and the write follows, for the same reason the
   * approve button does it in that order: the tap is the thing the person is
   * watching. The empty brief is written out here rather than imported from
   * `lib/seed`, which would pull the whole seeded grad trip into the browser
   * bundle to copy ten empty fields; `blankBrief` there is the server's copy of
   * the same shape and `briefSchema` is what keeps them honest.
   */
  async function startOver(): Promise<void> {
    if (pending) return;
    setMessages(chatMessagesFrom([]));
    setBrief({
      participantId,
      destinationWant: "",
      dates: "",
      nights: null,
      budgetCeiling: null,
      budgetIsPrivate: true,
      dealbreakers: [],
      wants: [],
      notes: [],
      rawTranscript: [],
    });
    try {
      await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "clearBrief",
          viewer: participantId,
          participantId,
        }),
      });
    } catch {
      // The screen is already clear and the next turn writes the whole brief
      // anyway, so a failed clear costs nothing a person can see.
    }
  }

  async function send(text: string) {
    const mine: ChatMessage = { id: `h-${Date.now()}`, role: "human", text };
    const next = [...messages, mine];
    setMessages(next);
    setPending(true);

    try {
      const res = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participantId,
          messages: next.map(({ role, text: t }) => ({ role, text: t })),
          brief,
        }),
      });
      if (!res.ok) throw new Error(`brief failed: ${res.status}`);

      const data = (await res.json()) as {
        reply: string;
        brief: Brief;
        keptPrivate: string | null;
      };
      setBrief(data.brief);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "agent",
          text: data.reply,
          ...(data.keptPrivate ? { keptPrivate: data.keptPrivate } : {}),
        },
      ]);
    } catch {
      // Rule 2: the room never sees an error state. The agent says something
      // true instead, and the panel keeps whatever it already had.
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "agent",
          text: "Got it, and it stays with me. Set how I should sound and I’ll go in.",
        },
      ]);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-8 px-4 pt-8 pb-10 sm:px-8 min-[1100px]:grid-cols-[minmax(0,1fr)_380px] min-[1100px]:gap-14 min-[1100px]:px-14 min-[1100px]:pt-11 min-[1100px]:pb-12">
      <div className="flex h-[70vh] max-h-[640px] min-h-[420px] flex-col min-[1100px]:h-auto min-[1100px]:max-h-none min-[1100px]:min-h-0">
        <BriefChat
          participantId={participantId}
          messages={messages}
          pending={pending}
          onSend={send}
          onStartOver={() => void startOver()}
          names={names}
        />
      </div>

      <div className="flex min-h-0 flex-col gap-8">
        <AgentKnowsPanel brief={brief} />
        <BriefedRoster briefed={briefed} you={participantId} names={names} />
        <PixelLink
          href="/personality"
          variant="primary"
          raised
          className="mt-auto h-16 w-full"
        >
          NEXT: PERSONALITY
        </PixelLink>
      </div>
    </main>
  );
}
