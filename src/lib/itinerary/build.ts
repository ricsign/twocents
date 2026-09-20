/**
 * Builds the document the four of them travel with.
 *
 * The shape of this module is one idea: **the model proposes, the network
 * disposes, and arithmetic has the last word.** The model searches and drafts;
 * `availability.ts` checks every time in that draft against the opening hours
 * it found, the flight it booked and the price the four of them agreed to;
 * `verify.ts` throws out every link and photo that does not actually exist; and
 * the costs printed on the page are summed here from the surviving rows rather
 * than taken from the draft, so the total under the days is always the total of
 * the days.
 *
 * The availability pass gets exactly one repair attempt. One because the fix
 * for a shut museum is usually a real fix, and a second round of the same call
 * mostly buys another minute of a person watching a progress bar. What it
 * cannot fix, it removes: an item scheduled on a day its door is locked is
 * dropped from the document rather than printed with a caveat, and what was
 * dropped is counted so the page can say so.
 *
 * Like every other call in the product this one cannot fail loudly: no key, no
 * network or a model that will not answer all end at the canned itinerary, in
 * the same shape, and the page renders either way.
 *
 * Server-only. No React, no DOM.
 */

import { PARTICIPANT_IDS } from "@/lib/characters";
import { getProvider } from "@/lib/llm";
import type { LLMProvider } from "@/lib/llm/provider";
import {
  budgetIssue,
  checkAvailability,
  clockLabel,
  minutesOf,
  type AvailabilityIssue,
} from "@/lib/itinerary/availability";
import { cannedItinerary, tripFromOffer } from "@/lib/itinerary/canned";
import {
  ITINERARY_MAX_SEARCHES,
  ITINERARY_MAX_TOKENS,
  ITINERARY_REPAIR_MAX_TOKENS,
  ITINERARY_REPAIR_SYSTEM_PROMPT,
  ITINERARY_SYSTEM_PROMPT,
  buildItineraryRepairPrompt,
  buildItineraryUserPrompt,
  itineraryDraftSchema,
  itineraryTimeoutMs,
  type ItineraryDraft,
} from "@/lib/itinerary/prompt";
import { fetchDayPhoto, hostOf, verifyLink } from "@/lib/itinerary/verify";
import type {
  Itinerary,
  ItineraryChecks,
  ItineraryDay,
  ItineraryItem,
  Plan,
} from "@/lib/types";

/** Whether day photos get fetched. Off makes the build a second or two faster. */
function photosEnabled(): boolean {
  return process.env.TWOCENTS_ITINERARY_PHOTOS !== "0";
}

/** Sum of a column, skipping the free things. */
function sumCosts(items: readonly { costPerPerson: number | null }[]): number {
  return items.reduce((total, item) => total + (item.costPerPerson ?? 0), 0);
}

/**
 * The time the document prints for a row.
 *
 * The checked clock time wins over the model's own label, because that is the
 * one that was compared against the opening hours — printing "Evening" beside a
 * row whose 19:30 was verified throws away the only fact here anybody can act
 * on. A row with no usable clock time falls back to whatever label it had.
 */
function timeLabel(row: { time?: string; startsAt?: string }): string {
  const minutes = minutesOf(row.startsAt);
  if (minutes !== null) return clockLabel(minutes);
  return row.time ?? "";
}

/** Turns one drafted row into a printable one, dropping a link that does not resolve. */
async function verifyItem(
  row: {
    time?: string;
    startsAt?: string;
    title: string;
    detail: string;
    costPerPerson: number | null;
    url: string | null;
  },
  fallbackLabel: string,
): Promise<ItineraryItem> {
  return {
    time: timeLabel(row),
    title: row.title,
    detail: row.detail,
    costPerPerson: row.costPerPerson,
    link: await verifyLink(row.url, fallbackLabel),
  };
}

/**
 * Verifies one day's rows and fetches its photograph.
 *
 * The rows go out in parallel because they are independent and the page is
 * waiting: a day of five links checked one after another is five round trips of
 * dead time for no benefit.
 */
async function buildDay(
  draft: ItineraryDraft["days"][number],
  withPhotos: boolean,
): Promise<ItineraryDay> {
  const [items, photo] = await Promise.all([
    Promise.all(draft.items.map((item) => verifyItem(item, "Book it"))),
    withPhotos ? fetchDayPhoto(draft.photoQuery) : Promise.resolve(null),
  ]);

  return {
    day: draft.day,
    date: draft.date,
    title: draft.title,
    items,
    // Summed, never taken from the draft: a day whose rows add to $94 prints
    // $94, even if the model was sure it was $90.
    subtotalPerPerson: sumCosts(items),
    photo,
  };
}

/** Every host the finished document points at, in the order they first appear. */
function sourcesOf(itinerary: Omit<Itinerary, "sources">): string[] {
  const seen = new Set<string>();
  const links = [
    itinerary.flights.link,
    itinerary.lodging.link,
    ...itinerary.days.flatMap((day) => day.items.map((item) => item.link)),
    ...itinerary.days.map((day) =>
      day.photo ? { host: hostOf(day.photo.creditUrl) ?? "" } : null,
    ),
  ];
  for (const link of links) {
    if (link?.host) seen.add(link.host);
  }
  return [...seen];
}

