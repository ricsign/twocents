/**
 * The contract every model backend in twocents.ai satisfies.
 *
 * Two providers implement it: a live Anthropic client and a canned offline
 * one. Keeping the interface narrow — text in, text or validated JSON out — is
 * what lets `ResilientProvider` swap one for the other mid-run without the
 * negotiation engine or the UI noticing, which is rule 2 in
 * `docs/ARCHITECTURE.md`: the demo never dies on stage.
 *
 * Server-only. No React, no DOM.
 */

import type { z } from "zod";
import type { Usage } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* Tiers and tasks                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Which size of model a call gets. Two tiers rather than a model id at each
 * call site, so the cost story is decided in one table instead of scattered
 * across the engine.
 */
export type ModelTier = "fast" | "smart";

/**
 * Every distinct thing we ask a model to do. Tagging the call rather than
 * passing a model id means the tier mapping, the cost accounting and the
 * offline provider's canned answer all key off the same value.
 */
export type TaskTag =
  | "brief-reply"      // the agent talking to its own human in the briefing chat
  | "brief-extract"    // pulling structured fields out of that chat
  | "voice-preview"    // one sample line showing how the agent will sound
  | "negotiation-turn" // one agent's public line in the town
  | "offer-check"      // is the trip an agent just proposed actually bookable?
  | "final-plan"       // the agreed plan
  | "agent-report"     // one agent's private report to its human
  | "itinerary";       // the booked-shaped day-by-day, once all four approve

/**
 * Model ids per tier. Overridable by env so a judge's machine, or a last-minute
 * model deprecation the night before the demo, needs no code change.
 */
export const MODELS: Record<ModelTier, string> = {
  fast: process.env.TWOCENTS_MODEL_FAST ?? "claude-haiku-4-5",
  smart: process.env.TWOCENTS_MODEL_SMART ?? "claude-sonnet-4-5",
};

/**
 * List prices in USD per million tokens, used *only* to render the cost figure
 * on the plan screen. These are not billing truth and they drift; treat a
 * difference from an invoice as expected, not as a bug.
 */
export const PRICING: Record<ModelTier, { inputPerMTok: number; outputPerMTok: number }> = {
  fast: { inputPerMTok: 1, outputPerMTok: 5 },
  smart: { inputPerMTok: 3, outputPerMTok: 15 },
};

/**
 * Dollars for one call. Kept as a function rather than inlined arithmetic so
 * the plan screen's number and any slide we build from it come from one place.
 */
export function estimateCost(
  tier: ModelTier,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[tier];
  return (
    (inputTokens / 1_000_000) * p.inputPerMTok +
    (outputTokens / 1_000_000) * p.outputPerMTok
  );
}

/**
 * The Token Company cost story, as a table.
 *
 * Banter is many small calls, so it runs on the cheap model; the two things a
 * human actually reads word by word — the agreed plan and the four private
 * reports — get the expensive one. This mapping is the "before and after cost"
 * slide, so change it here and the number on the plan screen changes with it.
 */
export const TIER_FOR_TASK: Record<TaskTag, ModelTier> = {
  "brief-reply": "fast",
  "brief-extract": "fast",
  "voice-preview": "fast",
  "negotiation-turn": "fast",
  // Reading search results and answering "yes, roughly that price" is
  // comprehension, not composition, so it does not need the large model.
  "offer-check": "fast",
  "final-plan": "smart",
  "agent-report": "smart",
  // A document somebody prints and carries. Same reasoning as the plan: this is
  // read word by word, so it gets the model that writes well.
  itinerary: "smart",
};

/* -------------------------------------------------------------------------- */
/* Call shapes                                                                 */
/* -------------------------------------------------------------------------- */

/** Ceiling when a caller does not set one. Turns in the town are one or two sentences. */
export const DEFAULT_MAX_TOKENS = 400;

/** Default wall-clock ceiling on a single model call, in milliseconds. */
export const DEFAULT_LLM_TIMEOUT_MS = 20_000;

/**
 * Read at call time, not at import time, so a `.env` change or a stage-side
 * tightening ("nothing waits more than 8 seconds tonight") takes effect on the
 * next call rather than the next restart.
 */
export function llmTimeoutMs(): number {
  const raw = Number(process.env.TWOCENTS_LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LLM_TIMEOUT_MS;
}

/** One request to a model, independent of which provider answers it. */
export interface CompletionRequest {
  tag: TaskTag;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
  /** Free-form hints the offline provider keys its canned answer off. */
  context?: Record<string, unknown>;
  /**
   * Ground this call in a live web search.
   *
   * Anthropic runs the queries server-side and hands the results back inside
   * the same request, so this stays one call rather than a tool loop we drive.
   * The offline provider ignores it and answers from canned facts, which is
   * what keeps a run with no network on the same rails as one with it.
   */
  webSearch?: { maxUses: number };
  /**
   * Wall-clock ceiling for this one call, overriding `llmTimeoutMs()`.
   *
   * The shared default is sized for the calls the demo makes by the dozen —
   * a negotiation turn is two sentences and has to land inside a beat of
   * screen time. A call that searches the web eight times and writes a whole
   * document is a different animal: it routinely runs past that default, and
   * under it the itinerary never once came back from the model. Set it only
   * where the work genuinely takes longer, and never on anything the town
   * screen waits on.
   */
  timeoutMs?: number;
}

/**
 * One page the model actually opened during a searching call.
 *
 * Reported by the API alongside the answer, so these are pages that were
 * fetched, not URLs a model wrote down — which is the whole reason they are
 * safe to print as links. `host` is carried rather than derived at render time
 * because it is what a person reads before deciding whether to click.
 */
export interface SearchSource {
  title: string;
  url: string;
  host: string;
}

/**
 * The answer plus its receipt. `raw` is kept alongside `value` because the
 * transcript and any debugging we do at 3am want the untouched text, while the
 * engine wants the parsed thing.
 */
export interface CompletionResult<T> {
  value: T;
  raw: string;
  usage: Usage;
  /**
   * What the call searched, when it searched. Empty for every call that did
   * not, and for the offline provider, which never reaches the network — so an
   * empty list means "nothing was looked up", and the UI can say so rather
   * than implying a check that never happened.
   */
  sources: SearchSource[];
}

/** A model backend. Implemented live, canned, and wrapped. */
export interface LLMProvider {
  readonly name: string;
  /** false when this provider is canned — the UI may label the run "offline". */
  readonly live: boolean;
  text(req: CompletionRequest): Promise<CompletionResult<string>>;
  json<T>(req: CompletionRequest, schema: z.ZodType<T>): Promise<CompletionResult<T>>;
}

/* -------------------------------------------------------------------------- */
/* Errors and accounting                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every failure a provider raises, carrying the task that failed so the
 * fallback log names something a human can act on ("final-plan timed out")
 * rather than a stack trace.
 */
export class LlmError extends Error {
  readonly tag: TaskTag;

  constructor(tag: TaskTag, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmError";
    this.tag = tag;
  }
}

/**
 * Builds the per-call `Usage` row. Lives next to `PRICING` so a provider can
 * never report tokens without also reporting what they cost.
 */
export function usageFrom(
  tier: ModelTier,
  inputTokens: number,
  outputTokens: number,
): Usage {
  return {
    inputTokens,
    outputTokens,
    calls: 1,
    estimatedCostUsd: estimateCost(tier, inputTokens, outputTokens),
    model: [MODELS[tier]],
  };
}
