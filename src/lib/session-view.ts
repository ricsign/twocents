/**
 * The one place a `DemoSession` is narrowed for a human.
 *
 * The session object is the whole demo: four briefs, four real ceilings, four
 * private transcripts and four private reports. That is exactly the shape the
 * negotiation needs and exactly the shape no browser may ever see. Handing it
 * out over HTTP would mean one `curl` returns Maya's $600, Sam's credit card
 * note and Priya's sister's ticket — the product's entire claim, undone by the
 * endpoint that feeds the screen that makes the claim.
 *
 * So the HTTP boundary narrows here, once. `GET /api/session` and every POST
 * response go through `sessionViewFor`, and `planViewFor` is a reshaping of its
 * output rather than a second, parallel idea of what "your view" means. One
 * function, one rule, one thing to audit.
 *
 * IMPORTANT — this narrowing is for the HTTP boundary and nothing else.
 * `runNegotiation` and everything under `lib/negotiation/` legitimately take the
 * full `DemoSession`: the redaction guarantee is *built* on those agents holding
 * the real briefs, deriving a `PublicMandate` from each and scanning every
 * generated line against the real secrets. An engine starved of the briefs
 * cannot redact, cannot score fairness and cannot write a private report — it
 * would produce a demo that leaks by having nothing to protect. Do not "fix" the
 * engine by passing it a `SessionView`. Only the wire narrows.
 *
 * Shared by server routes, server components and the client, so the three can
 * never disagree about what one person is allowed to know. No React, no I/O.
 */

import { z } from "zod";
import {
  CHARACTERS,
  PARTICIPANT_IDS,
  YOU,
  type ParticipantId,
} from "@/lib/characters";
import {
  agentReportSchema,
  briefSchema,
  fairnessReportSchema,
  mandateFromBrief,
  negotiationTurnSchema,
  participantIdSchema,
  personalitySchema,
  planSchema,
  publicMandateSchema,
  usageSchema,
  type DemoSession,
} from "@/lib/types";

/** The person a view is built for when a caller does not say. The demo user. */
export const DEFAULT_VIEWER: ParticipantId = YOU;

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The four numbers, without the bio.
 *
 * Split out because the two halves of a `Personality` are public for different
 * reasons and one of them is arguable. See `otherParticipantViewSchema`.
 */
export const personalitySlidersSchema = personalitySchema.omit({ bio: true });

/** How someone else's agent behaves, as the room can already see it behave. */
export type PersonalitySliders = z.infer<typeof personalitySlidersSchema>;

/**
 * One of the other three, as you are allowed to know them.
 *
 * `mandate` is the whole point: `PublicMandate` already exists as the sanitized,
 * ceiling-free view of a person — it is what the negotiation prompt sees, and
 * anything it omits is a thing no agent in the room could have learned either.
 * Reusing it here means the browser is told exactly what the town was told.
 *
 * `sliders` and `bio` are public by observation rather than by decision. The
 * sliders *are* the behaviour a judge watches in the town: an agent that holds
 * its position hard is visibly stubborn, so hiding the number would conceal
 * nothing. The bio is public because `mandateFromBrief` already quotes it
 * verbatim into `mandate.voiceNote`, which every other agent reads; redacting
 * the field while shipping the sentence would be theatre, not privacy.
 *
 * What is absent is absent on purpose: no `budgetCeiling`, no `budgetIsPrivate`,
 * no private dealbreakers or notes (the `private:`-marked lines never reach a
 * mandate), no `rawTranscript`, no `AgentReport`.
 */
export const otherParticipantViewSchema = z.object({
  participantId: participantIdSchema,
  /** Display name, so a client never has to look one up to render a row. */
  name: z.string(),
  /** The sanitized view. Carries a price *stance*, never a price. */
  mandate: publicMandateSchema,
  sliders: personalitySlidersSchema,
  bio: z.string(),
  /** Their tap on the plan screen. A public act by construction. */
  approved: z.boolean(),
});

/** One of the other three, narrowed. */
export type OtherParticipantView = z.infer<typeof otherParticipantViewSchema>;

/** You, in full. This is your own data; there is nothing here to keep from you. */
export const selfParticipantViewSchema = z.object({
  participantId: participantIdSchema,
  name: z.string(),
  /** Including your real ceiling. Scoped, not absent: the product needs it. */
  brief: briefSchema,
  personality: personalitySchema,
  approved: z.boolean(),
});

