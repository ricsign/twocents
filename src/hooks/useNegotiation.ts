"use client";

/**
 * The town screen's whole brain: one SSE connection, and every piece of screen
 * state derived from the frames it carries.
 *
 * Three decisions worth the words:
 *
 * - **fetch, not EventSource.** `/api/negotiate` takes a POST body (session and
 *   speed), which `EventSource` cannot send. Reading the body as a stream costs
 *   a hand-rolled frame parser and buys an abortable, parameterised run.
 * - **A queue between the wire and React.** Pause has to actually hold the room,
 *   not hide it: the server keeps streaming while a judge is paused, so frames
 *   buffer and replay on resume rather than arriving invisibly.
 * - **A run clock, not timers.** Bubble expiry is measured against a clock that
 *   only advances while the negotiation is running, so pausing freezes the
 *   bubbles for free and no per-bubble timeout has to be rescheduled.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ParticipantId } from "@/lib/characters";
import {
  NEGOTIATION_ROUND_CAP,
  negotiationEventSchema,
  type NegotiationEvent,
  type NegotiationTurn,
  type Offer,
  type Plan,
} from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export type NegotiationStatus = "idle" | "running" | "paused" | "done" | "error";

/** The playback speeds the segmented control offers. */
export const SPEEDS = [1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

/** A line currently floating over someone's head. */
export interface Bubble {
  id: string;
  speaker: ParticipantId;
  text: string;
  privateReasonKept?: string;
  /** Run-clock milliseconds at which this bubble fades. */
  expiresAt: number;
}

interface StreamState {
  round: number;
  roundsTotal: number;
  turns: NegotiationTurn[];
  thinkingSpeaker: ParticipantId | null;
  bubbles: Bubble[];
  offers: Offer[];
  plan: Plan | null;
}

export interface Negotiation extends StreamState {
  currentSpeaker: ParticipantId | null;
  leadingOffer: Offer | null;
  status: NegotiationStatus;
  elapsedMs: number;
  speed: Speed;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  setSpeed: (speed: Speed) => void;
}

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/** Two is the ceiling. Three bubbles stops reading as a conversation. */
const MAX_BUBBLES = 2;
/** How long a line holds at 1x. Divided by speed so 4x does not stack. */
const BUBBLE_LIFE_MS = 5200;
/** Clock granularity, and how often expired bubbles are swept. */
const TICK_MS = 100;
/** Pace a paused backlog replays at, so resume plays rather than dumps. */
const DRAIN_MS = 260;

const EMPTY: StreamState = {
  round: 0,
  roundsTotal: NEGOTIATION_ROUND_CAP,
  turns: [],
  thinkingSpeaker: null,
  bubbles: [],
  offers: [],
  plan: null,
};

/** Queued work: a validated frame, or the `[DONE]` sentinel in its right place. */
type QueueItem = { kind: "event"; event: NegotiationEvent } | { kind: "end" };

/* -------------------------------------------------------------------------- */
/* Reducer                                                                     */
/* -------------------------------------------------------------------------- */

function reduce(
  state: StreamState,
  event: NegotiationEvent,
  clock: number,
  speed: number,
): StreamState {
  switch (event.type) {
    case "round":
      return { ...state, round: event.round, roundsTotal: event.of };

    case "thinking":
      return { ...state, thinkingSpeaker: event.speaker };

    case "speak": {
      const id = `turn-${event.speaker}-${state.turns.length}`;
      const privately = event.privateReasonKept
        ? { privateReasonKept: event.privateReasonKept }
        : {};
      const turn: NegotiationTurn = {
        id,
        round: state.round,
        speaker: event.speaker,
        kind: event.kind,
        text: event.text,
        ...privately,
        // Carried onto the turn so the transcript can print the search behind
        // the line and link to the pages it opened.
        ...(event.sourced ? { sourced: event.sourced } : {}),
      };
      const bubble: Bubble = {
        id,
        speaker: event.speaker,
        text: event.text,
        ...privately,
        expiresAt: clock + BUBBLE_LIFE_MS / speed,
      };
      // A speaker only ever has one bubble: the new line replaces the old.
      const others = state.bubbles.filter((b) => b.speaker !== event.speaker);
      return {
        ...state,
        turns: [...state.turns, turn],
        thinkingSpeaker:
          state.thinkingSpeaker === event.speaker ? null : state.thinkingSpeaker,
        bubbles: [...others, bubble].slice(-MAX_BUBBLES),
      };
    }

    case "offer": {
      // The offer frame always follows its speaker's `speak` frame, so it hangs
      // on that turn and the transcript renders one card instead of two rows.
      const turns = state.turns.slice();
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (turn && turn.speaker === event.speaker && !turn.offer) {
          turns[i] = { ...turn, offer: event.offer };
          break;
        }
      }
      const seen = state.offers.some((o) => o.id === event.offer.id);
      return {
        ...state,
        turns,
        offers: seen ? state.offers : [...state.offers, event.offer],
      };
    }

    case "agreed":
      return { ...state, plan: event.plan };

    case "done":
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/* Hook                                                                        */
/* -------------------------------------------------------------------------- */

export function useNegotiation(sessionId?: string): Negotiation {
  const [state, setState] = useState<StreamState>(EMPTY);
  const [status, setStatus] = useState<NegotiationStatus>("idle");
  const [speed, setSpeedState] = useState<Speed>(1);
  const [elapsedMs, setElapsedMs] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const pausedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const clockRef = useRef(0);
  const speedRef = useRef<Speed>(1);

  /* ---- The queue pump: the only thing that writes stream state ------------ */

  const pump = useCallback(() => {
    timerRef.current = null;
    if (pausedRef.current) return;

    const item = queueRef.current.shift();
    if (!item) return;

    if (item.kind === "end") {
      setStatus((s) => (s === "error" ? s : "done"));
    } else {
      const event = item.event;
      setState((s) => reduce(s, event, clockRef.current, speedRef.current));
      if (event.type === "done") setStatus("done");
    }

    if (queueRef.current.length > 0) {
      timerRef.current = window.setTimeout(pump, DRAIN_MS / speedRef.current);
    }
  }, []);

  const enqueue = useCallback(
    (item: QueueItem) => {
      queueRef.current.push(item);
      // An empty queue means the wire is setting the pace, so apply at once;
      // a backlog means we are replaying and the timer owns the cadence.
      if (timerRef.current === null && !pausedRef.current) pump();
    },
    [pump],
  );

  /* ---- The wire ----------------------------------------------------------- */

  const consume = useCallback(
    async (controller: AbortController, runSpeed: Speed) => {
      try {
        const response = await fetch("/api/negotiate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Neither the room nor the viewer is named here any more. The route
          // reads both off this browser's cookies, which is the only way four
          // phones can open the same stream and each be narrowed to a
          // different person — the frames a device gets carry its own private
          // reasons and, at the end, its own report and nobody else's.
          //
          // `sessionId` still goes when the caller has one, because explicit
          // beats cookie everywhere in this app and a page that knows its room
          // should not depend on a jar it cannot see.
          body: JSON.stringify({
            ...(sessionId ? { sessionId } : {}),
            speed: runSpeed,
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`negotiate responded ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let cut = buffer.indexOf("\n\n");
          while (cut !== -1) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            for (const line of frame.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (payload === "[DONE]") {
                enqueue({ kind: "end" });
                continue;
              }
              const parsed = negotiationEventSchema.safeParse(
                JSON.parse(payload) as unknown,
              );
              // A malformed frame costs one bubble, never the room.
              if (parsed.success) enqueue({ kind: "event", event: parsed.data });
            }
            cut = buffer.indexOf("\n\n");
          }
        }
        enqueue({ kind: "end" });
      } catch {
        if (controller.signal.aborted) return;
        setStatus("error");
      }
    },
    [enqueue, sessionId],
  );

  /* ---- Run control -------------------------------------------------------- */

  const begin = useCallback(
    (runSpeed: Speed) => {
      abortRef.current?.abort();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      queueRef.current = [];
      pausedRef.current = false;
      clockRef.current = 0;
      speedRef.current = runSpeed;

      const controller = new AbortController();
      abortRef.current = controller;

      setElapsedMs(0);
      setState(EMPTY);
      setStatus("running");
      void consume(controller, runSpeed);
    },
    [consume],
  );

  const startedRef = useRef(false);
  const start = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    begin(speedRef.current);
  }, [begin]);

  /**
   * The judges' reset: clear the room *and* the server, then run it again.
   *
   * Restarting the stream alone would have left the previous run's plan,
   * approvals, transcript and token tally sitting in the session store, so the
   * plan screen after a "fresh" run would still have shown the old one. The
   * POST replaces the session object outright — `resetSession` builds a new
   * seed rather than diffing the old one — and only then does a new stream
   * open, so the negotiation the judge watches is arguing from a
   * briefed-but-unnegotiated session.
   *
   * The abort comes first so no frame from the outgoing run can write itself
   * into the session the POST is about to replace. The whole thing is one
   * in-process map write and a new fetch, which is well inside the one second
   * a judge will wait.
   */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    queueRef.current = [];
    pausedRef.current = false;
    clockRef.current = 0;

    startedRef.current = true;
    setState(EMPTY);
    setElapsedMs(0);
    setStatus("idle");

    void (async () => {
      try {
        await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "reset", ...(sessionId ? { sessionId } : {}) }),
        });
      } catch {
        // A reset that could not reach the server still deserves a fresh run:
        // the stream below re-runs the negotiation either way, and the stale
        // plan it leaves behind is a worse outcome than a retried fetch.
      }
      begin(speedRef.current);
    })();
  }, [begin, sessionId]);

  // The server keeps streaming through a pause; the queue is what holds the
  // room still, so pausing is "stop draining", not "stop listening".
  const pause = useCallback(() => {
    if (status !== "running") return;
    pausedRef.current = true;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setStatus("paused");
  }, [status]);

  const resume = useCallback(() => {
    if (status !== "paused") return;
    pausedRef.current = false;
    setStatus("running");
  }, [status]);

  // Draining on resume happens in an effect rather than inside the setState
  // updater, which React may run twice.
  useEffect(() => {
    if (status === "running" && !pausedRef.current && timerRef.current === null) {
      pump();
    }
  }, [status, pump]);

  const setSpeed = useCallback(
    (next: Speed) => {
      setSpeedState(next);
      speedRef.current = next;
      // The pace lives in the server's delay between frames, so a new speed is
      // a new stream. Restarting is the honest implementation, and on stage it
      // is what a judge expects from "replay this faster".
      if (startedRef.current) begin(next);
    },
    [begin],
  );

  /* ---- The run clock: advances only while the room is live ---------------- */

  useEffect(() => {
    if (status !== "running" && status !== "done") return;
    const running = status === "running";
    const id = window.setInterval(() => {
      clockRef.current += TICK_MS;
      const now = clockRef.current;
      // The HUD reads in seconds, so only publish when the second turns; the
      // sweep below still runs at full granularity.
      if (running) {
        setElapsedMs((prev) =>
          Math.floor(prev / 1000) === Math.floor(now / 1000) ? prev : now,
        );
      }
      setState((s) => {
        const live = s.bubbles.filter((b) => b.expiresAt > clockRef.current);
        return live.length === s.bubbles.length ? s : { ...s, bubbles: live };
      });
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [status]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      // Cleared so a remount starts a fresh run. React's development double-mount
      // would otherwise abort the first stream and refuse to open a second.
      startedRef.current = false;
    },
    [],
  );

  const newest = state.bubbles[state.bubbles.length - 1];
  const lastOffer = state.offers[state.offers.length - 1];

  return {
    ...state,
    currentSpeaker: newest ? newest.speaker : null,
    leadingOffer: state.plan ? state.plan.offer : (lastOffer ?? null),
    status,
    elapsedMs,
    speed,
    start,
    pause,
    resume,
    reset,
    setSpeed,
  };
}
