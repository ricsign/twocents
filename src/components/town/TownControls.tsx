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
 * RESET DEMO replaces the session with a fresh seed and hands the keyboard
 * back at step 1, because a fresh seed is a room whose fourth agent has been
 * told nothing; RUN AGAIN argues the room as it stands out a second time.
 * When the only control was labelled RESET, the personality-flip beat used it
 * to "run it again" and quietly reseeded the flip away. A judge reading a
 * label should be able to tell which one they are about to get.
 *
 * `disabled` covers the pause button and the speed group together. Both act
 * on a live stream, and there is no stream behind a run that was painted from
 * the session rather than watched: a highlighted 4x that changes nothing is a
 * worse answer than a dimmed one.
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
  /** Rebuild the room from the seed and go back to the briefing screen. */
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
              disabled={disabled}
              aria-pressed={active}
              aria-label={`Play at ${value} times speed`}
              className={`disp h-[42px] cursor-pointer border-0 px-3.5 text-[10px] disabled:cursor-default disabled:opacity-45 ${
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
        title="Rebuild the room from the seeded demo, discarding every brief and slider, and start again at the briefing"
        aria-label="Reset to the seeded demo and go back to the briefing screen"
        className={`${BASE} h-12 px-4 text-[10px]`}
      >
        RESET DEMO
      </button>
    </div>
  );
}
