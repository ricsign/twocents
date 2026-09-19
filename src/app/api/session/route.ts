/**
 * Read and edit the demo session.
 *
 * Four actions, one of which is the judges' reset button. Every body is
 * validated with the same zod schemas that type the UI, because this route is
 * how a half-finished briefing becomes state the negotiation will argue from —
 * a malformed brief accepted here is a crash in the town, in front of a judge.
 */

import { z } from "zod";
import {
  DEFAULT_SESSION_ID,
  getOrCreateDefault,
  getSession,
  resetSession,
  updateSession,
} from "@/lib/session";
import {
  briefSchema,
  participantIdSchema,
  personalitySchema,
  type DemoSession,
  type ParticipantState,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* -------------------------------------------------------------------------- */
/* Request bodies                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A discriminated union rather than four optional fields: an action is exactly
 * one thing, and the 400 a caller gets back should name the field it got wrong
 * rather than complaining about all four.
 */
const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reset"),
    sessionId: z.string().optional(),
  }),
  z.object({
    action: z.literal("updateBrief"),
    sessionId: z.string().optional(),
    participantId: participantIdSchema,
    brief: briefSchema,
  }),
  z.object({
    action: z.literal("updatePersonality"),
    sessionId: z.string().optional(),
    participantId: participantIdSchema,
    personality: personalitySchema,
  }),
  z.object({
    action: z.literal("approve"),
    sessionId: z.string().optional(),
    participantId: participantIdSchema,
  }),
]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function sessionFor(sessionId: string | undefined): DemoSession | undefined {
  const id = sessionId ?? DEFAULT_SESSION_ID;
  return id === DEFAULT_SESSION_ID ? getOrCreateDefault() : getSession(id);
}

/** Replaces one participant's state without touching the other three. */
function patchParticipant(
  session: DemoSession,
  participantId: keyof DemoSession["participants"],
  patch: Partial<ParticipantState>,
): DemoSession | undefined {
  const existing = session.participants[participantId];
  if (!existing) return undefined;

  return updateSession(session.id, {
    participants: {
      ...session.participants,
      [participantId]: { ...existing, ...patch },
    },
  });
}

function badRequest(issues: z.core.$ZodIssue[]): Response {
  return Response.json(
    {
      error: "invalid request",
      issues: issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
    { status: 400 },
  );
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

/** The whole session, as the plan and town screens read it on load. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const session = sessionFor(url.searchParams.get("sessionId") ?? undefined);
  if (!session) return Response.json({ error: "unknown session" }, { status: 404 });
  return Response.json(session);
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid request", issues: [{ path: "", message: "body must be JSON" }] }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return badRequest(parsed.error.issues);
  const body = parsed.data;

  if (body.action === "reset") {
    // Total by construction — a fresh seed object, not a diff — so nothing from
    // the previous judge's run can survive into the next one.
    return Response.json(resetSession(body.sessionId ?? DEFAULT_SESSION_ID));
  }

  const session = sessionFor(body.sessionId);
  if (!session) return Response.json({ error: "unknown session" }, { status: 404 });

  switch (body.action) {
    case "updateBrief": {
      if (body.brief.participantId !== body.participantId) {
        return badRequest([
          {
            code: "custom",
            path: ["brief", "participantId"],
            message: "brief.participantId must match participantId",
            input: body.brief.participantId,
          } as z.core.$ZodIssue,
        ]);
      }
      const next = patchParticipant(session, body.participantId, { brief: body.brief });
      return next
        ? Response.json(next)
        : Response.json({ error: "unknown participant" }, { status: 404 });
    }

    case "updatePersonality": {
      const next = patchParticipant(session, body.participantId, {
        personality: body.personality,
      });
      return next
        ? Response.json(next)
        : Response.json({ error: "unknown participant" }, { status: 404 });
    }

    case "approve": {
      const next = patchParticipant(session, body.participantId, { approved: true });
      return next
        ? Response.json(next)
        : Response.json({ error: "unknown participant" }, { status: 404 });
    }
  }
}
