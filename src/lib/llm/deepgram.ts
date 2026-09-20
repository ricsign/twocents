/**
 * Speech-to-text for push-to-talk interjections.
 *
 * Prerecorded only — the button gives us one finished clip per interjection,
 * never a stream to keep open, so the file-transcription endpoint is the
 * right tool rather than the WebSocket live API.
 *
 * Never throws: a transcription failure should cost the room one missed
 * interjection, not the run. Callers get back an empty string and treat that
 * as "nothing was said," the same shape `checkOffer` in the engine already
 * degrades to on a failed web check.
 *
 * Server-only. Reads DEEPGRAM_API_KEY from the environment; the key never
 * reaches the browser.
 */

import { DeepgramClient } from "@deepgram/sdk";

const deepgram = new DeepgramClient();

export async function transcribeInterjection(audio: Buffer): Promise<string> {
  try {
    const response = await deepgram.listen.v1.media.transcribeFile(audio, {
      model: "nova-3",
      smart_format: true,
    });
    return response.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
  } catch (error) {
    console.warn(
      "[interject] transcription failed:",
      error instanceof Error ? error.message : String(error),
    );
    return "";
  }
}