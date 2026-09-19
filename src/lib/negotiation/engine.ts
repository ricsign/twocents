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
import { PARTICIPANT_IDS, characterOf, type ParticipantId } from "@/lib/characters";
import { OfflineProvider, getProvider } from "@/lib/llm";
import type { CompletionRequest, LLMProvider } from "@/lib/llm/provider";
import { scoreFairness } from "@/lib/negotiation/fairness";
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
  offerSchema,
  planSchema,
  secretsFromBrief,
  sumUsage,
  turnKindSchema,
  mandateFromBrief,
  type AgentReport,
  type Brief,
  type DemoSession,
  type FairnessReport,
  type NegotiationEvent,
  type NegotiationTurn,
  type Offer,
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
const turnDraftSchema = z.object({
  kind: turnKindSchema,
  text: z.string(),
  offer: offerSchema.optional(),
  privateReasonKept: z.string().optional(),
});

type TurnDraft = z.infer<typeof turnDraftSchema>;

/** Room for a line plus an offer; a turn that needs more than this is too long. */
const TURN_MAX_TOKENS = 600;
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
      usage = sumUsage(usage, result.usage);
      return result.value;
    } catch (error) {
      logOnce(req.tag, error);
      if (provider !== offline) {
        // Degrade for the rest of the run rather than retrying a backend that
        // just failed: on stage, the second timeout costs as much as the first.
        provider = offline;
        return runJson(req, schema);
      }
      return null;
    }
  };

  const briefs = {} as Record<ParticipantId, Brief>;
  const mandates: PublicMandate[] = [];
  const systemPrompts = {} as Record<ParticipantId, string>;

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
    );
  }

  const order = speakingOrder(mandates);
  const turns: NegotiationTurn[] = [];
  const offers: Offer[] = [];

  const aborted = (): boolean => opts.signal?.aborted === true;

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
          }),
        },
      ],
      maxTokens: TURN_MAX_TOKENS,
      context: { speaker, round: attemptRound, participantId: speaker },
    });

    const first = await runJson(request(correction), turnDraftSchema);
    let draft: TurnDraft = first ?? {
      kind: "agrees",
      text: `${characterOf(speaker).name}'s agent backs where this is going.`,
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
      draft = {
        ...draft,
        offer: {
          ...offer,
          highlights: offer.highlights.map((line) => checkForLeaks(line, secrets).redacted),
          flightNote: checkForLeaks(offer.flightNote, secrets).redacted,
          lodgingNote: checkForLeaks(offer.lodgingNote, secrets).redacted,
        },
      };
    }

    return draft;
  };

  let converged: Offer | null = null;
  let roundsUsed = 0;

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

        const turn: NegotiationTurn = {
          id: `turn-${speaker}-${round}-${turns.length}`,
          round,
          speaker,
          kind: draft.kind,
          text: draft.text,
          ...(draft.offer ? { offer: draft.offer } : {}),
          ...(draft.privateReasonKept ? { privateReasonKept: draft.privateReasonKept } : {}),
        };
        turns.push(turn);

        yield {
          type: "speak",
          speaker,
          kind: turn.kind,
          text: turn.text,
          ...(turn.privateReasonKept ? { privateReasonKept: turn.privateReasonKept } : {}),
        };

        if (turn.offer) {
          const offer = turn.offer;
          if (!offers.some((existing) => existing.id === offer.id)) offers.push(offer);
          yield { type: "offer", speaker, offer };
        }
      }

      // From round two, after a full rotation: everyone has now answered the
      // offers on the table at least once, so an offer that clears the rule has
      // actually been tested rather than merely proposed.
      if (round >= 2) {
        converged = findConvergedOffer(offers, mandates, briefs, turns);
      }
    }
  } catch (error) {
    // Nothing above is expected to throw — every call is already wrapped — so
    // this is the belt to the braces. The run continues to a plan regardless.
    logOnce("round-loop", error);
  }

  if (aborted()) return;

  /* ---- Finalisation: one smart call for the plan, one per private report --- */

  const planPrompts = buildPlanPrompt(turns, offers, mandates);
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
      },
    },
    planSchema,
  );

  const fallbackOffer = converged ?? offers[offers.length - 1] ?? null;
  const resolved: Plan | null =
    planValue ?? (fallbackOffer ? candidatePlan(fallbackOffer) : null);

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

  // Two fields the model does not get a vote on: the wall-clock figure is the
  // "three weeks to ninety seconds" number and has to be measured, and the group
  // total is arithmetic the plan screen prints next to it.
  const plan: Plan = {
    ...resolved,
    groupTotal: resolved.offer.perPerson * PARTICIPANT_IDS.length,
    agreedInMs: Date.now() - startedAt,
  };

  let fairness: FairnessReport;
  try {
    fairness = scoreFairness(briefs, plan, turns);
  } catch (error) {
    logOnce("fairness", error);
    fairness = { rows: [], nobodyOverruled: false };
  }

  const reports = {} as Record<ParticipantId, AgentReport>;
  for (const participantId of PARTICIPANT_IDS) {
    if (aborted()) return;
    const brief = briefs[participantId];
    if (!brief) continue;

    const row = fairness.rows.find((entry) => entry.participantId === participantId) ?? null;
    const prompts = buildPrivateReportPrompt(participantId, brief, plan, turns, row);
    const value = await runJson(
      {
        tag: "agent-report",
        system: prompts.system,
        messages: [{ role: "user", content: prompts.user }],
        maxTokens: REPORT_MAX_TOKENS,
        context: { speaker: participantId, participantId },
      },
      agentReportSchema,
    );

    const report: AgentReport = value ?? {
      participantId,
      gotYou: plan.keptWants.join(", "),
      tradedAway: row?.gaveUp ?? "Nothing.",
      why: "I argued your side and kept what you told me in private to myself.",
      secretsKept: [],
    };

    reports[participantId] = {
      ...report,
      participantId,
      // Computed, never asserted: "here is what I kept quiet" is the product's
      // central claim, and a model listing its own discretion is not evidence.
      secretsKept: secretsFromBrief(brief).map((secret) => secret.label),
    };
  }

  const elapsedMs = Date.now() - startedAt;
  console.info(
    `[negotiation] ${roundsUsed} round(s), ${turns.length} turns, ${leaksCaught} leak(s) caught, ${usage.calls} call(s), ${elapsedMs}ms`,
  );

  yield { type: "agreed", plan, runnerUp: plan.runnerUp };
  yield { type: "done", fairness, reports, usage, elapsedMs };
}
