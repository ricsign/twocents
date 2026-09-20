"use client";

import { useEffect, useRef, useState } from "react";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { agentName } from "@/lib/characters";
import { Avatar } from "@/components/ui/Sprite";
import { PixelButton } from "@/components/ui/PixelButton";
import { LockIcon } from "@/components/ui/PixelIcons";
import type { BriefMessage } from "@/lib/types";

/**
 * A transcript line plus the one thing React needs that the domain model does
 * not carry: a stable key. Lives here because this is the component that
 * renders one, and `BriefScreen` only holds the list on its behalf.
 */
/**
 * The agent's first line, and the only thing on screen before the person types.
 *
 * It is a question, not a greeting: the screen is one conversation whose job is
 * to get three things out of somebody (where, when, and the number), and an
 * agent that opens with "hello" spends the first turn on nothing. It lives here
 * rather than in `lib/seed` so that reaching for it does not pull the seeded
 * grad trip into the browser bundle.
 */
export const BRIEF_OPENING_LINE =
  "Before I go plan this with the others: where do you want to go, when, and what’s the real number?";

export interface ChatMessage extends BriefMessage {
  id: string;
}

/**
 * The private briefing card: who you are talking to, what you have said so
 * far, and the one input that makes this screen work. Presentational — the
 * conversation itself lives in `BriefScreen`.
 */
export function BriefChat({
  participantId,
  messages,
  pending,
  onSend,
  onStartOver,
  names,
}: {
  participantId: ParticipantId;
  messages: ChatMessage[];
  pending: boolean;
  onSend: (text: string) => void;
  /** Forget this conversation and ask again. Absent means the control is hidden. */
  onStartOver?: () => void;
  /** Who this agent speaks for. The cast name when nobody said otherwise. */
  names?: DisplayNames;
}) {
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // A genuine side effect: the newest line has to be visible, and its height
  // is only known after paint.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, pending]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    setDraft("");
    onSend(text);
  }

  return (
    <section className="px-frame m-1 flex min-h-0 flex-1 flex-col bg-card">
      <ChatHeader
        participantId={participantId}
        names={names}
        // Only once there is something to forget: a fresh screen offering to
        // clear itself is a button that does nothing.
        onStartOver={
          messages.some((message) => message.role === "human") ? onStartOver : undefined
        }
        busy={pending}
      />

      <div
        role="log"
        aria-live="polite"
        aria-label="Briefing conversation"
        className="pixel-scroll flex min-h-0 flex-grow flex-col overflow-y-auto px-5 py-6 sm:px-8 sm:py-7"
      >
        <div className="mt-auto flex flex-col gap-5">
          {messages.map((m) => (
            <MessageRow key={m.id} message={m} />
          ))}
          {pending ? <TypingDots /> : null}
          <div ref={endRef} />
        </div>
      </div>

      <form
        onSubmit={submit}
        className="flex items-center gap-4 border-t-4 border-ink px-5 pt-5 pb-6 sm:px-7"
      >
        <label htmlFor="brief-input" className="sr-only">
          Tell your agent anything
        </label>
        <input
          id="brief-input"
          type="text"
          autoComplete="off"
          value={draft}
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Tell your agent anything…"
          className="h-14 min-w-0 flex-grow border-[3px] border-ink bg-paper px-4 text-[17px] font-semibold text-ink disabled:opacity-60"
        />
        <PixelButton
          type="submit"
          variant="dark"
          disabled={pending || draft.trim().length === 0}
          className="h-14 shrink-0 px-6"
        >
          SEND
        </PixelButton>
      </form>
    </section>
  );
}

function ChatHeader({
  participantId,
  names,
  onStartOver,
  busy,
}: {
  participantId: ParticipantId;
  names?: DisplayNames;
  onStartOver?: () => void;
  busy?: boolean;
}) {
  return (
    <header className="flex items-center justify-between gap-4 border-b-4 border-ink px-5 py-5 sm:px-7">
      <div className="flex items-center gap-4 sm:gap-[18px]">
        <Avatar
          id={participantId}
          size={64}
          className="bob shrink-0"
          names={names}
        />
        <div className="flex flex-col gap-1">
          <h1 className="head text-[24px] leading-none font-bold sm:text-[28px]">
            {agentName(participantId, names)}
          </h1>
          <p className="m-0 text-[15px] font-semibold text-bark">
            Plans for you. Never repeats you.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-4">
        {/* Re-briefing your own agent should not mean resetting the demo. This
            clears your conversation and nobody else's. */}
        {onStartOver ? (
          <button
            type="button"
            onClick={onStartOver}
            disabled={busy}
            className="disp px-press h-9 cursor-pointer border-[3px] border-ink bg-paper px-3 text-[8px] text-ink disabled:opacity-45"
          >
            START OVER
          </button>
        ) : null}
        <div className="flex items-center gap-2 text-bark">
          <LockIcon size={14} />
          <span className="disp text-[9px]">PRIVATE</span>
        </div>
      </div>
    </header>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "human") {
    return (
      <div className="flex justify-end">
        <p className="m-0 max-w-[85%] border-[3px] border-ink bg-coral px-5 py-4 text-[17px] leading-[1.5] font-bold text-white sm:max-w-[72%] sm:text-[18px]">
          {message.text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex max-w-[88%] flex-col gap-2.5 sm:max-w-[76%]">
      <p className="m-0 border-[3px] border-ink bg-paper px-5 py-4 text-[17px] leading-[1.5] font-semibold sm:text-[18px]">
        {message.text}
      </p>
      {message.keptPrivate ? (
        <p className="m-0 flex items-center gap-2 pl-1 text-[13px] font-bold text-bark">
          <LockIcon size={12} />
          Kept private: {message.keptPrivate}
        </p>
      ) : null}
    </div>
  );
}

function TypingDots() {
  return (
    <div
      className="flex w-fit items-center gap-2 border-[3px] border-ink bg-paper px-5 py-[18px]"
      aria-label="Your agent is typing"
      role="status"
    >
      {[0, 0.3, 0.6].map((delay) => (
        <span
          key={delay}
          className="blink block h-2 w-2 bg-ink"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  );
}

/**
 * A stored transcript as the chat renders it: a stable React key per line, and
 * the agent's opening question when there is no conversation to come back to.
 */
export function chatMessagesFrom(
  transcript: readonly BriefMessage[],
): ChatMessage[] {
  if (transcript.length === 0) {
    return [{ id: "opening", role: "agent", text: BRIEF_OPENING_LINE }];
  }
  return transcript.map((message, index) => ({
    ...message,
    id: `stored-${index}`,
  }));
}