/** Assembles a verified draft into the finished document. */
async function assemble(
  draft: ItineraryDraft,
  plan: Plan,
  live: boolean,
  checks?: ItineraryChecks,
): Promise<Itinerary> {
  const withPhotos = photosEnabled();
  const offer = plan.offer;

  const [flights, lodging, days] = await Promise.all([
    verifyItem({ ...draft.flights, time: "" }, "Book the flight"),
    verifyItem({ ...draft.lodging, time: "" }, "Book the stay"),
    Promise.all(draft.days.map((day) => buildDay(day, withPhotos))),
  ]);

  const perPerson =
    sumCosts([flights, lodging]) + days.reduce((total, day) => total + day.subtotalPerPerson, 0);

  const base: Omit<Itinerary, "sources"> = {
    destination: offer.destination,
    region: offer.region,
    dates: offer.dates,
    nights: offer.nights,
    headline: draft.headline,
    flights,
    lodging,
    days,
    perPerson,
    groupTotal: perPerson * PARTICIPANT_IDS.length,
    builtAt: Date.now(),
    live,
    ...(checks ? { checks } : {}),
  };

  return { ...base, sources: sourcesOf(base) };
}

/* -------------------------------------------------------------------------- */
/* The availability pass                                                       */
/* -------------------------------------------------------------------------- */

/** The draft's own idea of what it costs, before anything has been verified. */
function draftCost(draft: ItineraryDraft): number {
  return (
    (draft.flights.costPerPerson ?? 0) +
    (draft.lodging.costPerPerson ?? 0) +
    draft.days.reduce((total, day) => total + sumCosts(day.items), 0)
  );
}

/** Every row with a clock time, which is what the check is counting. */
function datedItemCount(draft: ItineraryDraft): number {
  return draft.days.reduce((total, day) => total + day.items.length, 0);
}

/** The schedule problems plus the price one, which travel together. */
function problemsIn(draft: ItineraryDraft, plan: Plan): AvailabilityIssue[] {
  const issues = checkAvailability(draft, plan);
  const money = budgetIssue(draftCost(draft), plan);
  return money ? [...issues, money] : issues;
}

/** Codes that mean the row itself cannot stand, however it is phrased. */
const FATAL: ReadonlySet<AvailabilityIssue["code"]> = new Set([
  "closed-that-day",
  "before-arrival",
  "after-departure",
]);

/**
 * Removes what could not be fixed.
 *
 * An item the check says is shut, or scheduled before the plane lands, is taken
 * out of the document entirely — the same rule `verify.ts` applies to a link
 * that 404s, for the same reason. Everything else keeps its row: a time that
 * could not be confirmed is still a real place, so it stays and its unconfirmed
 * clock time goes, which is the honest half of what we knew.
 */
function applyUnresolved(
  draft: ItineraryDraft,
  issues: readonly AvailabilityIssue[],
): { draft: ItineraryDraft; dropped: number } {
  const drop = new Set<string>();
  const blank = new Set<string>();
  for (const issue of issues) {
    if (issue.day === null || issue.item === null) continue;
    (FATAL.has(issue.code) ? drop : blank).add(`${issue.day}:${issue.item}`);
  }
  if (drop.size === 0 && blank.size === 0) return { draft, dropped: 0 };

  const days = draft.days.map((day) => ({
    ...day,
    items: day.items
      .map((item, index) => {
        const key = `${day.day}:${index}`;
        if (drop.has(key)) return null;
        // The place is real; the hour is what we could not stand behind.
        if (blank.has(key)) return { ...item, startsAt: "", time: item.time };
        return item;
      })
      .filter((item): item is (typeof day.items)[number] => item !== null),
  }));

  return { draft: { ...draft, days }, dropped: drop.size };
}

/**
 * Checks the draft, takes one pass at fixing what is wrong, and reports.
 *
 * The repair call is skipped entirely when there is nothing to fix or when
 * nothing can be fixed — the offline draft never searched anything, so sending
 * it back to a provider that cannot search is a minute spent for nothing.
 */
