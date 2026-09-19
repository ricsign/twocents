/**
 * Every prompt the product sends, and the wall between the public ones and the
 * private one.
 *
 * ## The invariant
 *
 * **Exactly one function in this file may see a `Brief`, and it is the one whose
 * output never leaves its owner.** `buildPrivateReportPrompt` takes a `Brief`
 * because the text it produces is shown to that person alone. Every other
 * function here takes a `PublicMandate` instead, and the type system is what
 * enforces it: `buildPublicSystemPrompt` cannot reach a budget ceiling, a
 * private dealbreaker or a private note, because none of them exist in the
 * argument it was handed. That is rule 1 of `docs/ARCHITECTURE.md` expressed as
 * a signature rather than as an instruction a model might ignore.
 *
 * The standing "never say a figure" line in the public system prompt is a second
 * layer, not the guarantee. The guarantee is `lib/negotiation/redaction.ts`,
 * which scans what came back. A prompt is advice; the scan is enforcement.
 *
 * Prompts live in their own module rather than inline in the engine so this
 * boundary is inspectable in one screen: if a future edit imports `Brief` into a
 * public builder, it shows up here, in a file whose whole job is that rule.
 *
 * Pure: no I/O, no React, no Node APIs.
 */

import {
  displayNameFor,
  type DisplayNames,
  type ParticipantId,
} from "@/lib/characters";
import {
  describePersonality,
  isPrivateLine,
  stripPrivateMarker,
  type Brief,
  type FairnessRow,
  type NegotiationTurn,
  type Offer,
  type Personality,
  type Plan,
  type PublicMandate,
} from "@/lib/types";

/** A system/user pair, for the calls that need both halves built together. */
export interface PromptPair {
  system: string;
  user: string;
}

/* -------------------------------------------------------------------------- */
/* Shared formatting                                                           */
/* -------------------------------------------------------------------------- */

/** `- one\n- two`, or an explicit "none" so the model does not invent items. */
function bullets(items: readonly string[], empty = "(none)"): string {
  const kept = items.map((item) => item.trim()).filter(Boolean);
  if (kept.length === 0) return empty;
  return kept.map((item) => `- ${item}`).join("\n");
}

/**
 * One offer on a single line.
 *
 * Compact on purpose: the transcript the agents read is the bulk of the token
 * spend in a run, and an offer restated as prose costs four times what its
 * fields cost. This is the "compact structured offers between agents" line of
 * the plan, made literal.
 */
export function formatOffer(offer: Offer, names?: DisplayNames): string {
  return [
    offer.destination,
    offer.region,
    offer.dates,
    offer.nights > 0 ? `${offer.nights}n` : "",
    `$${offer.perPerson}pp`,
    `by ${displayNameFor(names, offer.proposedBy)}`,
    offer.highlights.join(" / "),
    offer.flightNote,
  ]
    .filter((part) => String(part).trim().length > 0)
    .join(" · ");
}

/** `r2 Jordan trades: "Fine. But we keep the catamaran day."` */
export function formatTurn(
  turn: NegotiationTurn,
  maxChars = 160,
  names?: DisplayNames,
): string {
  const name = displayNameFor(names, turn.speaker);
  const text = turn.text.length > maxChars ? `${turn.text.slice(0, maxChars - 1)}…` : turn.text;
  return `r${turn.round} ${name} ${turn.kind}: ${text}`;
}

/* -------------------------------------------------------------------------- */
/* 1. The public system prompt                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The prompt an agent argues from in the open.
 *
 * Takes a `PublicMandate`, never a `Brief`. Everything absent from the mandate
 * is absent from this context, so it cannot be leaked by a model that decides to
 * be helpful: the real ceiling was replaced by a `PriceStance` before this
 * function was ever called, and the private dealbreakers became `Secret`s the
 * redactor guards rather than lines in a prompt.
 *
 * `roster` is a list of the other agents' mandates — public by construction, for
 * the same reason.
 */
