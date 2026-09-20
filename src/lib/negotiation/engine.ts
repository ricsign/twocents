/**
 * The round loop: four agents, capped rounds, one plan.
 *
 * This module is the middle of the product. Everything upstream of it (briefs,
 * personalities, mandates) exists to feed it, and everything downstream (the
 * plan screen, the fairness meter, the private reports) exists to render what it
 * produced. Three properties it is built around:
 *
 * - **The secret guard is not optional.** Every generated public line goes
 *   through `checkForLeaks` against its own speaker's secrets before it can
 *   become a `speak` event. There is no path from a model response to the wire
 *   that skips it — not the happy path, not the retry, not the fallback.
 * - **Convergence is arithmetic, not another model call.** See
 *   `findConvergedOffer` below.
 * - **It never throws.** The demo has to reach a plan in front of a judge even
 *   if the key is wrong, the network is out and the model returns garbage. Every
 *   call is wrapped, every failure degrades to the offline provider, and the
 *   generator always ends in a `done` event.
 *
 * Server-only. No React, no DOM.
 */

import { z } from "zod";
import {
  PARTICIPANT_IDS,
  displayNameFor,
  type DisplayNames,
  type ParticipantId,
} from "@/lib/characters";
import { OfflineProvider, getProvider } from "@/lib/llm";
import type { CompletionRequest, LLMProvider } from "@/lib/llm/provider";
import type { OfflineHints, OfflinePersonHint } from "@/lib/llm/scenario";
import { SEED_SCENARIO_ID, isSeedScenario } from "@/lib/seed";
import { scoreFairness } from "@/lib/negotiation/fairness";
import {
  UNCHECKED,
  buildFeasibilityRequest,
  sourcedFrom,
  webSearchEnabled,
} from "@/lib/negotiation/feasibility";
import {
  buildNegotiationUserPrompt,
  buildPlanPrompt,
  buildPrivateReportPrompt,
  buildPublicSystemPrompt,
} from "@/lib/negotiation/prompts";
import { checkForLeaks, leakInstruction } from "@/lib/negotiation/redaction";
import {
  EMPTY_USAGE,
  NEGOTIATION_ROUND_CAP,
  agentReportSchema,
  offerFeasibilitySchema,
  offerSchema,
  planSchema,
  secretsFromBrief,
  sumUsage,
  turnKindSchema,
  displayNamesOf,
  mandateFromBrief,
  type AgentReport,
  type Brief,
  type DemoSession,
  type FairnessReport,
  type NegotiationEvent,
  type NegotiationTurn,
  type Offer,
  type OfferFeasibility,
  type Plan,
  type PriceStance,
  type PublicMandate,
  type Usage,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Options and the per-turn schema                                             */
/* -------------------------------------------------------------------------- */

export interface NegotiationRunOptions {
  session: DemoSession;
  provider?: LLMProvider;
  roundCap?: number;
  signal?: AbortSignal;
}

/**
 * What one agent returns for one turn.
 *
 * Narrower than `negotiationTurnSchema`: the id, the round and the speaker are
 * facts the engine already knows, and asking a model to restate them is tokens
 * spent on something it can get wrong.
 */
/**
 * The offer as its proposer describes it: the trip, and nothing about the
 * bookkeeping around it.
 *
 * `id`, `proposedBy` and `feasibility` are cut out of what the model is asked
 * for, because all three are things the engine knows and it knows them better.
 * The id is generated here, `proposedBy` is whoever is speaking, and the
 * feasibility verdict is overwritten by the web check a few lines below no
 * matter what arrives. Asking for them anyway cost three ways: a wrong
 * `proposedBy` — a display name, or the agent naming whoever it was answering
 * — failed the whole draft against this schema, and a failed draft silently
 * becomes an offline one, so a live room kept putting canned template options
 * on the table. It also spent output tokens inside a tight cap on fields that
 * were discarded.
 */
const offerDraftSchema = offerSchema
  .omit({ proposedBy: true, feasibility: true })
  .partial({ id: true });

/**
 * The plan as the model writes it.
 *
 * Same cut as `offerDraftSchema`, and for the same reason: the final call was
 * failing its own schema on `offer.proposedBy` and falling back to the offline
 * script, so a live negotiation ended on a canned plan. Whose option won is
 * something the engine can look up — it has every offer that was put on the
 * table — and `groupTotal` and `agreedInMs` are overwritten below regardless.
 */
const planDraftSchema = planSchema.extend({
  offer: offerDraftSchema,
  runnerUp: offerDraftSchema.nullable(),
  groupTotal: z.number().optional(),
  agreedInMs: z.number().optional(),
});

const turnDraftSchema = z.object({
  kind: turnKindSchema,
  text: z.string(),
  offer: offerDraftSchema.optional(),
  privateReasonKept: z.string().optional(),
});

/** What the model emits. */
type TurnDraftRaw = z.infer<typeof turnDraftSchema>;

/** What `generateLine` hands back: the same line, with a finished offer. */
type TurnDraft = Omit<TurnDraftRaw, "offer"> & { offer?: Offer };

/**
 * Room for a line plus an offer.
 *
 * Sized for the whole emit, not for the sentence. A turn that proposes
 * something carries eight more fields than one that does not, and a cap that
 * only fits the prose truncates the tool call mid-object — which arrives as a
 * schema failure, which falls back to the offline script. The room then reads
 * as scripted at exactly the moments it is doing the most interesting thing.
 */
const TURN_MAX_TOKENS = 1200;
const PLAN_MAX_TOKENS = 900;
const REPORT_MAX_TOKENS = 500;

/* -------------------------------------------------------------------------- */
/* Convergence: the deterministic part                                         */
/* -------------------------------------------------------------------------- */

/**
 * The most a person with this public stance can be asked to pay, per person.
 *
 * Derived from `PRICE_STANCE_BANDS` rather than restating it: the stance is the
 * sayable form of a ceiling, so the ceiling of a stance is the top of the band
 * it came from. "Happy to splurge" has no ceiling worth modelling.
 */
const STANCE_CEILING: Record<PriceStance, number> = {
  "must be cheap": 850,
  "prefers value": 1500,
  flexible: 2600,
  "happy to splurge": Number.POSITIVE_INFINITY,
};

/** Who opens: the agent with the most room on money puts the first option up. */
const STANCE_RANK: Record<PriceStance, number> = {
  "must be cheap": 0,
  "prefers value": 1,
  flexible: 2,
  "happy to splurge": 3,
};

const NEGATION_WORDS = new Set([
  "no", "not", "nothing", "never", "none", "without", "avoid", "skip", "cant",
  "dont", "wont",
]);

const DEALBREAKER_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "any",
  "all", "with", "that", "this", "too", "very", "be", "is", "are", "my", "our",
]);

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;

