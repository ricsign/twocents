/**
 * The top of the plan: where, when, what it costs, and what it kept.
 *
 * The destination is the anchor of the whole screen, so it is set at 88px and
 * given the room to be the first thing read. Everything under it is support:
 * the price block states the number the group can act on, the runner-up line
 * says "we considered this and dropped it for that reason", and the checklist
 * turns four people's wants into four ticks.
 */

import type { Plan } from "@/lib/types";

/** "$2,160" — grouped, no cents. Every figure on this screen is whole dollars. */
function money(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** "1:52" from the measured length of the run. */
function clock(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * The runner-up, said once.
 *
 * The reason a runner-up lost usually names it and its price all over again
 * ("Tulum came in at $690 and every flight left at 6am"), so printing a
 * generated headline in front of that would state the same fact twice.
 */
function runnerUpLine(plan: Plan): string | null {
  const runnerUp = plan.runnerUp;
  if (!runnerUp) return null;

  const because = plan.runnerUpLostBecause.trim();
  const headline = `Runner-up: ${runnerUp.destination} at ${money(runnerUp.perPerson)}`;
  if (!because) return `${headline}.`;
  if (because.includes(runnerUp.destination)) return `Runner-up: ${because}`;
  return `${headline}, ${lowerFirst(because)}`;
}

export function PlanHeadline({ plan }: { plan: Plan }) {
  const { offer } = plan;
  const runnerUp = runnerUpLine(plan);

  return (
    <div className="flex flex-col gap-8 min-[1100px]:gap-9">
      <div className="flex flex-col gap-3.5">
        <p className="disp m-0 text-[10px] text-bark">
          THE PLAN · AGREED IN {clock(plan.agreedInMs)}
        </p>

        <h1
          className="head m-0 font-bold"
          // clamp() so the anchor survives a 390px phone, and normal wrapping
          // so a long destination breaks between words and never mid-word.
          style={{
            fontSize: "clamp(40px, 7.4vw, 88px)",
            lineHeight: 0.9,
            overflowWrap: "normal",
            wordBreak: "normal",
            hyphens: "none",
          }}
        >
          {offer.destination}
        </h1>

        <p className="head m-0 text-[20px] font-semibold text-bark min-[1100px]:text-[26px]">
          {offer.region} · {offer.dates} · {offer.nights} nights
        </p>
      </div>

      <div className="flex flex-col items-start gap-5 min-[700px]:flex-row min-[700px]:items-center min-[700px]:gap-7">
        <p className="m-0 flex items-baseline gap-2.5 bg-ink px-[22px] py-3.5 text-gold">
          <span className="head text-[48px] leading-none font-bold">
            {money(offer.perPerson)}
          </span>
          <span className="text-[15px] font-bold text-parchment">a person</span>
        </p>

        <p className="m-0 text-[16px] leading-relaxed font-semibold text-bark">
          {money(plan.groupTotal)} for the group, inside everyone’s real budget.
          {runnerUp ? (
            <>
              <br />
              {runnerUp}
            </>
          ) : null}
        </p>
      </div>

      {plan.keptWants.length > 0 ? (
        <ul className="m-0 grid list-none grid-cols-1 gap-x-8 gap-y-2.5 p-0 text-[18px] font-bold min-[700px]:grid-cols-2">
          {plan.keptWants.map((want) => (
            <li key={want} className="flex gap-3">
              <span className="text-leaf-deep" aria-hidden="true">
                ✓
              </span>
              <span>{want}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
