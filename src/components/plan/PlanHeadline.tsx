/**
 * The top of the plan: where, when, what it costs, and what it kept.
 *
 * The destination is the anchor of the whole screen, so it is set at 88px and
 * given the room to be the first thing read. Everything under it is support:
 * the price block states the number the group can act on, the runner-up line
 * says "we considered this and dropped it for that reason", and the checklist
 * turns four people's wants into four ticks.
 */

import { GAVE_UP_BUDGET } from "@/lib/negotiation/fairness";
import type { FairnessReport, Plan } from "@/lib/types";

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
 * "5 nights", "1 night", or nothing at all.
 *
 * A dinner has no nights — `lib/llm/scenario.ts` gives a non-overnight option
 * zero of them — so the clause is dropped rather than printed as "0 nights",
 * and a single night is singular.
 */
function nightsClause(nights: number | null): string | null {
  if (nights === null || nights <= 0) return null;
  return `${nights} ${nights === 1 ? "night" : "nights"}`;
}

/**
 * Sentence-leading count words. The table is four people, so the list ends
 * there and the digit fallback is a thing nobody should ever see.
 */
const COUNT_WORDS: readonly string[] = ["Nobody", "One", "Two", "Three", "Four"];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/**
 * The money line, earned from the meter rather than asserted over it.
 *
 * "Inside everyone’s real budget" is the sentence the whole product is
 * selling, and it used to be fixed prose — printed word for word above a
 * fairness meter reading "gave up staying under budget" on three of its four
 * bars. So it is now read off the same report those bars are drawn from:
 * `scoreFairness` ranks a broken ceiling above every other loss, so a row
 * carrying `GAVE_UP_BUDGET` is a person this plan priced out, and no such row
 * means the plan really does clear all four.
 *
 * When it does not, the line says how many and stops there. Not who, because
 * the meter directly below names them once already, and never how much,
 * because a ceiling is the one figure this screen — the one all four of them
 * read at the same time — may never carry.
 */
function budgetLine(plan: Plan, fairness: FairnessReport): string {
  const total = money(plan.groupTotal);

  // No rows is not "nobody went over", it is "nobody was scored" — the meter
  // below is empty in the same breath. Print the total and claim nothing.
  if (fairness.rows.length === 0) return `${total} for the group.`;

  const over = fairness.rows.filter((row) => row.gaveUp === GAVE_UP_BUDGET).length;
  if (over === 0) return `${total} for the group, inside everyone’s real budget.`;

  const who = over === 1 ? "One of them is" : `${countWord(over)} of them are`;
  return `${total} for the group. ${who} over the number they gave their agent in private.`;
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

export function PlanHeadline({
  plan,
  fairness,
}: {
  plan: Plan;
  /** The same report the meter below renders. The budget line is read off it. */
  fairness: FairnessReport;
}) {
  const { offer } = plan;
  const runnerUp = runnerUpLine(plan);
  const nights = nightsClause(offer.nights);

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
          {[offer.region, offer.dates, nights].filter(Boolean).join(" · ")}
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
          {budgetLine(plan, fairness)}
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
