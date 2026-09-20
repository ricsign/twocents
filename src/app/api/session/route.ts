/**
 * Read and edit the demo session — as one person.
 *
 * Every response on this route is narrowed by `sessionViewFor` before it leaves
 * the process. The session object itself carries all four real ceilings, all
 * four private transcripts and all four private reports; the product's whole
 * claim is that your agent knows your number and nobody else ever does, and a
 * claim that holds only in the UI is not a claim. It holds here, at the wire.
 *
 * Reads take `?viewer=`; writes carry `viewer` in the body and may only touch
 * that person's own participant. Briefing someone else's agent is not a thing.
 *
 * Every body is validated with the same zod schemas that type the UI, because
 * this route is how a half-finished briefing becomes state the negotiation will
 * argue from — a malformed brief accepted here is a crash in the town, in front
 * of a judge.
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
  DEFAULT_VIEWER,
  sessionViewFor,
  type SessionView,
} from "@/lib/session-view";
import { clearRoom } from "@/lib/negotiation/interjection-control";
import {
  briefSchema,
  participantIdSchema,
  personalitySchema,
  type DemoSession,
  type ParticipantId,
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
 *
 * `viewer` is optional on every action and defaults to the demo user, so the
 * screens that only ever speak for Maya do not have to say so twice.
 */
const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reset"),
    sessionId: z.string().optional(),
    viewer: participantIdSchema.optional(),
  }),
  z.object({
    action: z.literal("updateBrief"),
    sessionId: z.string().optional(),
    viewer: participantIdSchema.optional(),
    participantId: participantIdSchema,
    brief: briefSchema,
  }),
  z.object({
    action: z.literal("updatePersonality"),
    sessionId: z.string().optional(),
    viewer: participantIdSchema.optional(),
    participantId: participantIdSchema,
    personality: personalitySchema,
  }),
  z.object({
    action: z.literal("approve"),
    sessionId: z.string().optional(),
    viewer: participantIdSchema.optional(),
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

/** The single exit for session data. Nothing on this route responds any other way. */
function viewResponse(session: DemoSession, viewer: ParticipantId): Response {
  const view: SessionView = sessionViewFor(session, viewer);
  return Response.json(view);
}

/** Replaces one participant's state without touching the other three. */
function patchParticipant(
  session: DemoSession,
  participantId: ParticipantId,
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

/**
 * The one authorization rule this app has: you write your own row.
 *
 * A 403 rather than a silent no-op, because the only way a caller gets here is
 * by asking for something the product does not offer, and a write that appears
 * to succeed and did not is the worse failure.
 */
function forbidden(viewer: ParticipantId, target: ParticipantId): Response {
  return Response.json(
    {
      error: "forbidden",
      message: `${viewer} may only change their own participant, not ${target}`,
    },
    { status: 403 },
  );
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The session, narrowed to `?viewer=` — your brief and report in full, everyone
 * else as a `PublicMandate` and a name.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // An unknown viewer is a typo, not a guest: 400 rather than quietly handing
  // back Maya's view of a session the caller asked about as someone else.
  const viewer = participantIdSchema.safeParse(
    url.searchParams.get("viewer") ?? DEFAULT_VIEWER,
  );
  if (!viewer.success) return badRequest(viewer.error.issues);

  const session = sessionFor(url.searchParams.get("sessionId") ?? undefined);
  if (!session) return Response.json({ error: "unknown session" }, { status: 404 });
  return viewResponse(session, viewer.data);
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
  const viewer: ParticipantId = body.viewer ?? DEFAULT_VIEWER;

  if (body.action === "reset") {
    // Total by construction — a fresh seed object, not a diff — so nothing from
    // the previous judge's run can survive into the next one. Resetting is a
    // room-wide act, so it is the one write not scoped to one participant.
    const fresh = resetSession(body.sessionId ?? DEFAULT_SESSION_ID);
    // A stale push-to-talk pause or a queued-but-unconsumed interjection from
    // the last run is exactly the kind of thing "nothing survives" has to mean.
    clearRoom(fresh.id);
    return viewResponse(fresh, viewer);
  }

  const session = sessionFor(body.sessionId);
  if (!session) return Response.json({ error: "unknown session" }, { status: 404 });

  // Every remaining action edits one person, and that person is you.
  if (body.participantId !== viewer) return forbidden(viewer, body.participantId);

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
        ? viewResponse(next, viewer)
        : Response.json({ error: "unknown participant" }, { status: 404 });
    }

    case "updatePersonality": {
      const next = patchParticipant(session, body.participantId, {
        personality: body.personality,
      });
      return next
        ? viewResponse(next, viewer)
        : Response.json({ error: "unknown participant" }, { status: 404 });
    }

    case "approve": {
      const next = patchParticipant(session, body.participantId, { approved: true });
      return next
        ? viewResponse(next, viewer)
        : Response.json({ error: "unknown participant" }, { status: 404 });
    }
  }
}