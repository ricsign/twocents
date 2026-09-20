"use client";

/**
 * Step 5: the document, on screen and in your downloads.
 *
 * The screen has one job and one piece of machinery. The job is to show the
 * finished PDF; the machinery is that on a cold open the PDF does not exist
 * yet, because building it means searching the web and then fetching every
 * link and photo that came back. So the screen POSTs once, says plainly what
 * is happening while it waits — a live build is about a minute, which is a
 * very long time to show a spinner with no words — and then points an iframe
 * at the finished file.
 *
 * The wait is carried by a progress bar, and the bar is honest about what it
 * knows. `POST /api/itinerary` answers once, at the end: there is no stream of
 * build events to read, so the fill is a clock, not a measurement. It eases
 * towards the far end on the time a live build usually takes and stops short
 * of it, and only the finished response fills it. A bar that sat at 100% while
 * the screen was still waiting would be worse than no bar at all. The stage
 * caption under it is the real sequence the build runs in — search, then
 * verify every link, then lay the document out — so what it names is true even
 * when the moment it names it is approximate.
 *
 * The viewer is the browser's own. No PDF library ships to the client: every
 * browser a judge might open this on already has a renderer that handles
 * selection, zoom, search and printing better than one we would bundle, and
 * `<iframe src="...pdf">` is the most compatible thing there is. The download
 * button is the same URL with `?download=1`, which is one header's difference
 * on the server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { PixelLink } from "@/components/ui/PixelButton";
import { withIdentity, type UrlIdentity } from "@/lib/room/links";

type Status = "checking" | "building" | "ready" | "blocked" | "error";

interface Built {
  destination: string;
  perPerson: number;
  groupTotal: number;
  nights: number;
  live: boolean;
  sources: string[];
  days: number;
  /** What the availability pass did, when it ran. */
  checks: {
    itemsChecked: number;
    repaired: number;
    dropped: number;
    unresolved: string[];
  } | null;
}

