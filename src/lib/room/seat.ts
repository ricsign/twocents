/**
 * What one seat at the table looks like, before anything is done with it.
 *
 * Split out of `seed.ts` rather than living beside the seeding for one very
 * concrete reason: the review screen is a client component and it edits these,
 * so it has to import the type. `seed.ts` reaches the session store, which
 * reaches `node:fs`, and importing a type from it drags the filesystem into
 * the browser bundle — which Turbopack refuses to build, correctly.
 *
 * So this file stays pure: zod, the cast, and the domain model. Nothing here
 * touches a store, a request or a disk.
 */

import { z } from "zod";
import { participantIdSchema } from "@/lib/types";

/**
 * How money got talked about, with no figure attached.
 *
 * The photo path needs *some* read on where a person sits between frugal and
 * splurgy, because that is the axis the room argues hardest along and four
 * identical agents produce a polite, boring negotiation. It must not be a
 * number. An enum cannot hold one, so this is the guarantee rather than the
 * intention: even a screenshot that literally contains "I can only do $600"
 * can only arrive here as `"cheap"`.
 */
export const moneyToneSchema = z.enum(["cheap", "mixed", "splurgy", "unstated"]);

/** How money got talked about. */
export type MoneyTone = z.infer<typeof moneyToneSchema>;

/** One seat at the table, however it came to be described. */
export const seatBriefSchema = z.object({
  participantId: participantIdSchema,
  /** Who the agent speaks for. Quoted into the agent's own persona. */
  name: z.string().trim().min(1).max(40),
  /** One line: "somewhere with actual vegetarian food, not a side salad". */
  want: z.string().trim().min(1).max(240),
  /**
   * The private ceiling.
   *
   * Always null from the photo path, and null from the judges' round when the
   * judge left the field blank. Never guessed: the person supplies it to their
   * own agent, or nobody has it.
   */
  budget: z.number().min(0).max(100_000).nullable(),
  /** Pre-split wants. Omitted means `splitWants(want)` decides. */
  wants: z.array(z.string().trim().min(1).max(120)).max(4).optional(),
  dealbreakers: z.array(z.string().trim().min(1).max(120)).max(3).optional(),
  /** A per-person date override; falls back to the room's `when`. */
  dates: z.string().trim().max(60).optional(),
  /** The sentence quoted into the agent's voice. Omitted means the `who said` form. */
  bio: z.string().trim().max(200).optional(),
  /** Slider guesses. Anything omitted falls back to the seeded personality. */
  personality: z
    .object({
      stubborn: z.number().int().min(0).max(100),
      splurgy: z.number().int().min(0).max(100),
      blunt: z.number().int().min(0).max(100),
      adventurous: z.number().int().min(0).max(100),
    })
    .partial()
    .optional(),
  /** Money talk with no figure. Drives the slider when no budgets exist at all. */
  moneyTone: moneyToneSchema.optional(),
  /** Where this description came from, when it was not the person themselves. */
  draft: z
    .object({
      source: z.literal("photo"),
      handle: z.string().trim().max(40),
      confidence: z.enum(["clear", "unsure"]),
    })
    .optional(),
});

/** One seat at the table. */
export type SeatBrief = z.infer<typeof seatBriefSchema>;
