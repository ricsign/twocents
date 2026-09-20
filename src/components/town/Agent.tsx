"use client";

/**
 * One character standing at the table: the sprite, the name tag under it, and
 * the thinking dots that pop above its head while its line is being written.
 *
 * Positions are literal pixel offsets inside the room's fixed 888x768 layer.
 * Will stands behind the table (z-index 1) so the table hides his feet; the
 * other three are in front of it.
 */

import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { YOU, displayNameFor } from "@/lib/characters";
import { CharacterSprite } from "@/components/ui/Sprite";

/** Sprite top-left, in room pixels. Sprites are 112px square. */
export const STAGE: Record<
  ParticipantId,
  { left: number; top: number; z: number }
> = {
  maya: { left: 150, top: 352, z: 3 },
  jordan: { left: 626, top: 352, z: 3 },
  sam: { left: 388, top: 260, z: 1 },
  priya: { left: 388, top: 446, z: 3 },
};

export const SPRITE = 112;

/** Height of the thinking-dots box: 3px borders, 12px padding, a 7px dot. */
const DOTS_H = 37;

export function Agent({
  id,
  speaking,
  thinking,
  names,
}: {
  id: ParticipantId;
  speaking: boolean;
  thinking: boolean;
  /** Who is in this seat. The sprite and the colour never change with it. */
  names?: DisplayNames;
}) {
  const at = STAGE[id];
  const you = id === YOU;

  return (
    <div
      className="absolute flex flex-col items-center gap-1.5"
      style={{ left: at.left, top: at.top, zIndex: at.z, width: SPRITE }}
    >
      {thinking ? <ThinkingDots /> : null}

      <CharacterSprite
        id={id}
        size={SPRITE}
        state={speaking ? "talking" : "idle"}
        names={names}
      />

      <div
        className="disp px-2 py-[5px] text-[7px] whitespace-nowrap"
        style={{
          background: you ? "#E2593F" : "#2B1E14",
          color: you ? "#FFFFFF" : "#F4E9D0",
        }}
      >
        {displayNameFor(names, id).toUpperCase()}
        {you ? " · YOU" : ""}
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <div
      className="absolute flex gap-1.5 border-[3px] border-ink bg-paper px-3.5 py-3"
      style={{
        top: -DOTS_H - 8,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 4,
      }}
    >
      {[0, 0.3, 0.6].map((delay) => (
        <span
          key={delay}
          className="blink block h-[7px] w-[7px] bg-ink"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  );
}
