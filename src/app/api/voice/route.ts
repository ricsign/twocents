/**
 * POST /api/voice — one sample line showing how an agent will sound.
 *
 * The personality screen calls this after the human stops dragging a slider.
 * It is the cheapest tier in the app (`voice-preview` maps to `fast`) because
 * it fires on every settled drag, and it runs with no key at all: the offline
 * provider keeps distinguishable lines for each corner of the sliders, so the
 * flip beat works on a dead network.
 *
 * Note what is *not* in this request: the brief. The preview is generated from
 * the sliders plus one public noun, so the ceiling cannot leak into the sample
 * line — it was never in the context that wrote it. That is rule 1 of
 * `docs/ARCHITECTURE.md` applied to the one screen where a human is watching
 * the words appear.
 *
 * The noun is `contested`: whatever is on the table for this room to push back
 * on, derived by `sampleTopicFor` from the sanitized mandates the other agents
 * already publish. The prompt used to assert that "someone has just proposed
 * Cancun", which was true of the seeded grad trip and of nothing else, so a
 * judges' round about dinner got a preview about Mexico.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { getProvider } from "@/lib/llm";
import { describePersonality, personalitySchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  personality: personalitySchema,
  /**
   * What the room is arguing about, in a few words. Optional so an older
   * client still gets a line; capped so a caller cannot smuggle a paragraph
   * of its own into the system prompt.
   */
  contested: z.string().trim().min(1).max(60).optional(),
});

/** What the personality screen reads back. */
export interface VoicePreviewResponse {
  line: string;
}

function systemFor(contested: string | undefined): string {
  return [
    "You are one friend's AI agent, working out a group plan with three other agents.",
    "Write ONE line you would say out loud in that room, in the voice described. One or two sentences, maximum 28 words.",
    contested
      ? `The option on the table right now is ${contested}. Respond to that, in your own person's interest.`
      : "Something expensive is on the table. Respond to that, in your own person's interest.",
    "Put your person's side without ever naming their budget, a spending ceiling or any private reason. Talk about the plan, not the money they have.",
    "Plain speech. No quotation marks, no stage directions, no preamble, no em dashes. Return the line and nothing else.",
  ].join("\n");
}

/** Models like to wrap a one-liner in quotes; the UI adds its own. */
function unquote(line: string): string {
  return line.trim().replace(/^["“'‘]+|["”'’]+$/g, "").trim();
}

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

  const { personality, contested } = parsed.data;

  const result = await getProvider().text({
    tag: "voice-preview",
    system: systemFor(contested),
    messages: [
      {
        role: "user",
        content: `Your voice: ${describePersonality(personality)}`,
      },
    ],
    maxTokens: 120,
    temperature: 0.8,
    // The offline provider keys its canned line off these three sliders, and
    // substitutes the same public noun into it.
    context: { personality, contested },
  });

  const payload: VoicePreviewResponse = { line: unquote(result.value) };
  return NextResponse.json(payload);
}
