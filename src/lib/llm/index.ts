/**
 * Provider selection and the fallback that makes the demo unkillable.
 *
 * Nothing else in the app constructs a provider: the engine and the API routes
 * call `getProvider()` and get something that always answers. Whether that
 * answer came from Claude or from the script is visible in `live`, and nowhere
 * else.
 *
 * Server-only. No React, no DOM.
 */

import type { z } from "zod";
import { AnthropicProvider } from "@/lib/llm/anthropic";
import { OfflineProvider } from "@/lib/llm/offline";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "@/lib/llm/provider";

/**
 * Wraps a live provider so a failure degrades instead of propagating.
 *
 * Rule 2 of `docs/ARCHITECTURE.md`: a missing key, a rate limit, a schema the
 * model fumbled or a call that ran past its deadline all end the same way — the
 * canned answer, in the same shape, at roughly the same moment. The UI cannot
 * tell the difference, and the room never sees an error state.
 */
export class ResilientProvider implements LLMProvider {
  readonly name: string;
  readonly live: boolean;

  private readonly primary: LLMProvider;
  private readonly fallback: LLMProvider;

  constructor(primary: LLMProvider, fallback: LLMProvider = new OfflineProvider()) {
    this.primary = primary;
    this.fallback = fallback;
    this.name = `${primary.name}+${fallback.name}`;
    // Mirrors the primary: a run backed by a real key is still a live run even
    // if one turn fell back, and the cost figure should say so.
    this.live = primary.live;
  }

  async text(req: CompletionRequest): Promise<CompletionResult<string>> {
    try {
      return await this.primary.text(req);
    } catch (err) {
      warn(req, err);
      return this.fallback.text(req);
    }
  }

  async json<T>(
    req: CompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>> {
    try {
      return await this.primary.json(req, schema);
    } catch (err) {
      warn(req, err);
      return this.fallback.json(req, schema);
    }
  }
}

/** One line per fallback. Concise on purpose: a stage log nobody can read is noise. */
function warn(req: CompletionRequest, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(`[llm] ${req.tag} fell back to offline: ${detail}`);
}

let cached: LLMProvider | null = null;

/**
 * The one place that decides whether this run talks to a model.
 *
 * Memoized because the Anthropic client holds a connection pool and the
 * negotiation makes a call per agent per round; rebuilding it per call would
 * add latency the Town screen's timing budget does not have.
 */
export function getProvider(): LLMProvider {
  if (cached) return cached;

  const key = process.env.ANTHROPIC_API_KEY;
  const forcedOffline = process.env.TWOCENTS_FORCE_OFFLINE === "1";

  cached = key && !forcedOffline
    ? new ResilientProvider(new AnthropicProvider(key))
    : new OfflineProvider();

  return cached;
}

/**
 * Drops the memoized provider. Exists for the judges' reset button and for
 * tests: flipping `TWOCENTS_FORCE_OFFLINE` should take effect on the next call,
 * not the next deploy.
 */
export function resetProvider(): void {
  cached = null;
}

export { AnthropicProvider } from "@/lib/llm/anthropic";
export { OfflineProvider } from "@/lib/llm/offline";
export {
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  LlmError,
  MODELS,
  PRICING,
  TIER_FOR_TASK,
  estimateCost,
  llmTimeoutMs,
  usageFrom,
} from "@/lib/llm/provider";
export type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
  ModelTier,
  TaskTag,
} from "@/lib/llm/provider";
