"use client";

import { PERSONALITY_THRESHOLDS } from "@/lib/types";

/**
 * One labelled slider, styled entirely by the global `input[type=range]` rules.
 *
 * The number on this control means nothing to anyone: "70" is not a position a
 * person can picture. So the visible labels are the two poles, and
 * `aria-valuetext` says where the thumb actually sits in words — "mostly
 * stubborn" — which is the same thing a sighted judge reads off the track.
 */

/** Plain-words position, keyed off the same thresholds the agent prompt uses. */
export function positionText(value: number, low: string, high: string): string {
  const t = PERSONALITY_THRESHOLDS;
  const lo = low.toLowerCase();
  const hi = high.toLowerCase();

  if (value >= 85) return `all the way ${hi}`;
  if (value >= t.high) return `strongly ${hi}`;
  if (value >= t.lean) return `mostly ${hi}`;
  if (value > t.leanLow) return `even between ${lo} and ${hi}`;
  if (value > t.low) return `mostly ${lo}`;
  if (value > 15) return `strongly ${lo}`;
  return `all the way ${lo}`;
}

export function SliderRow({
  id,
  low,
  high,
  value,
  onChange,
}: {
  id: string;
  /** The 0 end. Doubles as the control's visible `<label>`. */
  low: string;
  /** The 100 end. */
  high: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between gap-4">
        <label htmlFor={id} className="head text-[19px] font-bold min-[1100px]:text-[22px]">
          {low}
        </label>
        <span className="head text-[19px] font-bold min-[1100px]:text-[22px]" aria-hidden="true">
          {high}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={`${low} to ${high}`}
        aria-valuetext={positionText(value, low, high)}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