/** What the routes answer with. Narrowed here to the handful the screen prints. */
interface ItineraryResponse {
  sessionId?: string;
  itinerary?: {
    destination?: unknown;
    perPerson?: unknown;
    groupTotal?: unknown;
    nights?: unknown;
    live?: unknown;
    sources?: unknown;
    days?: unknown;
    checks?: unknown;
  } | null;
  waitingOn?: unknown;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** The checks block, or null when this document was built before there was one. */
function checksOf(value: unknown): Built["checks"] {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  return {
    itemsChecked: num(raw.itemsChecked),
    repaired: num(raw.repaired),
    dropped: num(raw.dropped),
    unresolved: Array.isArray(raw.unresolved)
      ? raw.unresolved.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function summarise(body: ItineraryResponse): Built | null {
  const it = body.itinerary;
  if (!it) return null;
  return {
    destination: typeof it.destination === "string" ? it.destination : "Your trip",
    perPerson: num(it.perPerson),
    groupTotal: num(it.groupTotal),
    nights: num(it.nights),
    live: it.live === true,
    sources: Array.isArray(it.sources) ? it.sources.filter((s): s is string => typeof s === "string") : [],
    days: Array.isArray(it.days) ? it.days.length : 0,
    checks: checksOf(it.checks),
  };
}

function money(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

/* -------------------------------------------------------------------------- */
/* The progress bar                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Roughly how long a live build takes, measured rather than guessed: the
 * searching model call is around forty seconds and verifying the links and
 * photographs it returned is another fifteen.
 */
const EXPECTED_BUILD_MS = 55_000;

/** Pixel cells across the track, sized to match the fairness meter's segments. */
const TRACK_CELLS = 16;

/** How often the clock moves the bar. Four frames a cell at the start. */
const TICK_MS = 250;

/** The fill never arrives on its own; the finished response is what fills it. */
const MAX_UNFINISHED = 0.94;

/**
 * Elapsed time as a fraction of the track.
 *
 * Asymptotic rather than linear: most of the bar is spent in the first few
 * seconds, and a build that runs long slows down instead of overshooting and
 * having to be clamped in place.
 */
function progressFor(elapsedMs: number): number {
  const eased = 1 - Math.exp(-elapsedMs / (EXPECTED_BUILD_MS / 2));
  return Math.min(MAX_UNFINISHED, eased);
}

/** What the build is doing, in the order `buildItinerary` actually does it. */
const STAGES: readonly { until: number; label: string }[] = [
  { until: 0.45, label: "Searching for real flights, stays and things to do" },
  { until: 0.8, label: "Checking every link and photo answers" },
  { until: 1, label: "Laying out the document" },
];

function stageFor(progress: number): string {
  const stage = STAGES.find((candidate) => progress < candidate.until);
  return (stage ?? STAGES[STAGES.length - 1])!.label;
}

function ProgressBar({ progress }: { progress: number }) {
  const filled = Math.round(progress * TRACK_CELLS);
  const percent = Math.round(progress * 100);

  return (
    <div className="flex w-full flex-col gap-2.5">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% — ${stageFor(progress)}`}
        className="grid w-full gap-1"
        style={{ gridTemplateColumns: `repeat(${TRACK_CELLS}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: TRACK_CELLS }, (_, i) => (
          <div
            key={i}
            className="seg"
            style={{
              background:
                i < filled ? "var(--color-coral)" : "var(--color-parchment)",
              // The leading cell fades in as the clock crosses it, so the bar
              // reads as moving between cells rather than jumping a whole one.
              opacity: i === filled ? 0.45 : 1,
            }}
          />
        ))}
      </div>

      <p aria-hidden="true" className="disp m-0 text-[8px] text-bark">
        {stageFor(progress)}
      </p>
    </div>
  );
}

export function ItineraryScreen({
  sessionId,
  url,
}: {
  sessionId?: string;
  /** Threaded back into this screen's links, so a tab keeps its own identity. */
  url?: UrlIdentity;
}) {
  const [status, setStatus] = useState<Status>("checking");
  const [built, setBuilt] = useState<Built | null>(null);
  const [waitingOn, setWaitingOn] = useState<string[]>([]);
  // Bumped after a build so the iframe refetches rather than showing the 404
  // page it may have cached from a first paint that raced the build.
  const [stamp, setStamp] = useState(0);
  // Milliseconds since the screen started waiting, which is what drives the
  // bar. Held as state rather than read off a ref so the bar re-renders.
  const [elapsed, setElapsed] = useState(0);
  const started = useRef(false);

  /** Both states where the screen has nothing to show but the wait. */
  const waiting = status === "checking" || status === "building";

  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  const viewUrl = `/api/itinerary/pdf${query}${query ? "&" : "?"}v=${stamp}`;
  const downloadUrl = `/api/itinerary/pdf${query}${query ? "&" : "?"}download=1`;

  const load = useCallback(async (): Promise<void> => {
    // The cheap read first: a reload after the document exists should not
    // re-enter the build path at all.
    const existing = await fetch(`/api/itinerary${query}`, { cache: "no-store" });

    if (existing.ok) {
      const summary = summarise((await existing.json()) as ItineraryResponse);
      if (summary) {
        setBuilt(summary);
        setStatus("ready");
        setStamp(Date.now());
        return;
      }
    }

    setStatus("building");
    const res = await fetch("/api/itinerary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionId ? { sessionId } : {}),
    });

    if (res.status === 403) {
      const body = (await res.json()) as ItineraryResponse;
      setWaitingOn(
        Array.isArray(body.waitingOn)
          ? body.waitingOn.filter((id): id is string => typeof id === "string")
          : [],
      );
      setStatus("blocked");
      return;
    }
    if (!res.ok) throw new Error(`itinerary responded ${res.status}`);

    const summary = summarise((await res.json()) as ItineraryResponse);
    if (!summary) throw new Error("the itinerary came back empty");
    setBuilt(summary);
    setStatus("ready");
    setStamp(Date.now());
  }, [query, sessionId]);

  useEffect(() => {
    // Runs exactly once, and nothing cancels it.
    //
    // It used to open an `AbortController` and abort it from the cleanup. In
    // development React runs an effect, tears it down and runs it again on the
    // same instance — so the cleanup aborted the only request in flight, and
    // the `started` guard then made the second run return without starting
    // another. The screen sat on "BUILDING YOUR ITINERARY" forever, having
    // cancelled the one fetch it ever made and suppressed its own retry.
    //
    // There is nothing to cancel here anyway. The build is a single POST the
    // server dedupes per session and caches on it, so abandoning it early
    // wastes the search rather than saving it, and a `setStatus` that lands
    // after a real unmount is a no-op in React 18 and later.
    if (started.current) return;
    started.current = true;

    void (async () => {
      try {
        await load();
      } catch {
        setStatus("error");
      }
    })();
  }, [load]);

  // The clock behind the bar. It is torn down the moment the build lands,
  // blocks or fails. The dependency is the boolean and not `status`, so the
  // cheap "checking" GET giving way to "building" does not restart the clock
  // and send the bar back to the left.
  useEffect(() => {
    if (!waiting) return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Date.now() - startedAt),
      TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, [waiting]);

  if (status !== "ready") {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="flex max-w-[560px] flex-col items-center gap-5 border-4 border-ink bg-card px-9 py-10 text-center px-shadow">
          <p className="disp m-0 text-[12px] leading-relaxed">
            {status === "blocked"
              ? "NOT EVERYBODY HAS APPROVED YET"
              : status === "error"
                ? "THE ITINERARY DIDN’T BUILD"
                : "BUILDING YOUR ITINERARY"}
          </p>

          <p className="m-0 text-[15px] leading-[1.55] text-bark">
            {status === "blocked"
              ? waitingOn.length > 0
                ? `Still waiting on ${waitingOn.join(", ")}. Nothing gets booked until all four approve.`
                : "Nothing gets booked until all four approve."
              : status === "error"
                ? "Something went wrong on the way to the document. Reload to try it again."
                : "Your agents are searching for real flights, real places to stay and real things to do, then checking every link before it goes in. This takes about a minute."}
          </p>

          {waiting ? (
            <ProgressBar progress={progressFor(elapsed)} />
          ) : (
            <PixelLink href={withIdentity("/plan", url)} variant="ghost" className="h-12 px-6">
              BACK TO THE PLAN
            </PixelLink>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-5 px-4 pt-6 pb-8 sm:px-8 min-[1100px]:px-14">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="head m-0 text-[40px] leading-none font-bold">
            {built?.destination}
          </h1>
          <p className="m-0 mt-1.5 text-[15px] font-semibold text-bark">
            {built?.nights} nights · {built?.days} days planned ·{" "}
            {money(built?.perPerson ?? 0)} each, {money(built?.groupTotal ?? 0)} for all four
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <PixelLink href={withIdentity("/plan", url)} variant="ghost" className="h-14 px-5">
            BACK
          </PixelLink>
          {/* A plain anchor, not next/link: this is a file to fetch, not a route
              to navigate, and `download` only means anything on a real anchor. */}
          <a
            href={downloadUrl}
            download
            className="disp px-press px-shadow inline-flex h-14 cursor-pointer items-center justify-center border-4 border-ink bg-coral px-6 text-[11px] text-white no-underline"
          >
            DOWNLOAD PDF
          </a>
        </div>
      </header>

      <div className="flex flex-col gap-2 border-[3px] border-ink bg-card px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            className={`disp text-[9px] ${built?.live ? "text-leaf-deep" : "text-bark"}`}
          >
            {built?.live ? "● BUILT FROM LIVE SEARCH" : "● BUILT OFFLINE"}
          </span>
          <span className="text-[13px] font-semibold text-bark">
            {built?.live
              ? "Every link below was fetched and answered before it went in."
              : "No live search this run, so the links are searches rather than specific bookings."}
          </span>
          {built && built.sources.length > 0 ? (
            <span className="ml-auto truncate text-[12px] font-semibold text-bark">
              {built.sources.slice(0, 6).join(" · ")}
            </span>
          ) : null}
        </div>

        {/* The times, said separately from the links, because they are checked
            by a different pass against a different thing. */}
        {built?.checks ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="disp text-[9px] text-bark">● TIMES CHECKED</span>
            <span className="text-[13px] font-semibold text-bark">
              {built.checks.itemsChecked} of them against the hours each place
              posts
              {built.checks.repaired > 0
                ? `, ${built.checks.repaired} put right`
                : ""}
              {built.checks.dropped > 0
                ? `, ${built.checks.dropped} dropped for being shut`
                : ""}
              .
            </span>
            {built.checks.unresolved.length > 0 ? (
              <span className="text-[13px] font-semibold text-rust">
                {built.checks.unresolved.join(" ")}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* The browser's own PDF viewer. `title` is what a screen reader
          announces, and without it the frame is an unlabelled region. */}
      <iframe
        key={stamp}
        src={viewUrl}
        title={`${built?.destination ?? "Trip"} itinerary, PDF`}
        className="min-h-[560px] w-full flex-1 border-4 border-ink bg-paper"
      />

      <p className="m-0 text-[13px] font-semibold text-bark">
        Can’t see it?{" "}
        <a href={viewUrl} target="_blank" rel="noreferrer">
          Open the PDF in a new tab
        </a>
        .
      </p>
    </main>
  );
}
