"use client";

import { PERSONALITY_PRESETS, type Personality } from "@/lib/types";

/**
 * Three one-tap starting points, straight from `PERSONALITY_PRESETS`.
 *
 * The briefing plus the personality has to fit inside a minute on stage, so a
 * judge who does not want to drag four sliders taps one of these and goes. The
 * active one inverts — ink field, gold text — exactly as in the mockup.
 */

/** Only the sliders decide "active"; a typed bio should not un-press a button. */
const SLIDERS = ["stubborn", "splurgy", "blunt", "adventurous"] as const;

function sameSliders(a: Personality, b: Personality): boolean {
  return SLIDERS.every((key) => a[key] === b[key]);
}

/** "pennyPincher" -> "PENNY PINCHER". */
function labelFor(key: string): string {
  return key.replace(/([A-Z])/g, " $1").toUpperCase();
}

export function PresetRow({
  personality,
  onPick,
}: {
  personality: Personality;
  onPick: (preset: Personality) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="mr-1.5 text-[14px] font-bold text-bark">Presets</span>
      {Object.entries(PERSONALITY_PRESETS).map(([key, preset]) => {
        const active = sameSliders(personality, preset);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            onClick={() => onPick(preset)}
            className={`disp px-press h-11 cursor-pointer border-[3px] border-ink px-3.5 text-[9px] ${
              active ? "bg-ink text-gold" : "bg-card text-ink"
            }`}
          >
            {labelFor(key)}
          </button>
        );
      })}
    </div>
  );
}
