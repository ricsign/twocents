# PR #21 — fix(voice): the sample line argues about this room

## The bug

`/api/voice` writes the richer sample line that replaces the instant one 350ms
after a slider stops moving. Its system prompt asserted, flatly, that *"the
group is arguing about a spring trip; someone has just proposed Cancun"*, and
the offline provider's nine canned previews named Cancun, the catamaran day
and a $1,180 price in their own text.

That was true of exactly one session: the seeded grad trip. PR #20 derived the
*instant* line from the room the person is actually in, which left the screen
with a worse tell than the one it fixed — the first sentence talked about the
judge's own dinner, and then a third of a second later it turned into Mexico.

## The change

The one public noun the preview needs, `contested`, now travels with the
request. It is the same value `sampleTopicFor` derives from the sanitized
mandates the other three agents already publish, so nothing reaches the prompt
that was not already sayable in the room: a `PublicMandate` carries a price
*stance*, never a ceiling. It is capped at 60 characters, because a field that
lands in a system prompt is a field a caller could otherwise write a paragraph
into.

The nine offline lines take the same noun in a `{it}` slot and lost the price
figure. Only the contested option is substituted, never the person's own want:
the contested option arrives as a place or a plan and reads correctly
mid-sentence, while a want arrives as a fragment in the human's own words and
does not.

Two smaller repairs ride along. The title screen reads its four names from the
session rather than the cast, so a judges' round is not introduced to people
who left; it gives up being the app's one static page to do it. And the Town's
pause button is now disabled on a run that was painted from the session rather
than streamed, where it had nothing to pause.

## Verification

`npm run typecheck`, `npm run lint`, `npm run check` all clean; the voice
preview is not covered by the check suites, which is why the two nouns are
constrained by schema rather than by test.
