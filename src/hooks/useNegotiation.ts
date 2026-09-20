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
 * - **A finished run is initial state, not something to re-derive.** The town
 *   screen can be arrived at with the session already holding a plan — browser
 *   back from `/plan`, a reload, a remount — and streaming a second run over
 *   the top of it would overwrite the very outcome the plan screen just showed.
 *   So the caller hands the stored run in, it becomes the opening state, and
 *   running again is something a judge asks for by name.
 * - **A run somebody else started is adopted, not raced.** `/api/negotiate`
 *   allows one negotiation per session and answers 409 to the second caller.
 *   This hook waits for the winner's result and paints that, which is the same
 *   thing it does with a run the session was already holding.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { YOU, type ParticipantId } from "@/lib/characters";
import { sessionViewSchema } from "@/lib/session-view";
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

/**
 * A run the session is already holding, as the town screen should paint it.
 *
 * Narrowed on the server by `sessionViewFor` before it gets here, so `turns`
 * carries this viewer's own private reasons and nobody else's — the same rule
 * the live stream applies frame by frame.
 */
export interface FinishedRun {
  turns: NegotiationTurn[];
  plan: Plan;
}

export interface NegotiationOptions {
  sessionId?: string;
  /** The stored run to open on, or null to open empty and wait for `start`. */
  finished?: FinishedRun | null;
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
  /** Argue it out again, from the briefs and personalities the room has now. */
  rerun: () => void;
  /** Throw the room away, rebuild it from the seed, and go back to step 1. */
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

/**
 * The stored run, as the state a live stream would have arrived at.
 *
 * No bubbles: the conversation is over, and a speech bubble that never fades
 * would claim somebody is still mid-sentence. The transcript is the record, and
 * it is complete. `offers` is gathered off the turns that carry one so
 * `leadingOffer` reads the same after a replay as it does after a live run.
 */
function replay(finished: FinishedRun | null): StreamState {
  if (!finished) return EMPTY;

  const offers: Offer[] = [];
  for (const turn of finished.turns) {
    const offer = turn.offer;
    if (offer && !offers.some((o) => o.id === offer.id)) offers.push(offer);
  }

  const last = finished.turns[finished.turns.length - 1];
  return {
    ...EMPTY,
    round: last ? last.round : 0,
    turns: finished.turns,
    offers,
    plan: finished.plan,
  };
}

/** The route's answer when another screen already holds this session's run. */
const ALREADY_RUNNING = 409;

/**
 * How long to watch the session for that other run to land, and how often.
 *
 * The run that beat us to it is `/plan`'s headless one, which drains at 8x and
 * is usually done inside a few seconds; the budget is long enough that a live
 * model run does not fall off the end of it either.
 */
const ADOPT_POLL_MS = 900;
const ADOPT_POLL_TRIES = 120;

/** Resolves after `ms`, or at once if the caller has already given up. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * The run another screen is already streaming, read out of the session once it
 * lands.
 *
 * `/api/negotiate` allows one negotiation per session and answers 409 to the
 * second caller, which on stage is the step-3 pip tapped while `/plan` is
 * still draining its headless run. That run is writing the very outcome this
 * screen wants, so the honest thing is to wait for it and paint it, exactly as
 * a browser-back onto a finished session paints one. Returns null if it never
 * arrives, and the caller shows the error state it always did.
 */
async function adoptInFlightRun(
  sessionId: string,
  signal: AbortSignal,
): Promise<FinishedRun | null> {
  for (let attempt = 0; attempt < ADOPT_POLL_TRIES; attempt += 1) {
    await sleep(ADOPT_POLL_MS, signal);
    if (signal.aborted) return null;

    try {
      const res = await fetch(
        `/api/session?viewer=${YOU}&sessionId=${encodeURIComponent(sessionId)}`,
        { cache: "no-store", signal },
      );
      if (!res.ok) continue;
      const parsed = sessionViewSchema.safeParse((await res.json()) as unknown);
      if (parsed.success && parsed.data.plan) {
        return { turns: parsed.data.turns, plan: parsed.data.plan };
      }
    } catch {
      if (signal.aborted) return null;
      // A single failed read is not the run failing. Ask again.
    }
  }
  return null;
}

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

export function useNegotiation({
  sessionId = "demo",
  finished = null,
}: NegotiationOptions = {}): Negotiation {
  const router = useRouter();
  // Read once, as initial state. A later render handing over a different
  // `finished` must not reach in and rewrite a run that is already streaming.
  const [state, setState] = useState<StreamState>(() => replay(finished));
  const [status, setStatus] = useState<NegotiationStatus>(
    finished ? "done" : "idle",
  );
  const [speed, setSpeedState] = useState<Speed>(1);
  // The stored run's own measured time, so the HUD reads the same number the
  // plan screen prints rather than counting up from zero for a finished run.
  const [elapsedMs, setElapsedMs] = useState(
    finished ? finished.plan.agreedInMs : 0,
  );

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
          // `viewer` is what the route narrows each frame to: the town shows
          // everyone's lines but only ever this person's private reasons, and
          // the `done` frame arrives carrying one report instead of four. The
          // plan screen reads that report back from `/api/session` anyway, so
          // nothing here needs the other three.
          body: JSON.stringify({ sessionId, viewer: YOU, speed: runSpeed }),
          signal: controller.signal,
        });
        if (response.status === ALREADY_RUNNING) {
          const adopted = await adoptInFlightRun(sessionId, controller.signal);
          if (controller.signal.aborted) return;
          if (!adopted) {
            setStatus("error");
            return;
          }
          setState(replay(adopted));
          setElapsedMs(adopted.plan.agreedInMs);
          setStatus("done");
          return;
        }
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
   * Run it again with the room exactly as it stands.
   *
   * The distinction from `reset` is the whole point: this keeps every brief and
   * every slider and argues from them a second time, which is what a judge
   * means by "run that again" after a personality flip. `begin` already aborts
   * the outgoing stream and clears the room, and `/api/negotiate` replaces the
   * session's turns and plan rather than appending to them, so nothing from the
   * previous run survives into this one.
   */
  const rerun = useCallback(() => {
    startedRef.current = true;
    begin(speedRef.current);
  }, [begin]);

  /**
   * The judges' reset: throw the whole room away, rebuild it from the seed,
   * and go back to step 1.
   *
   * Restarting the stream alone would have left the previous run's plan,
   * approvals, transcript and token tally sitting in the session store, so the
   * plan screen after a "fresh" run would still have shown the old one. The
   * POST replaces the session object outright — `resetSession` builds a new
   * seed rather than diffing the old one.
   *
   * What it does *not* do any more is start a negotiation. The seeded brief
   * for the person at the keyboard is empty, so a fresh seed is a room where
   * one of the four has been told nothing; `/town` and `/personality` both
   * redirect an empty seat back to `/brief`, and this button was arguing that
   * room out at the same time as the screen it ran on was being bounced off.
   * `/brief` is the only honest destination for a session in that state, and
   * it is also the beat the demo restarts from.
   *
   * That total-ness is the reason `rerun` exists beside it. Reseeding also
   * discards whatever the person in the seat told their agent and whatever they
   * did to the sliders, which is right between judges and wrong every other
   * time. The control that does this says so.
   *
   * The abort comes first so no frame from the outgoing run can write itself
   * into the session the POST is about to replace. `router.refresh()` before
   * the push is the same reason `RunStats` does it: every screen here renders
   * the session on the server, so the cached payload for the page being left
   * would otherwise still describe the run that just ended.
   */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    queueRef.current = [];
    pausedRef.current = false;
    clockRef.current = 0;

    // Nothing auto-starts between here and the navigation below.
    startedRef.current = true;
    setState(EMPTY);
    setElapsedMs(0);
    setStatus("idle");

    void (async () => {
      try {
        await fetch("/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "reset", sessionId }),
        });
      } catch {
        // A reset that could not reach the server still has to land somewhere
        // the presenter can work from, and `/brief` renders whatever the
        // session holds. Better a retried reset than a stranded screen.
      }
      router.refresh();
      router.push("/brief");
    })();
  }, [router, sessionId]);

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
    rerun,
    reset,
    setSpeed,
  };
}
