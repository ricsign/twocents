# PR #25 — fix(itinerary): the build was cancelling itself

## The bug

`/itinerary` sat on "BUILDING YOUR ITINERARY" forever. Not slowly — forever.
The network panel showed one `GET /api/itinerary` ending in `ERR_ABORTED` and
no `POST` at all.

The screen's one effect was written like this:

    if (started.current) return;
    started.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();

In development React runs an effect, tears it down, and runs it again on the
same instance. So the cleanup aborted the only request in flight, and the
`started` guard then made the second run return without starting another. The
guard was there to stop a second POST paying for a second web search; what it
actually did was suppress the retry for the request its own cleanup had just
cancelled.

## The fix

The effect still runs its body exactly once, and nothing cancels it. There was
never anything to cancel: the build is a single POST that the route dedupes per
session and caches on it, so abandoning it early wastes the search rather than
saving it, and a `setStatus` landing after a real unmount has been a no-op
since React 18.

## Verification

Loaded `/itinerary` against the running dev server: the GET returns 200, the
POST fires, the screen moves through "searching" to "checking every link", and
lands on a real document — Cancun, six days, $1,072 each, links to
`inah.gob.mx` and `lorenzillos.com.mx`, seventeen opening times checked.
