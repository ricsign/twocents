"use client";

/**
 * Pause, speed, reset — the three things a judge touches.
 *
 * These are real buttons with real labels rather than the mockup's bare glyphs:
 * "II" is legible on a projector and meaningless to a screen reader, so the
 * glyph stays and an accessible name goes with it. The speed control is a
 * radio-shaped group expressed with `aria-pressed`, since it toggles a setting
 * rather than navigating anywhere.
 */

import type { ComponentProps } from "react";
import type { Speed } from "@/hooks/useNegotiation";
import { SPEEDS } from "@/hooks/useNegotiation";
import { PushToTalk } from "./push-to-talk";

const BASE =
  "disp cursor-pointer border-[3px] border-ink bg-card text-ink px-press";

export function TownControls({
  paused,
  speed,
  onTogglePause,
  onSpeed,
  onReset,
  disabled = false,
  talk,
}: {
  paused: boolean;
  speed: Speed;
  onTogglePause: () => void;
  onSpeed: (speed: Speed) => void;
  onReset: () => void;
  disabled?: boolean;
  /** sessionId + participantId for the live user. Omit to hide the talk button. */
  talk?: ComponentProps<typeof PushToTalk>;
}) {
  return (
    <div
      className="absolute z-10 flex items-center gap-2.5"
      style={{ right: 20, bottom: 20 }}
    >
      {talk && <PushToTalk {...talk} />}

      <button
        type="button"
        onClick={onTogglePause}
        disabled={disabled}
        aria-label={paused ? "Resume the negotiation" : "Pause the negotiation"}
        className={`${BASE} h-12 w-12 text-[12px] disabled:opacity-45`}
      >
        <span aria-hidden="true">{paused ? "▶" : "II"}</span>
      </button>

      <div
        role="group"
        aria-label="Playback speed"
        className="flex border-[3px] border-ink"
      >
        {SPEEDS.map((value, index) => {
          const active = value === speed;
          return (
            <button
              key={value}
              type="button"
              onClick={() => onSpeed(value)}
              aria-pressed={active}
              aria-label={`Play at ${value} times speed`}
              className={`disp h-[42px] cursor-pointer border-0 px-3.5 text-[10px] ${
                index > 0 ? "border-l-[3px] border-ink" : ""
              } ${active ? "bg-ink text-gold" : "bg-card text-ink"}`}
            >
              {value}x
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onReset}
        aria-label="Reset and run the negotiation again"
        className={`${BASE} h-12 px-4 text-[10px]`}
      >
        RESET
      </button>
    </div>
  );
}