/** Clock times in a sentence, as minutes past midnight. */
function timesIn(text: string): number[] {
  const out: number[] = [];
  TIME_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TIME_RE.exec(text)) !== null) {
    const rawHour = Number(match[1]);
    const minutes = match[2] ? Number(match[2]) : 0;
    const meridiem = (match[3] ?? "").toLowerCase();
    const hour = meridiem === "pm" ? (rawHour % 12) + 12 : rawHour % 12;
    out.push(hour * 60 + minutes);
  }
  return out;
}

function isNegated(clause: string): boolean {
  return clause
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((token) => NEGATION_WORDS.has(token));
}

/** The one concrete noun in a short prohibition: "No hostels" -> "hostel". */
function headNoun(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((token) => !NEGATION_WORDS.has(token))
    .filter((token) => !DEALBREAKER_STOP_WORDS.has(token))
    .filter((token) => !/^\d/.test(token));

  let best: string | null = null;
  for (const token of tokens) {
    if (best === null || token.length > best.length) best = token;
  }
  if (best === null) return null;
  return best.length > 3 && best.endsWith("s") ? best.slice(0, -1) : best;
}

/** Every sentence an offer asserts about itself. */
function offerClauses(offer: Offer): string[] {
  return [
    offer.destination,
    offer.region,
    offer.flightNote,
    offer.lodgingNote,
    ...offer.highlights,
  ]
    .flatMap((sentence) => sentence.split(/[,.;·—]+/))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

/**
 * Whether this offer plainly breaks a hard no.
 *
 * Deliberately narrow: it flags only a contradiction it can actually
 * demonstrate, and treats anything it cannot read as "no violation". The bias is
 * asymmetric on purpose — a false positive here makes agreement unreachable, the
 * round cap runs out and the room never converges, which is a worse failure on
 * stage than converging on a plan with one soft edge. The honest, exhaustive
 * check is `scoreFairness`, which runs on the candidate plan a moment later and
 * has the last word.
 *
 * Two shapes are readable:
 *
 * - **A time prohibition** ("no flights before 8am"). The offer's flight note is
 *   read as either a point ("6am departure", violates) or a promise ("nothing
 *   leaves before 11am", which clears an 8am floor and does not).
 * - **A forbidden thing** ("no hostels"). The noun has to appear in a clause the
 *   offer actually asserts — a negated clause like "No passports needed" is the
 *   offer agreeing with the prohibition, not breaking it, so those are skipped.
 */
export function violatesDealbreaker(offer: Offer, dealbreaker: string): boolean {
  const text = dealbreaker.trim();
  if (!text || !isNegated(text)) return false;

  const forbiddenTimes = timesIn(text);
  const lowered = text.toLowerCase();

  if (forbiddenTimes.length > 0 && /\bbefore\b/.test(lowered)) {
    const threshold = forbiddenTimes[0] as number;
    const note = offer.flightNote;
    const noteTimes = timesIn(note);
    if (noteTimes.length === 0) return false;
    // "nothing leaves before 11am" promises a floor; a bare "6am departure"
    // asserts a point. Either way the earliest time the offer admits to is what
    // has to clear the threshold.
    return Math.min(...noteTimes) < threshold;
  }

  if (forbiddenTimes.length > 0 && /\bafter\b/.test(lowered)) {
    const threshold = forbiddenTimes[0] as number;
    const noteTimes = timesIn(offer.flightNote);
    if (noteTimes.length === 0) return false;
    if (isNegated(offer.flightNote)) return false;
    return Math.max(...noteTimes) > threshold;
  }

  const noun = headNoun(text);
  if (!noun) return false;
  return offerClauses(offer).some(
    (clause) => !isNegated(clause) && clause.toLowerCase().includes(noun),
  );
}

/**
 * The convergence rule, in full.
 *
 * An offer is accepted when three things hold at once:
 *
 * 1. its per-person price is at or under every participant's *public* price
 *    stance ceiling — the stance, not the brief, because this is the same
 *    information the agents themselves argued from;
 * 2. it plainly violates nobody's hard dealbreaker; and
 * 3. `scoreFairness` on a candidate plan built from it reports
 *    `nobodyOverruled` — which is where the real private ceilings finally get a
 *    vote, since a plan that breaks somebody's actual number can never be
 *    agreement no matter what the room said.
 *
 * This is arithmetic rather than a sixth model call per round, and that is the
 * point. A model asked "have they converged?" is a coin weighted by the last
 * thing said, so the same transcript can end at round two or run to the cap —
 * and the demo reruns this negotiation live, with one slider changed, and claims
 * the *slider* caused the difference. It can only claim that if everything else
 * is deterministic. It is also four fewer expensive calls per run, and a check
 * we can print on a slide.
 */
function findConvergedOffer(
  offers: readonly Offer[],
  mandates: readonly PublicMandate[],
  briefs: Record<ParticipantId, Brief>,
  turns: readonly NegotiationTurn[],
): Offer | null {
  if (offers.length === 0) return null;

  const stanceCeiling = mandates.reduce(
    (lowest, mandate) => Math.min(lowest, STANCE_CEILING[mandate.priceStance]),
    Number.POSITIVE_INFINITY,
  );

  // Most recent first: the room converges on where it just got to, not on the
  // opening bid it spent four rounds arguing down.
  for (let i = offers.length - 1; i >= 0; i -= 1) {
    const offer = offers[i] as Offer;

    if (offer.perPerson > stanceCeiling) continue;

    // A price the web says does not exist is not something the room gets to
    // settle on, however enthusiastically it agreed.
    if (offer.feasibility?.bookable === false) continue;

    const breaksSomething = PARTICIPANT_IDS.some((participantId) => {
      const brief = briefs[participantId];
      return brief
        ? brief.dealbreakers.some((line) => violatesDealbreaker(offer, line))
        : false;
    });
    if (breaksSomething) continue;

    // `scoreFairness` takes a mutable array; the copy keeps this function's
    // own contract read-only.
    if (!scoreFairness(briefs, candidatePlan(offer), [...turns]).nobodyOverruled) continue;

    return offer;
  }

  return null;
}

/**
 * Whether the rotation that just finished was the whole table assenting.
 *
 * Read off the transcript rather than tracked in a flag, so it stays a function
 * of what was actually said — the same property `findConvergedOffer` has, and
 * the reason two runs of one session behave identically.
 */
function roomAssented(turns: readonly NegotiationTurn[], roomSize: number): boolean {
  if (roomSize === 0 || turns.length < roomSize) return false;
  return turns.slice(-roomSize).every((turn) => turn.kind === "agrees");
}

/** A plan-shaped view of one offer, for scoring it before anyone has agreed. */
function candidatePlan(offer: Offer): Plan {
  return {
    offer,
    runnerUp: null,
    runnerUpLostBecause: "",
    groupTotal: offer.perPerson * PARTICIPANT_IDS.length,
    keptWants: offer.highlights,
    agreedInMs: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Speaking order                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Who talks when.
 *
 * The agent with the most room on money opens, because somebody has to put the
 * first number on the table and the expensive option is the one the room has to
 * argue *down* — start at the cheap end and there is nothing to negotiate. The
 * rest follow in the fixed roster order so two runs of the same session produce
 * the same rotation.
 *
 * Note what this reads: `priceStance`, the public posture, never the private
 * ceiling. Even the turn order is built from sayable information.
 */
function speakingOrder(mandates: readonly PublicMandate[]): ParticipantId[] {
  let opener: PublicMandate | null = null;
  for (const mandate of mandates) {
    if (opener === null || STANCE_RANK[mandate.priceStance] > STANCE_RANK[opener.priceStance]) {
      opener = mandate;
    }
  }
  const first = opener?.participantId ?? PARTICIPANT_IDS[0];
  return [first, ...PARTICIPANT_IDS.filter((id) => id !== first)];
}

/* -------------------------------------------------------------------------- */
/* Offline hints                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What the offline provider needs to generate a run over *this* session rather
 * than replay the grad trip.
 *
 * Two things about it are worth being explicit, because it is the one place in
 * this file that touches a private ceiling outside a private report:
 *
 * - **It never reaches a model.** `CompletionRequest.context` is read only by
 *   `OfflineProvider`; `AnthropicProvider` ignores the field entirely and never
 *   serializes it into a message. It is an offline side channel, not a prompt.
 * - **It never becomes a public line either.** The generator uses the ceilings
 *   to choose a price the room can actually agree on, and every figure it puts
 *   in an agent's mouth is pushed clear of every ceiling's proximity window
 *   first. The guard below still scans; it simply has nothing to find.
 *
 * `scenarioId` is the switch that keeps the seeded run byte-identical: when it
 * is set, the provider replays the script and ignores everything else here.
 */
function buildOfflineHints(
  session: DemoSession,
  briefs: Record<ParticipantId, Brief>,
  mandates: readonly PublicMandate[],
  names: DisplayNames,
): Omit<OfflineHints, "offerIds" | "spokenCount" | "attempt"> {
  const people: OfflinePersonHint[] = [];
  for (const participantId of PARTICIPANT_IDS) {
    const brief = briefs[participantId];
    if (!brief) continue;
    people.push({
      participantId,
      name: displayNameFor(names, participantId),
      want: brief.destinationWant,
      wants: brief.wants,
      ceiling: brief.budgetCeiling,
    });
  }

  const priceCap = mandates.reduce(
    (lowest, mandate) => Math.min(lowest, STANCE_CEILING[mandate.priceStance]),
    Number.POSITIVE_INFINITY,
  );

  // When the trip happens, taken from whoever actually said so rather than
  // from seat zero. Seat zero is always the person at the keyboard, and their
  // brief is empty until they type something — so reading both fields off
  // them put a blank on every offer card in a room where three other people
  // had stated the dates. First non-empty wins, in roster order, because the
  // four briefs are for one shared trip and disagreement between them is not
  // a thing this module is entitled to resolve.
  let when = "";
  let nights: number | null = null;
  for (const person of people) {
    const brief = briefs[person.participantId];
    if (!brief) continue;
    if (when.length === 0 && brief.dates.trim().length > 0) when = brief.dates;
    if (nights === null && brief.nights !== null) nights = brief.nights;
  }

  return {
    scenarioId: isSeedScenario(session) ? SEED_SCENARIO_ID : null,
    topic: session.tripName,
    when,
    nights,
    priceCap,
    people,
  };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Streams one whole negotiation.
 *
 * Never throws. Every await is wrapped, a failed call switches the run to the
 * offline provider and retries once, and the finalisation block runs on a
 * provider that cannot fail — so the last thing this generator does is always to
 * yield `done`.
 */
export async function* runNegotiation(
  opts: NegotiationRunOptions,
): AsyncGenerator<NegotiationEvent, void, undefined> {
  const startedAt = Date.now();
  const roundCap = Math.max(1, Math.trunc(opts.roundCap ?? NEGOTIATION_ROUND_CAP));
  const offline = new OfflineProvider();

  let provider: LLMProvider = opts.provider ?? getProvider();
  let usage: Usage = { ...EMPTY_USAGE };
  let leaksCaught = 0;

  /**
   * Folds one call's usage into the run's total.
   *
   * A helper rather than `usage = sumUsage(usage, …)` written out at each call
   * site, because the private reports below now run concurrently. The
   * assignment is one synchronous statement either way, so no count is lost
   * today — but that is a property of each call site rather than of the
   * accumulator, and the figure it feeds is the cost the plan screen prints.
   * One place to read, one place to get wrong.
   */
  const addUsage = (delta: Usage): void => {
    usage = sumUsage(usage, delta);
  };

  const loggedFailures = new Set<string>();
  /** One line per distinct failure. A stage log nobody can read is noise. */
  const logOnce = (tag: string, error: unknown): void => {
    if (loggedFailures.has(tag)) return;
    loggedFailures.add(tag);
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[negotiation] ${tag} failed, continuing offline: ${detail}`);
  };

  /**
   * One model call. Returns null only if even the offline provider refused,
   * which it is written never to do; callers still handle null, because "never"
   * is not a thing to bet a demo on.
   */
  const runJson = async <T>(
    req: CompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<T | null> => {
    try {
      const result = await provider.json(req, schema);
      addUsage(result.usage);
      return result.value;
    } catch (error) {
      logOnce(req.tag, error);
      if (provider !== offline) {
        // Degrade for the rest of the run rather than retrying a backend that
        // just failed: on stage, the second timeout costs as much as the first.
        // Safe under the concurrent report calls below: the retry re-reads
        // `provider` on entry, so a caller that set it and a caller that was
        // already in flight both end up on the offline provider, and setting
        // it twice is setting it once.
        provider = offline;
        return runJson(req, schema);
      }
      return null;
    }
  };

  /**
   * Sends one offer to the web and returns what came back.
   *
   * Deliberately not routed through `runJson`: that degrades the whole run to
   * the script on any failure, which is right for a turn the room is waiting on
   * and wrong here. A search that fails should cost this one offer its live
   * verdict, not cost the remaining rounds their live agents — so the failure
   * is caught here and answered from the canned prices instead.
   */
  const checkOffer = async (offer: Offer): Promise<OfferFeasibility> => {
    if (!webSearchEnabled()) return UNCHECKED;
    const request = buildFeasibilityRequest(offer);

    const startedAt = Date.now();
    try {
      const result = await provider.json(request, offerFeasibilitySchema);
      addUsage(result.usage);
      // What one search actually costs the run, per offer. Printed because the
      // whole point of making this call non-blocking is a wall-clock claim,
      // and a claim nobody can read the number behind is a guess.
      console.info(`[negotiation] offer-check ${offer.id} in ${Date.now() - startedAt}ms`);
      // The pages come from the call, not from the model's answer: `sources` is
      // what it says it read, `links` is what it actually opened.
      return { ...result.value, links: result.sources };
    } catch (error) {
      logOnce("offer-check", error);
      // Timed here too: a check that gave up at its deadline is the expensive
      // case, and the one worth being able to see in the log.
      console.info(
        `[negotiation] offer-check ${offer.id} gave up after ${Date.now() - startedAt}ms`,
      );
      try {
        const canned = await offline.json(request, offerFeasibilitySchema);
        return canned.value;
      } catch {
        return UNCHECKED;
      }
    }
  };

  const briefs = {} as Record<ParticipantId, Brief>;
  const mandates: PublicMandate[] = [];
  const systemPrompts = {} as Record<ParticipantId, string>;
  // Read once for the whole run, so every prompt, every generated line and the
  // name tag above the sprite are answering from the same map.
  const names = displayNamesOf(opts.session);

  for (const participantId of PARTICIPANT_IDS) {
    const state = opts.session.participants[participantId];
    if (!state) continue;
    briefs[participantId] = state.brief;
    mandates.push(mandateFromBrief(state.brief, state.personality));
  }
  for (const participantId of PARTICIPANT_IDS) {
    const state = opts.session.participants[participantId];
    const mandate = mandates.find((entry) => entry.participantId === participantId);
    if (!state || !mandate) continue;
    systemPrompts[participantId] = buildPublicSystemPrompt(
      participantId,
      mandate,
      state.personality,
      mandates,
      names,
    );
  }

  const order = speakingOrder(mandates);
  const turns: NegotiationTurn[] = [];
  const offers: Offer[] = [];

  const offlineBase = buildOfflineHints(opts.session, briefs, mandates, names);
  /** The table as it stands, for the offline generator's beat selection. */
  const offlineHints = (speaker: ParticipantId, attempt: number): OfflineHints => ({
    ...offlineBase,
    offerIds: offers.map((offer) => offer.id),
    spokenCount: turns.filter((turn) => turn.speaker === speaker).length,
    attempt,
  });

  const aborted = (): boolean => opts.signal?.aborted === true;

  /** Makes each generated offer id unique inside one run. */
  let offersProposed = 0;

  /* ---- The price checks, in flight ---------------------------------------- */

  /**
   * The checks that have not answered yet, by offer id.
   *
   * The room used to await one of these before it would let the offer be
   * spoken, which meant every proposal froze the town for the length of a web
   * search — four agents over five rounds, and it was the longest thing on
   * screen by some distance. The offer now hits the table immediately and its
   * check runs beside the negotiation.
   *
   * What the engine still owes is that no verdict is lost. `findConvergedOffer`
   * reads `feasibility?.bookable !== false` and the stored transcript rows
   * carry `sourced`, so the outstanding checks are joined once per round —
   * after the rotation, before convergence is decided — which is the last
   * moment at which a verdict can still change the answer.
   */
  const pendingChecks = new Map<string, Promise<void>>();

  /** Verdicts that have landed and not yet been yielded to the caller. */
  const landedChecks: Extract<NegotiationEvent, { type: "offer-checked" }>[] = [];

  /**
   * Every verdict that has come back, by offer id.
   *
   * The arrays below are not enough on their own, because a check can answer
   * while its own line is still being generated — a repeat nudge is a second
   * model call, and the offline provider answers in microseconds — and at that
   * moment the offer is in neither `offers` nor `turns` for `applyCheck` to
   * find. This map is what the round loop reads to catch up a verdict that
   * arrived before the thing it belongs to existed, which makes the whole
   * mechanism independent of which of the two lands first.
   */
  const verdicts = new Map<string, OfferFeasibility>();

  /**
   * Writes a verdict onto the offer and the turn that carry it.
   *
   * Both arrays are rewritten in place rather than the objects mutated: the
   * offers list is what `buildNegotiationUserPrompt` formats for the next
   * agent, so a verdict landing mid-round reaches the rest of the table the
   * same way it always did, and the turn is what the route reads back.
   */
  const applyCheck = (offerId: string, feasibility: OfferFeasibility): void => {
    verdicts.set(offerId, feasibility);
    const sourced = sourcedFrom(feasibility);

    for (let i = 0; i < offers.length; i += 1) {
      const offer = offers[i];
      if (offer && offer.id === offerId) offers[i] = { ...offer, feasibility };
    }

    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i];
      const offer = turn?.offer;
      if (!turn || !offer || offer.id !== offerId) continue;
      turns[i] = {
        ...turn,
        offer: { ...offer, feasibility },
        ...(sourced ? { sourced } : {}),
      };
    }
  };

  /** Starts one check and queues its verdict for the next drain. */
  const startCheck = (offer: Offer): void => {
    const settled = checkOffer(offer).then((feasibility) => {
      applyCheck(offer.id, feasibility);
      const sourced = sourcedFrom(feasibility);
      landedChecks.push({
        type: "offer-checked",
        offerId: offer.id,
        feasibility,
        ...(sourced ? { sourced } : {}),
      });
      pendingChecks.delete(offer.id);
    });
    pendingChecks.set(offer.id, settled);
  };

  /** Every verdict that has landed since the last drain, as frames. */
  function* drainChecks(): Generator<NegotiationEvent, void, undefined> {
    while (landedChecks.length > 0) {
      const landed = landedChecks.shift();
      if (landed) yield landed;
    }
  }

  /**
   * Joins every outstanding check.
   *
   * `checkOffer` never rejects — it answers `UNCHECKED` rather than throwing —
   * so this settles on the slowest deadline and nothing else.
   */
  const joinChecks = async (): Promise<void> => {
    if (pendingChecks.size === 0) return;
    await Promise.all([...pendingChecks.values()]);
  };

  /**
   * Generates one public line and guarantees it is safe to say.
   *
   * `attemptRound` is what the prompt and the offline script are told the round
   * is. It advances on a repeat so a retry lands on the next beat instead of
   * regenerating the sentence that was just rejected.
   */
  const generateLine = async (
    speaker: ParticipantId,
    round: number,
    attemptRound: number,
    correction: string | undefined,
  ): Promise<TurnDraft> => {
    const secrets = secretsFromBrief(briefs[speaker] as Brief);
    const system = systemPrompts[speaker] ?? "";

    const request = (extra: string | undefined): CompletionRequest => ({
      tag: "negotiation-turn",
      system,
      messages: [
        {
          role: "user",
          content: buildNegotiationUserPrompt({
            round,
            roundCap,
            turns,
            offers,
            leadingOffer: offers.length > 0 ? (offers[offers.length - 1] as Offer) : null,
            correction: extra,
            names,
          }),
        },
      ],
      maxTokens: TURN_MAX_TOKENS,
      context: {
        speaker,
        round: attemptRound,
        participantId: speaker,
        offline: offlineHints(speaker, Math.max(0, attemptRound - round)),
      },
    });

    const first = await runJson(request(correction), turnDraftSchema);
    let draft: TurnDraftRaw = first ?? {
      kind: "agrees",
      text: `${displayNameFor(names, speaker)}'s agent backs where this is going.`,
    };

    // THE GUARANTEE. Every generated line is scanned against its own speaker's
    // secrets before it can become an event. There is no branch above or below
    // this that reaches `speak` without passing through here.
    const leak = checkForLeaks(draft.text, secrets);
    if (!leak.clean) {
      leaksCaught += 1;
      const instruction = leakInstruction(leak.findings, secrets);
      const retryCorrection = correction ? `${correction} ${instruction}` : instruction;
      const retry = await runJson(request(retryCorrection), turnDraftSchema);

      if (retry) {
        const retryLeak = checkForLeaks(retry.text, secrets);
        // One retry, then the redacted line. A second retry would burn the round
        // cap defending a sentence nobody needs; the stand-in reads fine.
        draft = retryLeak.clean ? retry : { ...retry, text: retryLeak.redacted };
      } else {
        draft = { ...draft, text: leak.redacted };
      }
    }

    // An offer's free text goes on a card in the same room, so it gets the same
    // scan. Unconditional and cheap: `checkForLeaks` on a clean string returns
    // it untouched.
    if (draft.offer) {
      const offer = draft.offer;
      const scrubbed: Offer = {
        ...offer,
        // Stamped here rather than asked for: the speaker is this call's own
        // argument, and the id only has to be unique within one run.
        id: offer.id ?? `offer-${speaker}-${attemptRound}-${offersProposed++}`,
        proposedBy: speaker,
        highlights: offer.highlights.map((line) => checkForLeaks(line, secrets).redacted),
        flightNote: checkForLeaks(offer.flightNote, secrets).redacted,
        lodgingNote: checkForLeaks(offer.lodgingNote, secrets).redacted,
      };

      // The check starts here and is not waited on. The offer goes to the
      // table with no `feasibility` at all, which is the honest state of it —
      // nothing has been checked yet — and the verdict is written onto it by
      // `applyCheck` when it lands. Whatever the proposer put in that field is
      // dropped either way: it is the proposer's own opinion of its own price,
      // and the point of the desk is that the web gets the last word on that.
      startCheck(scrubbed);
      return { ...draft, offer: scrubbed };
    }

    return { ...draft, offer: undefined };
  };

  /**
   * Fairness for one candidate plan.
   *
   * Scored twice in a run — once the instant the room settles, once on the
   * written-up plan — and wrapped both times, because it is the claim the plan
   * screen makes out loud and a throw here would cost the frame carrying it.
   */
  const fairnessFor = (candidate: Plan): FairnessReport => {
    try {
      return scoreFairness(briefs, candidate, turns);
    } catch (error) {
      logOnce("fairness", error);
      return { rows: [], nobodyOverruled: false };
    }
  };

  let converged: Offer | null = null;
  let roundsUsed = 0;
  /** When the room settled, measured. Null if it never did. */
  let agreedAtMs: number | null = null;
  /** Whether `agreed` has already gone out, so it goes out exactly once. */
  let announced = false;

  try {
    while (roundsUsed < roundCap && converged === null) {
      if (aborted()) return;
      roundsUsed += 1;
      const round = roundsUsed;

      yield { type: "round", round, of: roundCap };

      for (const speaker of order) {
        if (aborted()) return;

        yield { type: "thinking", speaker };

        let draft = await generateLine(speaker, round, round, undefined);

        // An agent repeating itself verbatim is a stalled negotiation, and on
        // screen it reads as a bug. One nudge, one beat further on.
        const alreadySaid = new Set(
          turns.filter((turn) => turn.speaker === speaker).map((turn) => normalize(turn.text)),
        );
        if (alreadySaid.has(normalize(draft.text))) {
          draft = await generateLine(
            speaker,
            round,
            round + 1,
            "You already made that point in those words. Move the negotiation on: concede something, trade something, or put a new option up.",
          );
        }

        // The desk is usually still working at this point, so an offer
        // normally reaches the table with no verdict on it — that is the
        // whole change, and the `offer-checked` frame is what fills it in.
        // When the verdict did beat the line, it is picked up here instead,
        // because `applyCheck` ran before either array had anything to patch.
        const drafted = draft.offer;
        const early = drafted ? verdicts.get(drafted.id) : undefined;
        const proposed: Offer | undefined =
          drafted && early ? { ...drafted, feasibility: early } : drafted;
        const sourced = early ? sourcedFrom(early) : null;

        const turn: NegotiationTurn = {
          id: `turn-${speaker}-${round}-${turns.length}`,
          round,
          speaker,
          kind: draft.kind,
          text: draft.text,
          ...(proposed ? { offer: proposed } : {}),
          ...(draft.privateReasonKept ? { privateReasonKept: draft.privateReasonKept } : {}),
          ...(sourced ? { sourced } : {}),
        };
        turns.push(turn);
        // Pushed in the same synchronous step as the turn, before the yield
        // below hands control back to the caller: a verdict landing across
        // that suspension has to find both halves or it patches one and
        // leaves the other stale, and `findConvergedOffer` reads this array.
        if (proposed && !offers.some((existing) => existing.id === proposed.id)) {
          offers.push(proposed);
        }

        yield {
          type: "speak",
          speaker,
          kind: turn.kind,
          text: turn.text,
          ...(turn.privateReasonKept ? { privateReasonKept: turn.privateReasonKept } : {}),
        };

        if (proposed) yield { type: "offer", speaker, offer: proposed };

        // Anything the desk answered while this agent was composing. Sent
        // between turns rather than held to the end of the round, so a card
        // fills in close to when it was proposed.
        yield* drainChecks();
      }

      // The join. Every verdict has to be in hand before the two convergence
      // rules below read `feasibility`, and before the transcript rows the
      // route stores are read back, so this is where the round pays for
      // whatever the searches cost — once, for all four of them at their
      // slowest, instead of four times in series.
      await joinChecks();
      yield* drainChecks();

      // From round two, after a full rotation: everyone has now answered the
      // offers on the table at least once, so an offer that clears the rule has
      // actually been tested rather than merely proposed.
      if (round >= 2) {
        converged = findConvergedOffer(offers, mandates, briefs, turns);
      }

      // A room can also settle in a way that rule cannot see: everyone in this
      // rotation said "agrees" and nobody put anything new up. The arithmetic
      // may still be holding out — a stance ceiling or a fairness row can
      // object after the table itself has stopped arguing — but spending the
      // remaining rounds then buys nothing except agents agreeing again, which
      // is both dead screen time and four model calls a round. The offer they
      // are agreeing to is the one they have been talking about: the leading
      // one. If none exists there is nothing to have agreed to, and the loop
      // carries on.
      if (converged === null && roomAssented(turns, order.length)) {
        converged =
          [...offers].reverse().find((offer) => offer.feasibility?.bookable !== false) ?? null;
      }

      // Announced here, from what is already in hand, rather than after the
      // write-up. Between this line and the `done` frame are five large-model
      // calls — the plan prose, then one private report per person — and not
      // one of them changes what the room settled on. Waiting for them left
      // the town visibly finished and the plan unreachable for tens of
      // seconds. `candidatePlan` needs no model and `fairnessFor` is local
      // arithmetic, so the screen has everything it renders from immediately
      // and upgrades to the written-up version when `done` arrives.
      if (converged !== null) {
        agreedAtMs = Date.now() - startedAt;
        const provisional: Plan = { ...candidatePlan(converged), agreedInMs: agreedAtMs };
        yield {
          type: "agreed",
          plan: provisional,
          runnerUp: provisional.runnerUp,
          fairness: fairnessFor(provisional),
        };
        announced = true;
      }
    }
  } catch (error) {
    // Nothing above is expected to throw — every call is already wrapped — so
    // this is the belt to the braces. The run continues to a plan regardless.
    logOnce("round-loop", error);
  }

  if (aborted()) return;

  /* ---- Finalisation: one smart call for the plan, one per private report --- */

  const planPrompts = buildPlanPrompt(turns, offers, mandates, names);
  const planValue = await runJson(
    {
      tag: "final-plan",
      system: planPrompts.system,
      messages: [{ role: "user", content: planPrompts.user }],
      maxTokens: PLAN_MAX_TOKENS,
      context: {
        rounds: roundsUsed,
        convergedOfferId: converged?.id ?? null,
        offers: offers.map((offer) => offer.id),
        offline: offlineHints(order[0] as ParticipantId, 0),
      },
    },
    planDraftSchema,
  );

  /**
   * Puts the bookkeeping back on an offer the model described.
   *
   * It is matched to something already on the table by destination, because a
   * plan is meant to be one of the options the room actually discussed: that
   * recovers the real id, the real proposer and the web check behind it. When
   * nothing matches — the model summarised the compromise into a new name —
   * the offer still stands, credited to whoever the room converged with.
   */
  const settle = (
    draft: z.infer<typeof offerDraftSchema>,
    index: number,
  ): Offer => {
    const same = (a: string, b: string): boolean =>
      a.trim().toLowerCase() === b.trim().toLowerCase();
    const known = offers.find((offer) => same(offer.destination, draft.destination));
    return {
      ...draft,
      id: draft.id ?? known?.id ?? `offer-plan-${index}`,
      proposedBy: known?.proposedBy ?? converged?.proposedBy ?? (order[0] as ParticipantId),
      ...(known?.feasibility ? { feasibility: known.feasibility } : {}),
    };
  };

  const fallbackOffer = converged ?? offers[offers.length - 1] ?? null;
  const resolved: Plan | null = planValue
    ? {
        ...planValue,
        offer: settle(planValue.offer, 0),
        runnerUp: planValue.runnerUp ? settle(planValue.runnerUp, 1) : null,
        groupTotal: planValue.groupTotal ?? 0,
        agreedInMs: planValue.agreedInMs ?? 0,
      }
    : fallbackOffer
      ? candidatePlan(fallbackOffer)
      : null;

  if (!resolved) {
    // No offers, no plan: the room said nothing usable. End the stream honestly
    // rather than inventing a trip.
    console.warn("[negotiation] finished with no plan; emitting an empty result");
    yield {
      type: "done",
      fairness: { rows: [], nobodyOverruled: false },
      reports: {} as Record<ParticipantId, AgentReport>,
      usage,
      elapsedMs: Date.now() - startedAt,
    };
    return;
  }

  // Three fields the model does not get a vote on.
  //
  // The offer, when the room converged, is the one it converged on, whatever
  // the write-up describes: the agreement has already been announced and is on
  // a screen somebody is reading, and this call is prose about that trip, not a
  // second chance to pick a different one. The runner-up, the sentence saying
  // why it lost and the kept wants are still the model's to write.
  //
  // The wall-clock figure is the "three weeks to ninety seconds" number and has
  // to be measured — at the moment the room settled, not at the moment the
  // write-up finished, so it does not climb under a plan screen already showing
  // it. The group total is arithmetic the plan screen prints next to it.
  const agreedOffer = converged ?? resolved.offer;
  const plan: Plan = {
    ...resolved,
    offer: agreedOffer,
    groupTotal: agreedOffer.perPerson * PARTICIPANT_IDS.length,
    agreedInMs: agreedAtMs ?? Date.now() - startedAt,
  };

  const fairness = fairnessFor(plan);

  /**
   * One person's private report. Never rejects.
   *
   * `runJson` already answers null rather than throwing, and the catch is the
   * belt to that brace: these four run concurrently, and one report failing
   * must cost its own card and nothing else — the other three still land and
   * the run still reaches `done`.
   */
  const writeReport = async (
    participantId: ParticipantId,
    brief: Brief,
  ): Promise<AgentReport> => {
    const row = fairness.rows.find((entry) => entry.participantId === participantId) ?? null;
    const prompts = buildPrivateReportPrompt(
      participantId,
      brief,
      plan,
      turns,
      row,
      names,
    );

    let value: AgentReport | null = null;
    try {
      value = await runJson(
        {
          tag: "agent-report",
          system: prompts.system,
          messages: [{ role: "user", content: prompts.user }],
          maxTokens: REPORT_MAX_TOKENS,
          context: {
            speaker: participantId,
            participantId,
            offline: offlineHints(participantId, 0),
          },
        },
        agentReportSchema,
      );
    } catch (error) {
      logOnce("agent-report", error);
    }

    const report: AgentReport = value ?? {
      participantId,
      gotYou: plan.keptWants.join(", "),
      tradedAway: row?.gaveUp ?? "Nothing.",
      why: "I spoke for you at the table and kept what you told me in private to myself.",
      secretsKept: [],
    };

    return {
      ...report,
      participantId,
      // Computed, never asserted: "here is what I kept quiet" is the product's
      // central claim, and a model listing its own discretion is not evidence.
      secretsKept: secretsFromBrief(brief).map((secret) => secret.label),
    };
  };

  if (aborted()) return;

  // Concurrent, because the four reports are independent: each reads one brief,
  // one fairness row and the finished plan, and none reads another's answer.
  // Sequentially they were four large-model round trips end to end, and the
  // person waiting on the fourth is waiting on three answers they cannot see.
  // The record is assembled afterwards in roster order, so the output does not
  // depend on which call came back first.
  const written = await Promise.all(
    PARTICIPANT_IDS.map(async (participantId) => {
      const brief = briefs[participantId];
      return brief === undefined
        ? ([participantId, null] as const)
        : ([participantId, await writeReport(participantId, brief)] as const);
    }),
  );

  const reports = {} as Record<ParticipantId, AgentReport>;
  for (const [participantId, report] of written) {
    if (report) reports[participantId] = report;
  }

  const elapsedMs = Date.now() - startedAt;
  console.info(
    `[negotiation] ${roundsUsed} round(s), ${turns.length} turns, ${leaksCaught} leak(s) caught, ${usage.calls} call(s), ${elapsedMs}ms`,
  );

  // Only when the round cap ran out without the room converging: there was
  // nothing to announce until the write-up made one, so this is the first
  // frame that can honestly call it a plan.
  if (!announced) {
    yield { type: "agreed", plan, runnerUp: plan.runnerUp, fairness };
  }

  yield { type: "done", fairness, reports, usage, elapsedMs, plan, runnerUp: plan.runnerUp };
}
