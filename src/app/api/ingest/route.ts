/**
 * Reading the group chat. Images in, a draft out, and nothing written down.
 *
 * This route deliberately does not touch the session store. A model's
 * unreviewed reading of somebody's group chat is not a room — it is a guess
 * that a human is about to correct — and keeping it in the browser until they
 * do means the guess never reaches disk. `POST /api/room` is what turns a
 * confirmed draft into a session.
 *
 * It also sidesteps a real problem. `POST /api/session` scopes every write to
 * `viewer === participantId`, on the grounds that briefing somebody else's
 * agent is not a thing. A host editing four seats on a review screen cannot go
 * through that route without loosening the one guard the product is sold on.
 * With a pure extractor there is nothing to loosen.
 *
 * **The pictures stop here.** They are not persisted, not logged, not cached,
 * not written to a temp file, and not put in `CompletionRequest.context` —
 * which the offline provider reads and can echo into `raw`. They exist for the
 * length of this request and then they are gone; a retry re-uploads.
 *
 * Server-only. No React, no DOM.
 */

import { readChatPhoto } from "@/lib/ingest/read";
import {
  MAX_TOTAL_B64,
  ingestRequestSchema,
  type ChatExtraction,
} from "@/lib/ingest/schema";
import { seatsFrom, type SeatedChat } from "@/lib/ingest/seats";
import type { Usage } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface IngestResponse {
  /** False when there was nothing readable in the pictures. */
  ok: boolean;
  /** Present when `ok`. The four seats, plus whoever did not fit. */
  draft?: SeatedChat;
  /** Carried so `/api/room` can bill the reading to the session it seeds. */
  usage?: Usage;
  /** True when no key is set: the draft is a placeholder, not a reading. */
  offline?: boolean;
  /** What to tell the host when `ok` is false. */
  reason?: string;
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, reason: "body must be JSON" }, { status: 400 });
  }

  const parsed = ingestRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      {
        ok: false,
        reason: "those files could not be read as screenshots",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { images, topicHint } = parsed.data;

  // Checked again on the server, because the browser's check is a courtesy and
  // this one is the limit. Measured on the base64 rather than the decoded
  // bytes: what gets rejected upstream is what went over the wire.
  const total = images.reduce((sum, image) => sum + image.dataBase64.length, 0);
  if (total > MAX_TOTAL_B64) {
    return Response.json(
      {
        ok: false,
        reason: `those screenshots come to ${Math.round(total / 1000)}kb encoded, which is over the ${Math.round(MAX_TOTAL_B64 / 1000)}kb limit — try fewer, or crop them tighter`,
      },
      { status: 413 },
    );
  }

  let reading;
  try {
    reading = await readChatPhoto(images, topicHint);
  } catch (error) {
    // `readChatPhoto` goes through the resilient provider, so reaching here
    // means the store or the schema, not the model.
    console.warn("[ingest] could not read the chat:", error);
    return Response.json(
      { ok: false, reason: "something went wrong reading those. Try again, or type it instead." },
      { status: 500 },
    );
  }

  // A key is set but no tokens were spent, which means the live call failed and
  // the canned roster answered in its place. Everywhere else in this app that
  // is the right outcome; here it would put four strangers on screen under the
  // caption "what we read in your photo". So it is reported as a failure to
  // read, which is what it is.
  if (reading.live && reading.guessed) {
    return Response.json(
      {
        ok: false,
        reason: "we could not read those. A tighter crop usually does it — or type it instead.",
      },
      { status: 422 },
    );
  }

  const unusable = notWorthShowing(reading.extraction);
  if (unusable) {
    return Response.json({ ok: false, reason: unusable }, { status: 422 });
  }

  const draft = seatsFrom(reading.extraction);
  // Not an error: `/api/judges` already proves the topic is free text, and a
  // chat that is not about a trip is still four people who might plan one.
  if (!reading.extraction.isTripPlanning) {
    draft.notes.unshift("This does not look like planning — but here is who we read.");
  }

  const payload: IngestResponse = {
    ok: true,
    draft,
    usage: reading.usage,
    offline: !reading.live,
  };
  return Response.json(payload);
}

/** The two readings a host cannot do anything with. */
function notWorthShowing(extraction: ChatExtraction): string | null {
  if (!extraction.readable) {
    return "we could not read the text in that. Try a tighter crop, or add another shot.";
  }
  if (extraction.people.length === 0) {
    return "we could not find anybody in that conversation. Try another screenshot, or type it instead.";
  }
  return null;
}
