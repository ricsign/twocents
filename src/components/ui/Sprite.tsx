import Image from "next/image";
import type { CSSProperties } from "react";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { CHARACTERS, agentName, displayNameFor } from "@/lib/characters";

/** Flat 16x16 portrait, scaled up with nearest-neighbour. */
export function Avatar({
  id,
  size = 28,
  className = "",
  style,
  names,
}: {
  id: ParticipantId;
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** Name overrides for the alt text; omitted means the cast name. */
  names?: DisplayNames;
}) {
  const c = CHARACTERS[id];
  return (
    <Image
      src={c.avatar}
      alt={displayNameFor(names, id)}
      width={size}
      height={size}
      unoptimized
      className={`spr ${className}`}
      style={{ width: size, height: size, imageRendering: "pixelated", ...style }}
    />
  );
}

export type SpriteState = "idle" | "talking" | "walking";

/**
 * Animated character from a 16x48 sheet (three stacked frames).
 * Rendered as a background-image so the CSS keyframes can step through frames.
 */
export function CharacterSprite({
  id,
  size = 112,
  state = "idle",
  className = "",
  style,
  label,
  names,
}: {
  id: ParticipantId;
  size?: number;
  state?: SpriteState;
  className?: string;
  style?: CSSProperties;
  label?: string;
  /** Name overrides for the default label; omitted means the cast name. */
  names?: DisplayNames;
}) {
  const c = CHARACTERS[id];
  const anim =
    state === "talking" ? "talk" : state === "walking" ? "walking" : "";
  return (
    <div
      role="img"
      aria-label={label ?? agentName(id, names)}
      className={`spr ${anim} ${className}`}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${c.sheet})`,
        backgroundSize: `${size}px ${size * 3}px`,
        ...style,
      }}
    />
  );
}

/** Scenery sprite (table, window, plant) at an explicit pixel size. */
export function Scenery({
  src,
  width,
  height,
  className = "",
  style,
}: {
  src: string;
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Image
      src={src}
      alt=""
      width={width}
      height={height}
      unoptimized
      aria-hidden="true"
      className={`spr ${className}`}
      style={{ width, height, imageRendering: "pixelated", ...style }}
    />
  );
}
