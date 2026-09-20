"use client";

/**
 * Pause, speed, run again, reset — the four things a judge touches.
 *
 * These are real buttons with real labels rather than the mockup's bare glyphs:
 * "II" is legible on a projector and meaningless to a screen reader, so the
 * glyph stays and an accessible name goes with it. The speed control is a
 * radio-shaped group expressed with `aria-pressed`, since it toggles a setting
 * rather than navigating anywhere.
 *
 * RUN AGAIN and RESET DEMO are two different acts and used to be one button.
 * RESET DEMO replaces the session with a fresh seed, which throws away the
 * brief the person in the seat just typed and every slider they moved; RUN
 * AGAIN argues the same room out a second time. When the only control was
 * labelled RESET, the personality-flip beat used it to "run it again" and
 * quietly reseeded the flip away. A judge reading a label should be able to
 * tell which one they are about to get.
 */

import type { Speed } from "@/hooks/useNegotiation";
import { SPEEDS } from "@/hooks/useNegotiation";

const BASE =
  "disp cursor-pointer border-[3px] border-ink bg-card text-ink px-press";

export function TownControls({
  paused,
  speed,
  onTogglePause,
  onSpeed,
  onRerun,
  onReset,
  disabled = false,
}: {
  paused: boolean;
  speed: Speed;
  onTogglePause: () => void;
  onSpeed: (speed: Speed) => void;
  /** Argue the same room out again, keeping every brief and every slider. */
  onRerun: () => void;
  /** Rebuild the room from the seed, discarding briefs and sliders. */
  onReset: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="absolute z-10 flex flex-wrap items-center justify-end gap-2.5"
      style={{ right: 20, bottom: 20 }}
    >
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
        onClick={onRerun}
        title="Run the negotiation again with the briefs and personalities this room has now"
        aria-label="Run the negotiation again with the same briefs"
        className={`${BASE} h-12 px-4 text-[10px]`}
      >
        RUN AGAIN
      </button>

      <button
        type="button"
        onClick={onReset}
        title="Rebuild the room from the seeded demo, discarding every brief and slider, then run it"
        aria-label="Reset to the seeded demo, discarding every brief and personality"
        className={`${BASE} h-12 px-4 text-[10px]`}
      >
        RESET DEMO
      </button>
    </div>
  );
}
