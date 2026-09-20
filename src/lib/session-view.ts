/**
 * The one place a `DemoSession` is narrowed for a human.
 *
 * The session object is the whole demo: four briefs, four real ceilings, four
 * private transcripts and four private reports. That is exactly the shape the
 * negotiation needs and exactly the shape no browser may ever see. Handing it
 * out over HTTP would mean one `curl` returns Richard's $600, Will's credit card
 * note and Tsai's sister's ticket — the product's entire claim, undone by the
 * endpoint that feeds the screen that makes the claim.
 *
 * So the HTTP boundary narrows here, once. `GET /api/session` and every POST
 * response go through `sessionViewFor`, and `planViewFor` is a reshaping of its
 * output rather than a second, parallel idea of what "your view" means. One
 * function, one rule, one thing to audit.
 *
 * The negotiation stream is the same boundary wearing a different hat, so its
 * narrowing lives here too. `eventForViewer` is `sessionViewFor`'s sibling: the
 * `done` frame carries all four `AgentReport`s — `secretsKept` spells out "$600
 * budget" — and a `speak` frame carries the speaker's `privateReasonKept`. Both
 * are the same leak the session route already closed, arriving one frame at a
 * time instead of in one JSON body. Two functions, one file, one place a
 * reviewer has to look to know everything a browser can learn.
 *
 * IMPORTANT — this narrowing is for the HTTP boundary and nothing else.
 * `runNegotiation` and everything under `lib/negotiation/` legitimately take the
 * full `DemoSession` and legitimately *emit* the full picture: the redaction
 * guarantee is *built* on those agents holding the real briefs, deriving a
 * `PublicMandate` from each and scanning every generated line against the real
 * secrets. An engine starved of the briefs cannot redact, cannot score fairness
 * and cannot write a private report — it would produce a demo that leaks by
 * having nothing to protect. Do not "fix" the engine by passing it a
 * `SessionView`, and do not make it emit fewer reports: `/api/negotiate` still
 * persists every one of them to the session, because each human fetches their
 * own back through the narrowed session route. Only the wire narrows.
 *
 * Shared by server routes, server components and the client, so the three can
 * never disagree about what one person is allowed to know. No React, no I/O.
 */

import { z } from "zod";
import {
  PARTICIPANT_IDS,
  YOU,
  displayNameFor,
  type DisplayNames,
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
  displayNamesOf,
  type DemoSession,
  type NegotiationEvent,
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
  // Resolved once, here, so `name` on both halves of the view is the same
  // answer the town and the prompts get. A client that only has the view can
  // rebuild the map with `displayNamesFromView`, without ever seeing a brief.
  const names = displayNamesOf(session);

  const others: OtherParticipantView[] = [];
  for (const id of PARTICIPANT_IDS) {
    if (id === viewerId) continue;
    const state = session.participants[id];
    if (!state) continue;
    const { bio, ...sliders } = state.personality;
    others.push({
      participantId: id,
      name: displayNameFor(names, id),
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
      name: displayNameFor(names, viewerId),
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

/**
 * Narrows one frame of the negotiation stream to one person.
 *
 * `sessionViewFor`'s sibling, and deliberately the same shape of promise: pure,
 * total, and the only thing between `runNegotiation` and a browser. Two of the
 * six frame types carry something private and both are handled by name; every
 * other frame is returned by reference, so a `round`, `thinking`, `offer` or
 * `agreed` event is provably the object the engine produced.
 *
 * - **`speak`** keeps `privateReasonKept` only for the person whose agent said
 *   it. It names the real reason — "protecting a $600 ceiling" — and the room
 *   is exactly who must not have it. The town already renders someone else's
 *   line as "Reason kept private", so nothing visible changes; the number
 *   simply stops being on the wire to begin with.
 * - **`done`** keeps one `AgentReport`: the viewer's. The engine sends all four
 *   and the route still writes all four to the session, because each human
 *   fetches their own through `GET /api/session?viewer=`. What no longer
 *   happens is one `curl -N` on the stream returning four `secretsKept` arrays.
 *
 * A viewer the run has no report for gets an empty map rather than a missing
 * field, so the frame still parses as a `NegotiationEvent` on the way in.
 *
 * `agreed` carries a `FairnessReport` and is still returned untouched. That was
 * checked rather than assumed: a fairness row is a participant id, two counts
 * and the one want they gave up, it names no ceiling, and `sessionViewFor`
 * already hands the same object to every viewer because the meter is the shared
 * plan screen's headline. Narrowing it here would hide from one person what the
 * screen shows all four.
 */
export function eventForViewer(
  event: NegotiationEvent,
  viewerId: ParticipantId,
): NegotiationEvent {
  switch (event.type) {
    case "speak":
      return event.speaker === viewerId ? event : stripPrivateReason(event);

    case "done": {
      const mine = event.reports[viewerId];
      return { ...event, reports: mine ? { [viewerId]: mine } : {} };
    }

    default:
      // round, thinking, offer, agreed: public by construction. Returned
      // untouched so the narrowing cannot quietly reshape a frame it has no
      // business editing.
      return event;
  }
}

/**
 * The name map, rebuilt from a view that has already crossed the wire.
 *
 * `sessionViewFor` resolved every `name` on the way out, so this is a gather
 * rather than a second opinion: the browser gets the names the room used and
 * none of the briefs they were stored beside.
 */
export function displayNamesFromView(view: SessionView): DisplayNames {
  const names: Partial<Record<ParticipantId, string>> = {
    [view.you.participantId]: view.you.name,
  };
  for (const other of view.others) names[other.participantId] = other.name;
  return names;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/** The two shapes that carry a private reason: a stored turn and a live frame. */
type HasPrivateReason = { privateReasonKept?: string };

/**
 * Drops the one field on a turn that is not public.
 *
 * `privateReasonKept` records *why* an agent said what it said — "protecting a
 * $600 ceiling" — and is surfaced only to the human that agent works for. It
 * rides along in the session because the plan screen shows it back to its owner.
 *
 * Generic over the carrier because the stored `NegotiationTurn` and the live
 * `speak` frame are the same secret in two envelopes; one function means the
 * stream and the session route cannot drift on what "public" means.
 */
function stripPrivateReason<T extends HasPrivateReason>(carrier: T): T {
  if (carrier.privateReasonKept === undefined) return carrier;
  const next = { ...carrier };
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