async function verifySchedule(
  draft: ItineraryDraft,
  plan: Plan,
  provider: LLMProvider,
  partySize: number,
  canRepair: boolean,
): Promise<{ draft: ItineraryDraft; checks: ItineraryChecks }> {
  const found = problemsIn(draft, plan);
  const itemsChecked = datedItemCount(draft);

  if (found.length === 0) {
    return {
      draft,
      checks: { itemsChecked, repaired: 0, dropped: 0, unresolved: [] },
    };
  }

  console.warn(
    `[itinerary] ${found.length} scheduling problem(s): ${found.map((issue) => issue.code).join(", ")}`,
  );

  let current = draft;
  if (canRepair) {
    const startedAt = Date.now();
    try {
      const repaired = await provider.json(
        {
          tag: "itinerary",
          system: ITINERARY_REPAIR_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: buildItineraryRepairPrompt(
                draft,
                found.map((issue) => issue.message),
                plan,
                partySize,
              ),
            },
          ],
          maxTokens: ITINERARY_REPAIR_MAX_TOKENS,
          // No `webSearch`. Every problem this pass is handed is a comparison
          // between fields already in the draft — an item's own posted hours,
          // or the flight times above it — so the second call is re-timing
          // what the first one found rather than discovering anything. The
          // searches were pure latency on the slowest screen in the product.
          timeoutMs: itineraryTimeoutMs(),
          context: { ...tripFromOffer(plan.offer), dates: plan.offer.dates },
        },
        itineraryDraftSchema,
      );
      console.info(`[itinerary] repair pass in ${Date.now() - startedAt}ms`);
      // A repair that came back empty is not a repair. Keep the original.
      if (repaired.value.days.length > 0) current = repaired.value;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        `[itinerary] the repair pass failed after ${Date.now() - startedAt}ms, keeping the draft: ${detail}`,
      );
    }
  }

  const remaining = problemsIn(current, plan);
  const { draft: cleaned, dropped } = applyUnresolved(current, remaining);

  return {
    draft: cleaned,
    checks: {
      itemsChecked: datedItemCount(current),
      repaired: Math.max(0, found.length - remaining.length),
      dropped,
      // Only what a person can still act on: the rows that were dropped or
      // blanked are already gone from the page, so what is left to say is the
      // trip-wide problems nothing could fix.
      unresolved: remaining
        .filter((issue) => issue.day === null)
        .map((issue) => issue.message),
    },
  };
}

/**
 * The whole build, from an agreed plan to a printable document.
 *
 * Never throws. A failure anywhere above the canned draft lands on the canned
 * draft, which is then put through exactly the same verification and arithmetic
 * — so the offline document is not a different code path, only a different
 * starting sentence.
 */
export async function buildItinerary(
  plan: Plan,
  provider: LLMProvider = getProvider(),
): Promise<Itinerary> {
  const request = {
    tag: "itinerary" as const,
    system: ITINERARY_SYSTEM_PROMPT,
    messages: [
      { role: "user" as const, content: buildItineraryUserPrompt(plan, PARTICIPANT_IDS.length) },
    ],
    maxTokens: ITINERARY_MAX_TOKENS,
    webSearch: { maxUses: ITINERARY_MAX_SEARCHES },
    // Eight searches and a whole document do not fit in the 20s every other
    // call gets; with that ceiling this call never once came back in time.
    timeoutMs: itineraryTimeoutMs(),
    // Doubles as the offline provider's brief: these are the fields it builds
    // the canned days out of, so a keyless run still gets this trip's document.
    context: { ...tripFromOffer(plan.offer), dates: plan.offer.dates },
  };

  // The three numbers behind "BUILDING YOUR ITINERARY", measured rather than
  // guessed at: the model call, the schedule check and its one repair, and the
  // link and photo fetches. Which of the three is the wait is not something
  // anybody can tell by watching the bar, and every tuning decision in this
  // file and in `prompt.ts` is an argument about one of them.
  const startedAt = Date.now();
  let modelMs = 0;
  let scheduleMs = 0;

  const report = (outcome: string): void => {
    const total = Date.now() - startedAt;
    console.info(
      `[itinerary] ${outcome} in ${total}ms: ${modelMs}ms model, ${scheduleMs}ms schedule check, ${total - modelMs - scheduleMs}ms links and photos`,
    );
  };

  try {
    const result = await provider.json(request, itineraryDraftSchema);
    modelMs = Date.now() - startedAt;
    if (result.value.days.length === 0) throw new Error("itinerary came back with no days");
    // `provider.live` says a key is set, not that the model answered *this*
    // call: `ResilientProvider` catches a timeout and quietly hands back the
    // canned draft under the same live-looking provider. The offline answer
    // reports no tokens, so that is what the badge is read from — otherwise the
    // page prints "BUILT FROM LIVE SEARCH" over days nothing searched for.
    const answered = result.usage.inputTokens > 0 || result.usage.outputTokens > 0;
    const live = provider.live && answered;

    const checkedAt = Date.now();
    const verified = await verifySchedule(
      result.value,
      plan,
      provider,
      PARTICIPANT_IDS.length,
      live,
    );
    scheduleMs = Date.now() - checkedAt;

    const built = await assemble(verified.draft, plan, live, verified.checks);
    report(live ? "built live" : "built from the canned days");
    return built;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[itinerary] falling back to the canned days: ${detail}`);
    // The canned draft goes through the same check — it has clock times too,
    // and the flight-time promise is exactly the thing it could get wrong —
    // but there is nothing to repair it with, so it is checked and cleaned only.
    const canned = cannedItinerary(tripFromOffer(plan.offer));
    const checkedAt = Date.now();
    const verified = await verifySchedule(canned, plan, provider, PARTICIPANT_IDS.length, false);
    scheduleMs = Date.now() - checkedAt;

    const built = await assemble(verified.draft, plan, false, verified.checks);
    report("fell back to the canned days");
    return built;
  }
}
