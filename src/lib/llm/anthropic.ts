/**
 * The live provider: real Claude calls, with the two guarantees the rest of the
 * app is written against.
 *
 * 1. `json()` returns something that passed the caller's zod schema, or throws.
 *    It never hands back "the model mostly wrote JSON". That is achieved with
 *    tool use, not by asking politely in the prompt.
 * 2. No call outlives its deadline. A negotiation turn that hangs is worse than
 *    a canned one, because the room on stage goes quiet.
 *
 * Server-only. No React, no DOM.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  DEFAULT_MAX_TOKENS,
  LlmError,
  MODELS,
  TIER_FOR_TASK,
  llmTimeoutMs,
  usageFrom,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
  type TaskTag,
} from "@/lib/llm/provider";

/** The single tool every structured call is forced through. */
const EMIT_TOOL = "emit";

/** Pause before the one retry. Short: the demo budget is seconds, not minutes. */
const RETRY_BACKOFF_MS = 400;

/**
 * Identity marker for a deadline expiry, so the retry logic can tell "we ran
 * out of time" apart from "the model refused" without string-matching messages.
 */
const TIMEOUT_CAUSE = { reason: "timeout" } as const;

/** Narrowing helper: anything that is a plain keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Worth trying once more: rate limits, server faults and our own deadline.
 * A 400 or a schema failure is not — retrying those just burns the clock.
 */
function isTransient(err: unknown): boolean {
  if (err instanceof LlmError) return err.cause === TIMEOUT_CAUSE;
  if (isRecord(err)) {
    const status = err.status;
    if (typeof status === "number") return status === 429 || (status >= 500 && status < 600);
  }
  if (err instanceof Error) {
    return /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(err.message);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turns a zod schema into the JSON Schema the tool definition needs.
 *
 * zod v4 ships `toJSONSchema`, but a schema with an unrepresentable branch (or
 * a future zod that moves the function) must not take the demo down, so an
 * unusable conversion degrades to a permissive object schema and lets
 * `schema.parse` be the real gate afterwards.
 */
function jsonSchemaFor(schema: z.ZodType<unknown>): Record<string, unknown> {
  const convert = (z as unknown as {
    toJSONSchema?: (s: unknown, opts?: Record<string, unknown>) => unknown;
  }).toJSONSchema;

  if (typeof convert === "function") {
    try {
      const out = convert(schema, {
        target: "draft-7",
        io: "input",
        unrepresentable: "any",
      });
      if (isRecord(out) && out.type === "object") {
        const { $schema: _ignored, ...rest } = out;
        void _ignored;
        return rest;
      }
    } catch {
      // Fall through to the permissive schema below.
    }
  }
  return { type: "object" };
}

/** Joins every text block of a response into the one string a caller wanted. */
function textOf(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Talks to Claude. Constructed with an explicit key rather than reading the
 * environment itself, so `getProvider()` owns the one decision about whether we
 * are live at all.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly live = true;

  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async text(req: CompletionRequest): Promise<CompletionResult<string>> {
    const tier = TIER_FOR_TASK[req.tag];
    const message = await this.guarded(req.tag, (signal) =>
      this.client.messages.create(
        {
          model: MODELS[tier],
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          system: req.system,
          messages: req.messages,
        },
        { signal },
      ),
    );

    const raw = textOf(message);
    if (!raw) {
      throw new LlmError(req.tag, "Model returned no text block");
    }
    return {
      value: raw,
      raw,
      usage: usageFrom(tier, message.usage.input_tokens, message.usage.output_tokens),
    };
  }

  async json<T>(
    req: CompletionRequest,
    schema: z.ZodType<T>,
  ): Promise<CompletionResult<T>> {
    const tier = TIER_FOR_TASK[req.tag];
    const tool = {
      name: EMIT_TOOL,
      description:
        "Emit the answer as structured data. Every field is required unless the schema marks it optional.",
      input_schema: jsonSchemaFor(schema) as unknown as Anthropic.Messages.Tool["input_schema"],
    } satisfies Anthropic.Messages.Tool;

    const message = await this.guarded(req.tag, (signal) =>
      this.client.messages.create(
        {
          model: MODELS[tier],
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
          system: req.system,
          messages: req.messages,
          tools: [tool],
          // Forcing the tool is what makes the output JSON by construction:
          // the model cannot answer in prose even if it wants to.
          tool_choice: { type: "tool", name: EMIT_TOOL },
        },
        { signal },
      ),
    );

    const block = message.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    if (!block) {
      throw new LlmError(req.tag, "Model did not call the emit tool");
    }

    const parsed = schema.safeParse(block.input);
    if (!parsed.success) {
      throw new LlmError(req.tag, `Tool output failed schema: ${parsed.error.message}`, {
        cause: parsed.error,
      });
    }

    return {
      value: parsed.data,
      raw: JSON.stringify(block.input),
      usage: usageFrom(tier, message.usage.input_tokens, message.usage.output_tokens),
    };
  }

  /**
   * One deadline and at most one retry around every request. Both live here so
   * neither `text` nor `json` can forget one of them.
   */
  private async guarded<T>(
    tag: TaskTag,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS);
      try {
        return await this.deadline(tag, run);
      } catch (err) {
        lastError = err;
        if (!isTransient(err)) break;
      }
    }
    if (lastError instanceof LlmError) throw lastError;
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new LlmError(tag, `Model call failed: ${detail}`, { cause: lastError });
  }

  /** Races the request against the clock and aborts the loser. */
  private deadline<T>(
    tag: TaskTag,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ms = llmTimeoutMs();
    const controller = new AbortController();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(
          new LlmError(tag, `Model call exceeded ${ms}ms`, { cause: TIMEOUT_CAUSE }),
        );
      }, ms);

      run(controller.signal).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
