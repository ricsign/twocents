/**
 * What a model is allowed to tell us it saw in a group chat.
 *
 * This schema is handed to the `emit` tool, so it is the actual contract the
 * model answers against rather than a hope expressed in a prompt. Two things
 * follow from that, and both are deliberate.
 *
 * **There is no field anywhere here that can hold a number of dollars.** Not a
 * nullable one, not an optional one. A screenshot may well contain "I can only
 * do $600", and writing that into somebody's seat would mean the host's
 * photograph decided another person's private ceiling — the one thing this
 * product promises never happens. The prompt says so too, but the prompt is
 * advice and this is the guarantee: `moneyTone` is an enum, so it cannot carry
 * digits even if the model tries. It is the same discipline
 * `buildPublicSystemPrompt` uses, where the public prompt cannot reach a
 * budget because the argument it is handed does not have one.
 *
 * **Every field is bounded.** `jsonSchemaFor` converts this straight into the
 * tool's input schema, and an unbounded array is how a call hits the token
 * ceiling mid-answer and comes back as nothing.
 *
 * Strings are deliberately not `.trim()`ed here: zod's trim is a transform, and
 * a transform in a schema bound for `z.toJSONSchema` risks degrading the whole
 * thing to a bare object. Trimming happens in `seats.ts`, after parsing.
 */

import { z } from "zod";
import { moneyToneSchema } from "@/lib/room/seat";

/* -------------------------------------------------------------------------- */
/* What the browser may send                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The long edge every screenshot is scaled to before upload.
 *
 * Anthropic scales anything past roughly this down on its side anyway, so a
 * larger picture costs upload seconds and buys no more detail. Never scale
 * *up*: a small screenshot is small because it is small.
 */
export const MAX_EDGE_PX = 1568;

/** Four screenshots is a whole scrollback. Past that, ask for a tighter crop. */
export const MAX_IMAGES = 4;

/**
 * Ceiling on the base64, not on the decoded bytes.
 *
 * Base64 inflates by a third, and the number that matters is what goes over
 * the wire: an App Router route handler has no body cap of its own, but hosts
 * do — Vercel stops at 4.5 MB and no Next setting moves it. Measuring the
 * encoded length is measuring the thing that actually gets rejected.
 */
export const MAX_TOTAL_B64 = 4_000_000;

/** Phone screenshots are PNG; a photo of somebody's laptop is JPEG. */
export const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/webp"] as const;

export const uploadedImageSchema = z.object({
  mediaType: z.enum(ACCEPTED_MIME),
  /** Raw base64, no data-URI prefix. The client strips it before sending. */
  dataBase64: z.string().min(1),
});

export const ingestRequestSchema = z.object({
  images: z.array(uploadedImageSchema).min(1).max(MAX_IMAGES),
  /** Optional nudge from the host: "this is the ski trip, not the wedding". */
  topicHint: z.string().max(60).optional(),
});

/* -------------------------------------------------------------------------- */
/* What the model may answer                                                   */
/* -------------------------------------------------------------------------- */

const extractedPersonSchema = z.object({
  /** Exactly as the chat shows it: "@jules", "Mom", "Jordan K.". */
  handle: z.string().max(40),
  /** A readable form of the same person; equal to the handle when there is nothing better. */
  displayName: z.string().max(40),
  /**
   * How many messages are attributable to this person across every image.
   *
   * The ranking key, and the reason it is a count rather than a judgement:
   * "who is actually going on this trip" is not readable off a screenshot, but
   * "who is doing the planning" is, and it is the better proxy. Four seats and
   * often more than four people in a chat, so something has to decide.
   */
  messageCount: z.number().int().min(0).max(200),
  /** Whoever is driving this — started the thread, proposed it. At most one. */
  isHost: z.boolean(),
  /** One line, their words where possible. Becomes `Brief.destinationWant`. */
  want: z.string().max(240),
  /** Scored separately by the fairness meter, so these are claims, not a sentence. */
  wants: z.array(z.string().max(120)).max(4),
  /** Only a hard no they actually stated. Never inferred from tone. */
  dealbreakers: z.array(z.string().max(120)).max(3),
  /** "" when this person named none. Free text: "the week of the 14th". */
  dates: z.string().max(60),
  /** A sentence or two on what they are like. Becomes `Personality.bio`. */
  bio: z.string().max(200),
  /** A guess at the four sliders, on the same poles as `personalitySchema`. */
  personality: z.object({
    stubborn: z.number().int().min(0).max(100),
    splurgy: z.number().int().min(0).max(100),
    blunt: z.number().int().min(0).max(100),
    adventurous: z.number().int().min(0).max(100),
  }),
  /** How money was talked about. An enum, so it can never be a figure. */
  moneyTone: moneyToneSchema,
  /** "clear" when the chat says it outright, "unsure" when this is inference. */
  confidence: z.enum(["clear", "unsure"]),
  /**
   * The line `want` was read off, quoted.
   *
   * The actual "show your work". A host reading *jules: pls not another beach
   * week* beside a want can tell in half a second whether we got it right,
   * which is worth more than any confidence score. Shown on the review screen
   * and deliberately not carried into the brief: it is a verbatim quote of
   * somebody who is not in the room yet.
   */
  evidence: z.string().max(160),
  /** The handle this person is probably also posting under, or null. */
  duplicateOf: z.string().max(40).nullable(),
});

/** One person, as read off the chat. */
export type ExtractedPerson = z.infer<typeof extractedPersonSchema>;

export const chatExtractionSchema = z.object({
  /** False when the image is too blurry, dark or cropped to read text from. */
  readable: z.boolean(),
  /** False when it is a real chat but nobody is planning anything. */
  isTripPlanning: z.boolean(),
  /** Becomes `DemoSession.tripName`. "Grad trip", "Dinner Friday". */
  topic: z.string().max(60),
  /** Places anyone named. Seeds an open seat's want and the opening offers. */
  destinationCandidates: z.array(z.string().max(60)).max(4),
  /** The dates the group converged on, free text. "" when unsettled. */
  dates: z.string().max(60),
  /** Everyone who spoke. Up to eight; the server ranks and keeps four. */
  people: z.array(extractedPersonSchema).max(8),
  /** Anything a host should know: "two handles may be the same person". */
  notes: z.array(z.string().max(160)).max(3),
});

/** A whole group chat, as read. */
export type ChatExtraction = z.infer<typeof chatExtractionSchema>;
