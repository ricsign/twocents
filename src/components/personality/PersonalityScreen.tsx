"use client";

import Link from "next/link";
import { useState } from "react";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import type { Personality } from "@/lib/types";
import { PixelLink } from "@/components/ui/PixelButton";
import { PersonalityStage } from "./PersonalityStage";
import { PresetRow } from "./PresetRow";
import { SliderRow } from "./SliderRow";
import { sampleLine, type SampleTopic } from "./sampleLine";
import { useDebouncedEffect } from "./useDebouncedEffect";

/**
 * Step 2, whole. Owns the sliders, the bio and the line under the stage.
 *
 * Two clocks run here. The sample line is rewritten *synchronously* on every
 * drag from `sampleLine`, so the flip beat lands in the same frame as the
 * thumb; `/api/voice` then upgrades that line 350ms after the hand stops, and
 * the session is saved on a slower beat still. Nobody on stage ever waits on a
 * network round trip to see a slider do something.
 *
 * The opening line comes from `sampleLine` too. It used to be a string the
 * page handed down, lifted out of the design mockup, which meant the first
 * sentence a judge read was about a destination the person in the seat had
 * never mentioned and did not answer to the sliders under it. Deriving it from
 * the same function every drag uses costs nothing — `sampleLine` is pure and
 * synchronous, so the server render and the first client render agree — and
 * means there is exactly one place the line can come from.
 */

const VOICE_DEBOUNCE_MS = 350;
const SAVE_DEBOUNCE_MS = 500;

type SliderKey = "stubborn" | "splurgy" | "blunt" | "adventurous";

const SLIDERS: { key: SliderKey; low: string; high: string }[] = [
  { key: "stubborn", low: "Easygoing", high: "Stubborn" },
  { key: "splurgy", low: "Frugal", high: "Splurgy" },
  { key: "blunt", low: "Diplomatic", high: "Blunt" },
  { key: "adventurous", low: "Cautious", high: "Adventurous" },
];

export function PersonalityScreen({
  participantId,
  initialPersonality,
  topic,
  names,
}: {
  participantId: ParticipantId;
  /** The personality stored in the session, not a seed. A reload must not revert it. */
  initialPersonality: Personality;
  /** What this room is arguing about, so the preview argues about that too. */
  topic: SampleTopic;
  /** Who the agent on the stage speaks for. */
  names?: DisplayNames;
}) {
  const [personality, setPersonality] = useState<Personality>(initialPersonality);
  const [line, setLine] = useState(() => sampleLine(initialPersonality, topic));

  const sliderKey = SLIDERS.map((s) => personality[s.key]).join("|");

  /** Every change goes through here, so the line can never lag the sliders. */
  function apply(next: Personality) {
    setPersonality(next);
    setLine(sampleLine(next, topic));
  }

  function setSlider(key: SliderKey, value: number) {
    const next: Personality = { ...personality, [key]: value };
    apply(next);
  }

  /** A preset sets the sliders and only fills a bio the human left empty. */
  function pickPreset(preset: Personality) {
    apply({
      ...preset,
      bio: personality.bio.trim() ? personality.bio : preset.bio,
    });
  }

  // The richer line, once the dragging stops. A failure keeps the local one.
  useDebouncedEffect(sliderKey, VOICE_DEBOUNCE_MS, (signal) => {
    void (async () => {
      try {
        const res = await fetch("/api/voice", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // The same noun the instant line argues against, so the upgrade
          // reads as a better version of it rather than a different subject.
          body: JSON.stringify({ personality, contested: topic.contested }),
          signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { line?: unknown };
        if (typeof data.line === "string" && data.line.trim()) {
          setLine(data.line.trim());
        }
      } catch {
        // Rule 2: the room never sees an error state.
      }
    })();
  });

  // Persist, so the town argues with the personality that is on screen.
  useDebouncedEffect(`${sliderKey}|${personality.bio}`, SAVE_DEBOUNCE_MS, (signal) => {
    void fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "updatePersonality",
        // Writing your own row. The route refuses anything else.
        viewer: participantId,
        participantId,
        personality,
      }),
      signal,
    }).catch(() => {});
  });

  return (
    <main className="grid min-h-0 flex-1 grid-cols-1 gap-10 px-4 pt-8 pb-10 sm:px-8 min-[1100px]:grid-cols-[520px_minmax(0,1fr)] min-[1100px]:gap-16 min-[1100px]:px-14 min-[1100px]:pt-11 min-[1100px]:pb-12">
      <PersonalityStage
        participantId={participantId}
        line={line}
        names={names}
      />

      <div className="flex min-h-0 flex-col gap-8">
        <h1 className="head m-0 text-[30px] leading-none font-bold min-[1100px]:text-[40px]">
          How hard should it fight for you?
        </h1>

        <div className="flex flex-col gap-6">
          {SLIDERS.map((s) => (
            <SliderRow
              key={s.key}
              id={`slider-${s.key}`}
              low={s.low}
              high={s.high}
              value={personality[s.key]}
              onChange={(value) => setSlider(s.key, value)}
            />
          ))}
        </div>

        <PresetRow personality={personality} onPick={pickPreset} />

        <div className="flex flex-col gap-2">
          <label htmlFor="bio" className="text-[14px] font-bold text-bark">
            A line about you, for your agent
          </label>
          <textarea
            id="bio"
            rows={2}
            value={personality.bio}
            onChange={(e) => apply({ ...personality, bio: e.target.value })}
            className="w-full resize-none px-4 py-3.5 text-[17px] leading-normal"
          />
        </div>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-6 pt-2">
          <Link href="/brief" className="text-[15px] font-bold text-bark no-underline">
            ← Back to the brief
          </Link>
          <PixelLink
            href="/town"
            variant="primary"
            raised
            className="h-16 w-full px-4 text-center sm:w-auto sm:px-9"
          >
            SEND MY AGENT TO THE TOWN
          </PixelLink>
        </div>
      </div>
    </main>
  );
}
