/**
 * POST /api/brief — one turn of the private briefing chat.
 *
 * Two model calls per turn, both on the cheap tier: `brief-reply` writes what
 * the agent says back to its own human, `brief-extract` re-derives the
 * structured `Brief` from the whole transcript so the "YOUR AGENT KNOWS" panel
 * can fill itself in as the conversation goes.
 *
 * Nothing here is public. This is the one place a real budget is allowed to
 * exist in plain text; `lib/negotiation/redaction.ts` is what keeps it out of
 * the town.
 *
 * Every turn is saved to the session before it is answered, which is what makes
 * the briefing screen a real step rather than a demo of one: the conversation,
 * the fields it filled in and the secret it locked all survive a reload, the
 * walk to step 2 and back, and a restarted server. It is also what the town
 * argues with — the negotiation reads `session.participants[id].brief`, so a
 * turn that is not saved is a thing the person said that their agent never
 * hears.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getProvider } from "@/lib/llm";
import {
  briefMessageSchema,
  briefSchema,
  displayNamesOf,
  participantIdSchema,
  secretsFromBrief,
  type Brief,
} from "@/lib/types";
import { displayNameFor } from "@/lib/characters";
import { getOrCreateDefault, updateSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Request                                                                     */
/* -------------------------------------------------------------------------- */

const requestSchema = z.object({
  participantId: participantIdSchema,
  /** The whole conversation so far, newest last, including the human's new line. */
  messages: z.array(briefMessageSchema).min(1),
  /** What the panel currently shows, so extraction refines instead of guessing. */
  brief: briefSchema.partial().optional(),
});

export interface BriefTurnResponse {
  reply: string;
  brief: Brief;
  /** "$600 budget" when this turn produced something the agent will hold back. */
  keptPrivate: string | null;
}

/* -------------------------------------------------------------------------- */
/* The secret sniffer                                                          */
/* -------------------------------------------------------------------------- */

/** A figure: "$600", "600 bucks", "1,200 usd". */
const MONEY = /\$\s*\d|\b\d[\d,]{2,}\s*(?:dollars|bucks|usd)\b/i;

/** The ask that turns a figure into a secret: "don't tell them". */
const HUSH =
  /don'?t tell|do not tell|between us|keep (?:it|that|this) (?:quiet|private|secret)|not a word|never say|don'?t mention|don'?t repeat|off the record|just between|privately|in private|secret/i;

/**
 * The label under the agent's reply. Derived from the brief's own secret list
 * rather than from the sentence, so the badge and the redactor can never
 * disagree about what is being protected.
 */
function keptPrivateLabel(lastHuman: string, brief: Brief): string | null {
  if (!MONEY.test(lastHuman)) return null;
  if (!brief.budgetIsPrivate && !HUSH.test(lastHuman)) return null;

  const budget = secretsFromBrief(brief).find((s) => s.kind === "budget");
  if (budget) return budget.label;
  return brief.budgetCeiling === null ? null : `$${brief.budgetCeiling} budget`;
}

/* -------------------------------------------------------------------------- */
/* Prompts                                                                     */
/* -------------------------------------------------------------------------- */

function replySystem(name: string): string {
  return [
    `You are ${name}'s agent in twocents.ai. You are talking to ${name} alone, in private.`,
    "Your job is to learn what they actually want — destination, dates, the real spending ceiling, hard nos — so you can work the plan out later with three other agents.",
    "Ask for exactly one missing thing at a time. Two sentences maximum. Plain, warm, specific. No marketing, no em dashes, no lists.",
    "When they name a number or tell you to keep something quiet, say plainly that it stays with you and name what the others will hear instead. Never promise anything you cannot enforce.",
  ].join("\n");
}

const EXTRACT_SYSTEM = [
  "Extract the structured brief from a private briefing conversation.",
  "Use only what the human said. Leave a field at its previous value when this turn added nothing to it.",
  "budgetCeiling is the per-person all-in ceiling as a number, or null if never named.",
  "budgetIsPrivate is true unless the human explicitly said the group may know the figure.",
  "Prefix any dealbreaker or note the human asked to keep quiet with 'private:'.",
].join("\n");

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Bad request.", issues: z.treeifyError(parsed.error) },
      { status: 400 },
    );
  }

  const { participantId, messages, brief: known } = parsed.data;
  const session = getOrCreateDefault();
  // The same resolver the room uses, so an agent briefed in a judges' round
  // calls its human by the name the judge typed.
  const name = displayNameFor(displayNamesOf(session), participantId);
  const lastHuman = [...messages].reverse().find((m) => m.role === "human")?.text ?? "";
  const turnIndex = messages.filter((m) => m.role === "human").length - 1;

  const provider = getProvider();
  const transcript = messages.map((m) => ({ role: m.role, text: m.text }));
  const context = {
    participantId,
    speaker: participantId,
    lastHumanMessage: lastHuman,
    turnIndex,
    transcript,
    ...known,
  };

  const reply = await provider.text({
    tag: "brief-reply",
    system: replySystem(name),
    messages: messages.map((m) => ({
      role: m.role === "human" ? ("user" as const) : ("assistant" as const),
      content: m.text,
    })),
    maxTokens: 180,
    temperature: 0.7,
    context,
  });

  const extracted = await provider.json(
    {
      tag: "brief-extract",
      system: EXTRACT_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `Participant id: ${participantId}`,
            known ? `Known so far: ${JSON.stringify(known)}` : "Nothing known yet.",
            "Conversation:",
            ...transcript.map((m) => `${m.role === "human" ? name : "agent"}: ${m.text}`),
          ].join("\n"),
        },
      ],
      maxTokens: 700,
      temperature: 0,
      context,
    },
    briefSchema,
  );

  const answer = reply.value.trim();

  // The transcript is ours, not the model's: it is the literal chat, and a
  // model that paraphrases it would quietly rewrite what the human said. The
  // agent's own reply is appended here rather than only in the browser, so the
  // saved conversation is the whole conversation and a reload does not lose
  // the last thing the agent said.
  const brief: Brief = {
    ...extracted.value,
    participantId,
    rawTranscript: [...messages, { role: "agent", text: answer }],
  };

  // Saved before answering. A write that fails leaves the browser holding the
  // only copy of this turn, which is exactly the bug this replaced, so it is
  // logged rather than swallowed — but it still must not fail the request:
  // the person is mid-sentence with their agent.
  const saved = updateSession(session.id, {
    participants: {
      ...session.participants,
      [participantId]: { ...session.participants[participantId], brief },
    },
  });
  if (!saved) {
    console.warn(`[brief] could not save ${participantId}'s turn to ${session.id}`);
  }

  const payload: BriefTurnResponse = {
    reply: answer,
    brief,
    keptPrivate: keptPrivateLabel(lastHuman, brief),
  };

  return NextResponse.json(payload);
}
