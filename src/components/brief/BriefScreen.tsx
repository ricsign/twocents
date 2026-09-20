"use client";

import { useState } from "react";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import type { Brief, BriefMessage } from "@/lib/types";
import { PixelButton, PixelLink } from "@/components/ui/PixelButton";
import { AgentKnowsPanel } from "./AgentKnowsPanel";
import { BriefChat, type ChatMessage } from "./BriefChat";
import { BriefedRoster } from "./BriefedRoster";

/** Gives a stored transcript line the key React needs to render it. */
function withIds(messages: readonly BriefMessage[], prefix: string): ChatMessage[] {
  return messages.map((message, index) => ({ ...message, id: `${prefix}-${index}` }));
}

/**
 * The same lines with the key taken back off, ready to post.
 *
 * `id` is this component's own bookkeeping and the only field the route does
 * not want. Everything else goes, `keptPrivate` included: the route stores
 * what it is sent as the whole transcript, so rebuilding each message from
 * `{ role, text }` quietly stripped every badge but the newest one — and a
 * reload then came back to a conversation where the agent never promised to
 * sit on the number, which is the one line the demo is built around.
 * `briefMessageSchema` has carried the field since it was added.
 */
function forWire(messages: readonly ChatMessage[]): BriefMessage[] {
  return messages.map(({ role, text, keptPrivate }) =>
    keptPrivate === undefined ? { role, text } : { role, text, keptPrivate },
  );
}

/**
 * True once this agent has been told anything at all.
 *
 * Two conditions rather than one because the two ways into this screen differ:
 * typing produces human messages, and the one-click sample produces a brief
 * with a destination in it. Either is enough to let the human move on.
 */
function hasBeenBriefed(brief: Brief, messages: readonly ChatMessage[]): boolean {
  return (
    messages.some((message) => message.role === "human") ||
    brief.destinationWant.trim().length > 0
  );
}

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
  sampleBrief,
  names,
}: {
  participantId: ParticipantId;
  briefed: ParticipantId[];
  initialMessages: ChatMessage[];
  initialBrief: Brief;
  /** The one-tap demo shortcut, so a run can skip the typing. */
  sampleBrief: Brief;
  /** Read from the session on the server, so a judges' round renames the room. */
  names?: DisplayNames;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [brief, setBrief] = useState<Brief>(initialBrief);
  const [pending, setPending] = useState(false);

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
          messages: forWire(next),
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

  /**
   * The typing a demo does not have time for.
   *
   * Written straight to the session rather than replayed through `/api/brief`,
   * because the sample is a finished brief: a turn of the chat would re-derive
   * it from a model and could come back with something else.
   */
  async function applySample() {
    if (pending) return;
    setPending(true);
    setBrief(sampleBrief);
    setMessages(withIds(sampleBrief.rawTranscript, "sample"));

    try {
      await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "updateBrief",
          // Writing your own row. The route refuses anything else.
          viewer: participantId,
          participantId,
          brief: sampleBrief,
        }),
      });
    } catch {
      // Rule 2 again: the screen already shows the sample, and the next turn of
      // the chat writes the whole brief anyway.
    } finally {
      setPending(false);
    }
  }

  const ready = hasBeenBriefed(brief, messages);

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-8 px-4 pt-8 pb-10 sm:px-8 min-[1100px]:grid-cols-[minmax(0,1fr)_380px] min-[1100px]:gap-14 min-[1100px]:px-14 min-[1100px]:pt-11 min-[1100px]:pb-12">
      <div className="flex h-[70vh] max-h-[640px] min-h-[420px] flex-col min-[1100px]:h-auto min-[1100px]:max-h-none min-[1100px]:min-h-0">
        <BriefChat
          participantId={participantId}
          messages={messages}
          pending={pending}
          onSend={send}
          names={names}
        />
      </div>

      <div className="flex min-h-0 flex-col gap-8">
        <AgentKnowsPanel brief={brief} />
        <BriefedRoster briefed={briefed} you={participantId} names={names} />

        <div className="mt-auto flex flex-col gap-3">
          <PixelButton
            variant="ghost"
            disabled={pending}
            onClick={() => void applySample()}
            className="h-12 w-full"
          >
            USE THE SAMPLE BRIEF
          </PixelButton>

          {ready ? (
            <PixelLink
              href="/personality"
              variant="primary"
              raised
              className="h-16 w-full"
            >
              NEXT: PERSONALITY
            </PixelLink>
          ) : (
            <>
              {/* A real disabled button rather than a styled link: `.px-press`
                  already dims and blocks one, and the step genuinely cannot be
                  taken yet. */}
              <PixelButton
                variant="primary"
                raised
                disabled
                className="h-16 w-full"
              >
                NEXT: PERSONALITY
              </PixelButton>
              <p className="m-0 text-center text-[13px] font-bold text-bark">
                Tell your agent something first — or use the sample brief.
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