/** You, whole. */
export type SelfParticipantView = z.infer<typeof selfParticipantViewSchema>;

/**
 * Everything one person may know about the session.
 *
 * Declared as a schema rather than an interface so the narrowing cannot drift:
 * a field added to `DemoSession` does not silently appear here, and a route can
 * parse its own output in development to prove what it is about to send.
 */
export const sessionViewSchema = z.object({
  sessionId: z.string(),
  /** Whose view this is. Echoed back so a client cannot mix two up. */
  viewerId: participantIdSchema,
  tripName: z.string(),
  startedAt: z.number(),
  you: selfParticipantViewSchema,
  /** The other three, in `PARTICIPANT_IDS` order. */
  others: z.array(otherParticipantViewSchema),
  /**
   * The public transcript. Already redacted when it was generated; each turn's
   * `privateReasonKept` is stripped here unless you are the one who said it.
   */
  turns: z.array(negotiationTurnSchema),
  plan: planSchema.nullable(),
  fairness: fairnessReportSchema.nullable(),
  /** Yours alone, or null before the run finishes. The other three never cross. */
  report: agentReportSchema.nullable(),
  usage: usageSchema,
});

/** The session, as one person may know it. */
export type SessionView = z.infer<typeof sessionViewSchema>;

/* -------------------------------------------------------------------------- */
/* The narrowing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Narrows a session to one person.
 *
 * The only function in the app allowed to decide what crosses the wire. Pure and
 * total: it never throws, and a viewer with no participant state still gets a
 * well-formed view of the shared fields rather than a 500 mid-demo.
 */
export function sessionViewFor(
  session: DemoSession,
  viewerId: ParticipantId,
): SessionView {
  const mine = session.participants[viewerId];

  const others: OtherParticipantView[] = [];
  for (const id of PARTICIPANT_IDS) {
    if (id === viewerId) continue;
    const state = session.participants[id];
    if (!state) continue;
    const { bio, ...sliders } = state.personality;
    others.push({
      participantId: id,
      name: CHARACTERS[id].name,
      // Derived, not copied: the ceiling becomes a stance inside this call and
      // the private dealbreakers are filtered out by the same function the
      // negotiation prompt uses.
      mandate: mandateFromBrief(state.brief, state.personality),
      sliders,
      bio,
      approved: state.approved,
    });
  }

  return {
    sessionId: session.id,
    viewerId,
    tripName: session.tripName,
    startedAt: session.startedAt,
    you: {
      participantId: viewerId,
      name: CHARACTERS[viewerId].name,
      brief: mine?.brief ?? emptyBrief(viewerId),
      personality: mine?.personality ?? EMPTY_PERSONALITY,
      approved: mine?.approved ?? false,
    },
    others,
    turns: session.turns.map((turn) =>
      turn.speaker === viewerId ? turn : stripPrivateReason(turn),
    ),
    plan: session.plan,
    fairness: session.fairness,
    report: session.reports?.[viewerId] ?? null,
    usage: session.usage,
  };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

type Turn = z.infer<typeof negotiationTurnSchema>;

/**
 * Drops the one field on a turn that is not public.
 *
 * `privateReasonKept` records *why* an agent said what it said — "protecting a
 * $600 ceiling" — and is surfaced only to the human that agent works for. It
 * rides along in the session because the plan screen shows it back to its owner.
 */
function stripPrivateReason(turn: Turn): Turn {
  if (turn.privateReasonKept === undefined) return turn;
  const next = { ...turn };
  delete next.privateReasonKept;
  return next;
}

/** A brief-shaped blank, for a viewer the session has no state for. */
function emptyBrief(participantId: ParticipantId): z.infer<typeof briefSchema> {
  return {
    participantId,
    destinationWant: "",
    dates: "",
    nights: null,
    budgetCeiling: null,
    budgetIsPrivate: true,
    dealbreakers: [],
    wants: [],
    notes: [],
    rawTranscript: [],
  };
}

const EMPTY_PERSONALITY: z.infer<typeof personalitySchema> = {
  stubborn: 50,
  splurgy: 50,
  blunt: 50,
  adventurous: 50,
  bio: "",
};