export function buildPublicSystemPrompt(
  participantId: ParticipantId,
  mandate: PublicMandate,
  personality: Personality,
  roster: readonly PublicMandate[],
  names?: DisplayNames,
): string {
  const me = displayNameFor(names, participantId);
  const others = roster.filter((entry) => entry.participantId !== participantId);

  const othersBlock = others
    .map((entry) => {
      const name = displayNameFor(names, entry.participantId);
      return `- ${name}: wants ${entry.destinationWant}; on money they are "${entry.priceStance}".`;
    })
    .join("\n");

  return [
    `You are ${me}'s agent. You are sitting at a table with three other agents, each arguing for their own person. You are negotiating one shared trip.`,
    "",
    `HOW YOU SOUND`,
    describePersonality(personality),
    "",
    `WHAT YOU ARE ARGUING FOR`,
    `- Destination: ${mandate.destinationWant}`,
    `- Dates: ${mandate.dates}${mandate.nights === null ? "" : ` (${mandate.nights} nights)`}`,
    `- On money: ${mandate.priceStance}`,
    `- Hard nos you may state openly:`,
    bullets(mandate.dealbreakers, "  (none you can state)"),
    `- What a good trip gives ${me}:`,
    bullets(mandate.wants),
    "",
    `THE OTHERS`,
    othersBlock || "(you are alone at the table)",
    "",
    `RULES OF THE ROOM`,
    "1. Never state a specific budget figure, yours or anyone's, and never state a number close to one. Say it qualitatively instead: \"that's over what works for us\", \"that's a stretch\", \"we can do that\".",
    "2. You may argue about the price of an option out loud — a trip's per-person cost is public. What is never public is the limit your person set.",
    "3. Never explain a position by naming a private reason. Argue for the outcome, not the reason behind it.",
    "4. One or two sentences. This is a table, not an essay. No preamble, no stage directions, no quotation marks around your own line.",
    "5. Move the negotiation: propose something concrete, push back on something specific, or trade one thing for another. Do not restate a point you have already made.",
    "6. When an option on the table works for your person, say so and agree. Agreement is a win, not a loss.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 2. The public user prompt (one turn)                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the agent sees of the room before it speaks.
 *
 * The transcript is abbreviated and the offers are structured, rather than the
 * whole conversation being replayed as prose. Two reasons, one product and one
 * cost: a model given the full history restates it, and restated history reads
 * as a stalled negotiation on screen; and multi-agent chat is where the token
 * bill actually goes, so the per-turn context is bounded by design — the last
 * few lines plus the offers, not round five carrying rounds one through four.
 */
export function buildNegotiationUserPrompt(options: {
  round: number;
  roundCap: number;
  turns: readonly NegotiationTurn[];
  offers: readonly Offer[];
  leadingOffer: Offer | null;
  /** Appended verbatim; carries the redaction retry and the repeat nudge. */
  correction?: string;
  recentTurnCount?: number;
}): string {
  const recent = options.turns.slice(-(options.recentTurnCount ?? 6));

  const parts = [
    `ROUND ${options.round} OF ${options.roundCap}.`,
    "",
    "OFFERS ON THE TABLE",
    options.offers.length === 0
      ? "(nothing yet — somebody has to go first)"
      : options.offers.map((offer, i) => `${i + 1}. ${formatOffer(offer)}`).join("\n"),
    "",
    "LEADING OFFER",
    options.leadingOffer ? formatOffer(options.leadingOffer) : "(none)",
    "",
    "WHAT WAS SAID",
    recent.length === 0 ? "(the table is quiet)" : recent.map((turn) => formatTurn(turn)).join("\n"),
    "",
    "Say your line now. If you are putting a new trip on the table, fill in `offer` with the whole option; otherwise leave `offer` out. Put the real reason behind your line — the one you did NOT say out loud — in `privateReasonKept`.",
  ];

  if (options.correction?.trim()) {
    parts.push("", options.correction.trim());
  }

  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/* 3. The plan                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The one expensive call in a run.
 *
 * It reads mandates rather than briefs for the same reason the turn prompts do:
 * the plan is shown to all four humans at once, so anything in this context is
 * effectively public. The private half of the outcome is written later, per
 * person, by `buildPrivateReportPrompt`.
 */
export function buildPlanPrompt(
  turns: readonly NegotiationTurn[],
  offers: readonly Offer[],
  mandates: readonly PublicMandate[],
  names?: DisplayNames,
): PromptPair {
  const system = [
    "You are the notetaker at a negotiation between four agents. The talking is over. Write down what they agreed.",
    "",
    "Rules:",
    "- Use only options that were actually on the table. Do not invent a destination nobody proposed.",
    "- The agreed offer is the one the room converged on; the runner-up is the strongest option it beat, with one sentence on why that one lost.",
    "- `keptWants` is what this plan genuinely delivers, drawn from the four people's stated wants. Four short phrases.",
    "- Never write a person's budget limit. Per-person trip cost is fine; a ceiling is not.",
  ].join("\n");

  const user = [
    "WHO WAS AT THE TABLE",
    mandates
      .map((mandate) => {
        const name = displayNameFor(names, mandate.participantId);
        return `- ${name}: ${mandate.destinationWant}; on money "${mandate.priceStance}"; wants: ${mandate.wants.join(", ")}`;
      })
      .join("\n"),
    "",
    "OFFERS THAT WERE PUT ON THE TABLE",
    offers.length === 0
      ? "(none)"
      : offers.map((offer) => `- ${formatOffer(offer, names)}`).join("\n"),
    "",
    "THE TRANSCRIPT",
    turns.length === 0
      ? "(nothing was said)"
      : turns.map((turn) => formatTurn(turn, 200, names)).join("\n"),
    "",
    "Write the plan.",
  ].join("\n");

  return { system, user };
}

/* -------------------------------------------------------------------------- */
/* 4. The private report — THE ONLY FUNCTION HERE THAT SEES A BRIEF            */
/* -------------------------------------------------------------------------- */

/**
 * One agent's debrief to its own human.
 *
 * This is the single function in this file allowed to take a `Brief`, and the
 * reason is that its output has exactly one reader: the person whose brief it
 * is. It is rendered behind "Only you can see this" on the plan screen and it is
 * never put into another agent's context, never added to the transcript, and
 * never included in the shared plan.
 *
 * It is also where the secret finally gets acknowledged out loud — "nobody heard
 * your number" only lands as a payoff if this report can say it, which it can
 * precisely because it goes nowhere else.
 */
export function buildPrivateReportPrompt(
  participantId: ParticipantId,
  brief: Brief,
  plan: Plan,
  turns: readonly NegotiationTurn[],
  fairnessRow: FairnessRow | null,
  names?: DisplayNames,
): PromptPair {
  const me = displayNameFor(names, participantId);
  const ownTurns = turns.filter((turn) => turn.speaker === participantId);

  const privateLines = [...brief.dealbreakers, ...brief.notes]
    .filter(isPrivateLine)
    .map(stripPrivateMarker);

  const system = [
    `You are ${me}'s agent, writing to ${me} alone after the negotiation. Nobody else will ever read this. Speak to them directly, second person, no greeting.`,
    "",
    "Three answers, nothing else:",
    "- gotYou: what you won for them, concretely, in one or two sentences.",
    "- tradedAway: the one thing you gave up, named plainly. If you gave up nothing, say so.",
    "- why: the reasoning, including the private reason you could not say in the room.",
    "",
    "You may name their real numbers here — this note is private. Be straight with them: a report that claims a clean win when they conceded something is the failure this product exists to prevent.",
  ].join("\n");

  const user = [
    `WHAT ${me.toUpperCase()} TOLD YOU IN PRIVATE`,
    `- Wanted: ${brief.destinationWant}`,
    `- Dates: ${brief.dates}`,
    brief.budgetCeiling === null
      ? "- Ceiling: none given"
      : `- Ceiling: $${brief.budgetCeiling}${brief.budgetIsPrivate ? " (PRIVATE — you never said it in the room)" : ""}`,
    `- Dealbreakers:`,
    bullets(brief.dealbreakers.map(stripPrivateMarker)),
    `- Wants:`,
    bullets(brief.wants),
    privateLines.length > 0 ? `- Kept private:\n${bullets(privateLines)}` : "",
    "",
    "THE AGREED PLAN",
    formatOffer(plan.offer, names),
    `Group total $${plan.groupTotal}. Delivers: ${plan.keptWants.join(", ")}.`,
    plan.runnerUp
      ? `Runner-up: ${formatOffer(plan.runnerUp, names)} — lost because ${plan.runnerUpLostBecause}`
      : "No runner-up.",
    "",
    "HOW THE METER SCORED THEM",
    fairnessRow
      ? `${fairnessRow.wantsKept} of ${fairnessRow.wantsTotal} wants kept${fairnessRow.gaveUp ? `; ${fairnessRow.gaveUp}` : ""}.`
      : "(not scored)",
    "",
    "WHAT YOU SAID IN THE ROOM",
    ownTurns.length === 0
      ? "(you did not speak)"
      : ownTurns.map((turn) => formatTurn(turn, 200, names)).join("\n"),
    "",
    "Write the report.",
  ]
    .filter((part) => part !== "")
    .join("\n");

  return { system, user };
}

/* -------------------------------------------------------------------------- */
/* 5. The briefing chat                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The agent talking to its own human, before the room.
 *
 * Takes the transcript rather than a `Brief` — deliberately, so the invariant at
 * the top of this file stays literally true. Nothing is lost by it: the brief is
 * *derived from* this conversation, so the transcript is strictly more than the
 * brief would give, and the function cannot become a second place a ceiling
 * escapes from.
 *
 * The briefing has a one-minute budget in the demo script, so the prompt pushes
 * for the next missing field rather than chatting.
 */
export function buildBriefReplyPrompt(
  participantId: ParticipantId,
  personality: Personality,
  transcript: readonly { role: "agent" | "human"; text: string }[],
  names?: DisplayNames,
): PromptPair {
  const me = displayNameFor(names, participantId);

  const system = [
    `You are ${me}'s agent. You are talking to ${me} in private, before you go and negotiate their trip with three other agents.`,
    "",
    `HOW YOU SOUND`,
    describePersonality(personality),
    "",
    "Your job in this chat is to find out five things, in this order, one question at a time:",
    "1. where they want to go, 2. the dates, 3. the real maximum they can spend, 4. hard nos, 5. anything they would not say in the group chat.",
    "",
    "Rules:",
    "- One short reply, then one question. Never two questions at once.",
    "- When they give you a number, confirm you have it and promise plainly that you will never say it in the room — without repeating the figure back.",
    "- Never mention a figure they have not already said.",
    "- Warm, fast, and on their side. This should take a minute, not five.",
  ].join("\n");

  const user = [
    "THE CONVERSATION SO FAR",
    transcript.length === 0
      ? "(nothing yet — open the conversation)"
      : transcript
          .map((message) => `${message.role === "human" ? me : "You"}: ${message.text}`)
          .join("\n"),
    "",
    "Write your next reply.",
  ].join("\n");

  return { system, user };
}

/* -------------------------------------------------------------------------- */
/* 6. The voice preview                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One sample line for the personality screen.
 *
 * Built from the sliders alone, with no trip context, because the preview has to
 * change the instant a slider moves — that visible change is the "personality
 * flip" beat, and a preview that also depended on the brief would blur what the
 * judge just did.
 */
export function buildVoicePreviewPrompt(personality: Personality): string {
  return [
    "You are a negotiation agent arguing for one friend in a group trip. Write ONE line you would say at the table — the way this personality would say it.",
    "",
    "PERSONALITY",
    describePersonality(personality),
    "",
    "Rules: one or two sentences, no quotation marks, no preamble. Never state a budget figure. Make the personality obvious from the wording alone.",
  ].join("\n");
}
