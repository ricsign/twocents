"use client";

/**
 * Watching a negotiation somebody else's browser is running.
 *
 * One run per room: the host's town screen opens the stream and owns the pace,
 * and the other three arrive at the same URL with nothing to open. They are not
 * left staring at an empty table — they read the same transcript out of the
 * session a beat behind, because the stream writes every turn back there as it
 * goes.
 *
 * A poll rather than a second stream, and that is the whole point. Attaching
 * three more viewers to the live run would mean fanning one generator out to
 * several subscribers, replaying what they missed, and keeping four paces in
 * step — a websocket-shaped problem this app deliberately does not have. What a
 * spectator loses is the choreography: no speech bubbles, no round clock. What
 * they keep is every line, every offer, their own private reasons, and the plan
 * the moment it lands.
 *
 * Reads `GET /api/session`, naming the room and the seat, so the narrowing is
 * the same one every other screen goes through and a watcher sees exactly what
 * they would have seen on their own stream — their own private reasons, and
 * nobody else's.
 */

import { useEffect, useState } from "react";
import { sessionViewSchema } from "@/lib/session-view";
import type { ParticipantId } from "@/lib/characters";
import type { NegotiationTurn } from "@/lib/types";

/** Fast enough to read as live, slow enough that four phones are nothing. */
const POLL_MS = 1500;

export interface WatchedRoom {
  turns: NegotiationTurn[];
  hasPlan: boolean;
  /** True while lines are still arriving: something happened, nothing agreed. */
  live: boolean;
}

/**
 * Polls the session for the transcript, or stays still when `sessionId` is null.
 *
 * Null rather than a separate hook call so the caller can switch between
 * running and watching without breaking the rules of hooks.
 */
export function useRoomTurns(
  sessionId: string | null,
  viewer?: ParticipantId,
): WatchedRoom {
  const [room, setRoom] = useState<WatchedRoom>({ turns: [], hasPlan: false, live: false });

  useEffect(() => {
    if (sessionId === null) return;

    let stopped = false;
    let timer: number | null = null;

    async function read(): Promise<void> {
      try {
        // Named rather than left to the jar: the transcript is narrowed per
        // viewer, so a second tab resolving to the first tab's seat would be
        // handed somebody else's private reasons.
        const params = new URLSearchParams();
        if (sessionId) params.set("sessionId", sessionId);
        if (viewer) params.set("viewer", viewer);
        const query = params.toString() ? `?${params}` : "";
        const response = await fetch(`/api/session${query}`, { cache: "no-store" });
        if (!response.ok) return;
        const parsed = sessionViewSchema.safeParse(await response.json());
        if (!parsed.success || stopped) return;

        const view = parsed.data;
        setRoom({
          turns: view.turns,
          hasPlan: view.plan !== null,
          // "Started and not finished" is as much as a watcher can honestly
          // know: there is no event to say a line is on its way.
          live: view.runStartedAt !== null && view.plan === null,
        });
      } catch {
        // A dropped poll is a missed beat, not a failure. The next one catches
        // up, because every read is of the whole transcript rather than a diff.
      } finally {
        if (!stopped) timer = window.setTimeout(() => void read(), POLL_MS);
      }
    }

    void read();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [sessionId, viewer]);

  return room;
}
