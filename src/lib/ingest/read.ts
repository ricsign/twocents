/**
 * The one call that looks at the photograph.
 *
 * Everything this module returns is a **draft**. Nothing here writes to a
 * session, and that is structural rather than tidy: the model's unreviewed
 * reading of somebody's group chat never touches disk, and a host corrects it
 * in the browser before any of it becomes a room.
 *
 * Server-only.
 */

import { getProvider } from "@/lib/llm";
import type { ImageInput, LLMProvider } from "@/lib/llm/provider";
import type { Usage } from "@/lib/types";
import { CHAT_PHOTO } from "./canned";
import {
  CHAT_PHOTO_MAX_TOKENS,
  CHAT_PHOTO_SYSTEM,
  buildChatPhotoPrompt,
  chatPhotoTimeoutMs,
} from "./prompt";
import { chatExtractionSchema, type ChatExtraction } from "./schema";

export interface ChatReading {
  extraction: ChatExtraction;
  usage: Usage;
  /**
   * True when nothing actually looked at the images.
   *
   * Two very different situations produce it, and the caller has to tell them
   * apart: there is no API key, in which case the canned roster is the app
   * working as documented — or a live call fell through to the canned roster,
   * which means the photograph was *not read* and must not be presented as
   * though it was.
   */
  guessed: boolean;
  /** Whether a key is configured at all. With `guessed`, this separates the two. */
  live: boolean;
}

/**
 * Reads a group chat, or says plainly that it did not.
 *
 * The `guessed` flag is the important output, and it exists because of a trap
 * in the layer below. `ResilientProvider` catches any failure and re-runs the
 * call against the offline provider, which is the right behaviour everywhere
 * else in this app — a negotiation turn that falls back is still a negotiation
 * turn. Here it is not: a refusal, a timeout or a network blip would come back
 * as four confident strangers, and the screen would caption them "what we read
 * in your photo". That is the worst failure in this feature, so it is detected
 * rather than trusted away.
 *
 * `provider.live` cannot detect it, because it reports whether a key exists
 * rather than whether this call used one. Zero tokens is the honest signal —
 * the same trick `lib/itinerary/build.ts` uses to decide whether an itinerary
 * was really built from live search.
 */
export async function readChatPhoto(
  images: ImageInput[],
  topicHint: string | undefined,
  provider: LLMProvider = getProvider(),
): Promise<ChatReading> {
  const result = await provider.json(
    {
      tag: "chat-photo",
      system: CHAT_PHOTO_SYSTEM,
      messages: [{ role: "user", content: buildChatPhotoPrompt(images.length, topicHint) }],
      images,
      maxTokens: CHAT_PHOTO_MAX_TOKENS,
      // Deliberately no `temperature`. It is removed on the models this tier
      // points at and sending one is a 400 — which `ResilientProvider` would
      // swallow, turning every upload into the canned roster.
      timeoutMs: chatPhotoTimeoutMs(),
    },
    chatExtractionSchema,
  );

  const spent = result.usage.inputTokens + result.usage.outputTokens;
  return {
    extraction: result.value,
    usage: result.usage,
    guessed: spent === 0,
    live: provider.live,
  };
}

/** The canned reading, for a caller that wants it without a round trip. */
export function cannedReading(): ChatExtraction {
  return CHAT_PHOTO;
}
