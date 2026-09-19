"use client";

/**
 * The room. A warm-brown box with four agents standing around a table.
 *
 * Every position here is a literal pixel offset inside a fixed 888x768 layer —
 * the size the left grid column resolves to at the mockup's 1440px. That layer
 * is scaled as one with a CSS transform, so sprites keep their integer sizes
 * and the whole scene grows or shrinks without a single element drifting out of
 * register.
 *
 * Bubble anchors are hard-coded per speaker rather than solved for: only two
 * bubbles are ever up at once, the four slots below do not overlap each other
 * or any face, and a layout that cannot surprise you on stage is worth more
 * than one that is clever.
 *
 * Decorative in full — the transcript is the accessible record of the same
 * lines — so this subtree is hidden from assistive technology.
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { Scenery } from "@/components/ui/Sprite";
import type { Bubble } from "@/hooks/useNegotiation";
import { Agent, STAGE } from "./Agent";
import { RoomBackdrop } from "./RoomBackdrop";
import { SpeechBubble } from "./SpeechBubble";

export const ROOM_W = 888;
export const ROOM_H = 768;

/**
 * Where a speaker's bubble hangs. `bottomY` is the bubble's lower edge, so a
 * long line grows upward and can never creep down over a face.
 */
const BUBBLE_ANCHOR: Record<
  ParticipantId,
  { left: number; width: number; bottomY: number; tailLeft: number }
> = {
  maya: { left: 20, width: 290, bottomY: 336, tailLeft: 176 },
  jordan: { left: 596, width: 272, bottomY: 336, tailLeft: 80 },
  sam: { left: 324, width: 268, bottomY: 240, tailLeft: 116 },
  priya: { left: 324, width: 268, bottomY: 430, tailLeft: 116 },
};

export function Room({
  currentSpeaker,
  thinkingSpeaker,
  bubbles,
  round,
  roundsTotal,
  elapsedMs,
  live,
  names,
  children,
}: {
  currentSpeaker: ParticipantId | null;
  thinkingSpeaker: ParticipantId | null;
  bubbles: Bubble[];
  round: number;
  roundsTotal: number;
  elapsedMs: number;
  /** False while paused or finished: the recording light stops blinking. */
  live: boolean;
  /** What the four people are called on their name tags. */
  names?: DisplayNames;
  /** The speed controls, so they sit inside the room's frame, unscaled. */
  children?: ReactNode;
}) {
  const [frameRef, scale] = useFitScale();

  return (
    <div
      ref={frameRef}
      aria-hidden="true"
      className="relative w-full overflow-hidden border-4 border-ink bg-wood"
      style={{ aspectRatio: `${ROOM_W} / ${ROOM_H}` }}
    >
      <div
        className="absolute top-0 left-0"
        style={{
          width: ROOM_W,
          height: ROOM_H,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <RoomBackdrop />

        <Scenery
          src="/sprites/window.png"
          width={192}
          height={96}
          style={{ position: "absolute", left: 56, top: 56 }}
        />
        <Scenery
          src="/sprites/plant.png"
          width={112}
          height={112}
          style={{ position: "absolute", left: 36, bottom: 36 }}
        />

        <RoundHud
          round={round}
          roundsTotal={roundsTotal}
          elapsedMs={elapsedMs}
          live={live}
        />

        <Scenery
          src="/sprites/table.png"
          width={336}
          height={112}
          style={{ position: "absolute", left: 276, top: 372, zIndex: 2 }}
        />

        {(Object.keys(STAGE) as ParticipantId[]).map((id) => (
          <Agent
            key={id}
            id={id}
            speaking={currentSpeaker === id}
            thinking={thinkingSpeaker === id}
            names={names}
          />
        ))}

        {bubbles.map((bubble) => {
          const anchor = BUBBLE_ANCHOR[bubble.speaker];
          return (
            <div
              key={bubble.id}
              className="absolute"
              style={{
                left: anchor.left,
                bottom: ROOM_H - anchor.bottomY,
                zIndex: 4,
              }}
            >
              <SpeechBubble
                text={bubble.text}
                privateReasonKept={bubble.privateReasonKept}
                tailLeft={anchor.tailLeft}
                width={anchor.width}
              />
            </div>
          );
        })}
      </div>

      {children}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Measures the frame and reports the factor the fixed layer is drawn at. */
function useFitScale(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(1);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setValue(entry.contentRect.width / ROOM_W);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return [ref, value];
}

function RoundHud({
  round,
  roundsTotal,
  elapsedMs,
  live,
}: {
  round: number;
  roundsTotal: number;
  elapsedMs: number;
  live: boolean;
}) {
  const seconds = Math.floor(elapsedMs / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div
      className="absolute flex items-center gap-3 bg-ink px-3.5 py-2.5 text-parchment"
      style={{ right: 20, top: 20 }}
    >
      <div
        className={`h-2.5 w-2.5 bg-coral ${live ? "blink-fast" : ""}`}
        style={live ? undefined : { opacity: 0.35 }}
      />
      <div className="disp text-[9px]">
        ROUND {Math.max(round, 1)} OF {roundsTotal} · {clock}
      </div>
    </div>
  );
}
