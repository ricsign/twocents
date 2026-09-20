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
import { resolveSession, roomFromRequest } from "@/lib/room/identity";
import { resetSession, updateSession } from "@/lib/session";
import {
  DEFAULT_VIEWER,
  sessionViewFor,
  type SessionView,
} from "@/lib/session-view";
import { blankBrief } from "@/lib/seed";
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
  /**
   * Forget everything my agent knows and start the conversation again.
   *
   * Narrower than `reset` on purpose: this clears one person's brief and
   * transcript and leaves the room — the other three briefs, the plan, the
   * approvals — where it was. Wanting to re-brief your own agent is an ordinary
   * thing to want, and making the only route to it the button that wipes the
   * whole demo is why people end up staring at somebody else's conversation.
   */
  z.object({
    action: z.literal("clearBrief"),
    sessionId: z.string().optional(),
    viewer: participantIdSchema.optional(),
    participantId: participantIdSchema,
  }),
]);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

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
  const asked = url.searchParams.get("viewer");
  if (asked !== null) {
    const viewer = participantIdSchema.safeParse(asked);
    if (!viewer.success) return badRequest(viewer.error.issues);
  }

  // With no parameters at all this reads as "me, where I am", which is what
  // lets the lobby and the plan screen poll with a bare fetch and still get a
  // view narrowed to the right person in the right room.
  const { sessionId, seat } = await roomFromRequest(request);
  const session = resolveSession(sessionId);
  if (!session) return Response.json({ error: "unknown session" }, { status: 404 });
  return viewResponse(session, seat);
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

  const room = await roomFromRequest(request, {
    sessionId: body.sessionId,
    viewer: body.viewer,
  });
  // The cookie outranks the body once this browser has actually joined a room.
  // Until rooms, the rule below compared two fields the same caller supplied,
  // which made it a spelling check rather than a permission: anyone could send
  // `viewer: "sam"` and write Sam's seat. A claimed seat is a fact the server
  // stored, so checking against it is what turns the rule into one.
  const viewer: ParticipantId = room.joined ? room.seat : (body.viewer ?? DEFAULT_VIEWER);
  if (room.joined && body.viewer && body.viewer !== room.seat) {
    return forbidden(viewer, body.viewer);
  }

  const session = resolveSession(room.sessionId);
  if (!session) return Response.json({ error: "unknown session" }, { status: 404 });

  if (body.action === "reset") {
    // Total by construction — a fresh seed object, not a diff — so nothing from
    // the previous judge's run can survive into the next one. Resetting is a
    // room-wide act, so it is the one write not scoped to one participant.
    //
    // Which is exactly why it needs a host once there is a room: this replaces
    // four people's briefs, and the button sits on a screen all four of them
    // are looking at. A solo session has no host and keeps the old behaviour,
    // where RESET is a scripted demo beat anybody may press.
    if (session.hostSeat && session.hostSeat !== viewer) {
      return Response.json(
        { error: `only ${session.hostSeat} may reset this room` },
        { status: 403 },
      );
    }
    return viewResponse(resetSession(session.id), viewer);
  }

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

    case "clearBrief": {
      // The personality survives: how your agent argues is a separate decision
      // from what it is arguing for, and it was made on a different screen.
      const next = patchParticipant(session, body.participantId, {
        brief: blankBrief(body.participantId),
      });
      return next
        ? viewResponse(next, viewer)
        : Response.json({ error: "unknown participant" }, { status: 404 });
    }
  }
}
