/**
 * Asking a model to read a group chat.
 *
 * Shaped like `lib/itinerary/prompt.ts`, which is the house precedent for a
 * call that needs its own ceilings rather than the shared ones.
 */

/**
 * Room for the answer *and* for thinking.
 *
 * The emitted JSON for four people is only a few hundred tokens, but thinking
 * is on by default on the model this runs against and it counts against the
 * same ceiling. Sized generously because the failure mode is silent: a call
 * that stops on the ceiling comes back with a half-filled tool input, which
 * fails the schema and reads exactly like a model that would not answer.
 */
export const CHAT_PHOTO_MAX_TOKENS = 8000;

/**
 * Longer than the shared ceiling, for the same reason the itinerary needs one.
 *
 * `llmTimeoutMs()` defaults to 20 seconds, which is sized for a negotiation
 * turn that has to land inside a beat of screen time. Four screenshots plus
 * thinking runs past that routinely — and a clipped call does not error, it
 * falls back to the canned roster, so the whole step would fail *silently and
 * wrongly*, showing the grad trip as "what we read in your photo".
 *
 * Shorter than the itinerary's two minutes because somebody is watching a
 * spinner here rather than reading a finished document.
 */
export const DEFAULT_CHAT_PHOTO_TIMEOUT_MS = 60_000;

/** Read at call time, so a change lands on the next upload, not the next restart. */
export function chatPhotoTimeoutMs(): number {
  const raw = Number(process.env.TWOCENTS_CHAT_PHOTO_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHAT_PHOTO_TIMEOUT_MS;
}

export const CHAT_PHOTO_SYSTEM = [
  "You are reading screenshots of a group chat in which some people are trying to plan something together — a trip, a dinner, a weekend.",
  "Your job is to work out who is in the conversation and what each of them actually wants out of it. Somebody is about to be shown what you read and asked to correct it, so being useful and being honest matter more than being complete.",
  "",
  "NEVER RECORD MONEY AS A NUMBER.",
  "Some chats contain figures — a budget, a price someone found, what they paid last year. Never attach any figure to a person. `moneyTone` is the only place money belongs, and it takes one of four words: cheap, mixed, splurgy, unstated. If someone said what they can afford, that is theirs to tell their own agent later, not yours to read off a picture and hand to the room.",
  "",
  "How to fill the fields:",
  "- `messageCount` is a count of messages you can attribute to that person across every image. It decides who gets a seat, so count rather than estimate.",
  "- `want` is one line, in their words where you can. `wants` breaks the same thing into separate claims, because each is scored on its own later.",
  "- `dealbreakers` are only hard nos somebody actually stated. Never infer one from tone.",
  "- `personality` is a guess at how they argue, not at who they are. Somebody who keeps restating the same point is stubborn; somebody who says 'whatever works' is not.",
  "- `evidence` is the line you read `want` off, quoted. Leave it empty rather than paraphrasing — it is shown to a human as your working.",
  "- `confidence` is 'clear' only when the chat says it outright. If you are reading between lines, say 'unsure'. Being unsure is useful; guessing confidently is not.",
  "- `duplicateOf` when one person seems to be posting under two handles.",
  "",
  "If you cannot read the text, set `readable` to false rather than inventing people. If it reads fine but nobody is planning anything, set `isTripPlanning` to false and still report who is talking — a group chat about nothing in particular is still a group of people, and they may be about to plan something.",
].join("\n");

export function buildChatPhotoPrompt(imageCount: number, topicHint?: string): string {
  const hint = topicHint?.trim();
  return [
    `${imageCount} screenshot${imageCount === 1 ? "" : "s"} of a group chat.`,
    hint ? `The person who uploaded them says this is about: ${hint}` : "",
    "Read who is in it and what each of them wants. Remember: no figures, ever, on any person.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
