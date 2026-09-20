import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { agentName } from "@/lib/characters";
import { CharacterSprite, Scenery } from "@/components/ui/Sprite";

/**
 * The left column: one agent alone in its room, and the line it would say.
 *
 * The sample line is the payoff of every slider on the right, so it gets the
 * 26px head treatment and an `aria-live` region — a screen reader user has to
 * hear the personality flip too, not just watch it.
 */

/** Drawn at an integer-ish multiple of 16 at full width, shrunk by viewport. */
const AGENT_SIZE = "clamp(150px, 24vw, 224px)";

export function PersonalityStage({
  participantId,
  line,
  neverSays,
  names,
}: {
  participantId: ParticipantId;
  line: string;
  /**
   * The figure this agent is holding, already formatted, or null when its
   * human has not named one. The caption used to assert "$600" outright,
   * which was this seat's seeded ceiling and nobody else's: a person who told
   * their agent $900 read a promise about somebody else's money.
   */
  neverSays: string | null;
  /** Who this agent speaks for, on the tag under the sprite. */
  names?: DisplayNames;
}) {
  return (
    <div className="flex flex-col gap-7">
      <div className="relative flex h-[340px] items-end justify-center overflow-hidden border-4 border-ink bg-wall sm:h-[420px] min-[1100px]:h-[480px]">
        {/* Floor: flat wood with a vertical grain, hard ink edge at the top. */}
        <div
          className="absolute inset-x-0 bottom-0 h-[110px] border-t-4 border-ink bg-wood sm:h-[130px] min-[1100px]:h-[150px]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(43,30,20,0.16) 0 4px, transparent 4px 40px)",
          }}
        />

        <Scenery
          src="/sprites/window.png"
          width={160}
          height={80}
          className="absolute top-[52px] left-[48px] hidden sm:block"
        />
        <Scenery
          src="/sprites/plant.png"
          width={96}
          height={96}
          className="absolute right-[44px] bottom-[100px] hidden sm:block min-[1100px]:bottom-[120px]"
        />

        {/* Flat shadow, never a blur. */}
        <div
          className="absolute bottom-[38px] left-1/2 h-4 w-[160px] -translate-x-1/2 min-[1100px]:bottom-[52px] min-[1100px]:w-[190px]"
          style={{ background: "rgba(43,30,20,0.28)" }}
        />

        <CharacterSprite
          id={participantId}
          size={224}
          state="idle"
          names={names}
          className="bob-tall relative mb-[46px] min-[1100px]:mb-[60px]"
          style={{
            width: AGENT_SIZE,
            height: AGENT_SIZE,
            backgroundSize: `${AGENT_SIZE} calc(${AGENT_SIZE} * 3)`,
          }}
        />

        <div className="disp absolute bottom-4 left-1/2 -translate-x-1/2 bg-ink px-3.5 py-2 text-[9px] whitespace-nowrap text-gold">
          {agentName(participantId, names).toUpperCase()}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <h2 className="disp m-0 text-[10px] font-normal text-bark">
          HOW IT’LL SOUND
        </h2>
        <p
          className="head m-0 text-[22px] leading-tight font-semibold min-[1100px]:text-[26px]"
          aria-live="polite"
        >
          “{line}”
        </p>
        <p className="m-0 text-[14px] font-bold text-bark">
          Changes with the sliders.{neverSays ? ` Still never says ${neverSays}.` : ""}
        </p>
      </div>
    </div>
  );
}
