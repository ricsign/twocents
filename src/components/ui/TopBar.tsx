import Link from "next/link";
import { CoinIcon } from "./PixelIcons";

export type Step = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<Step, string> = {
  1: "STEP 1 · BRIEF",
  2: "STEP 2 · PERSONALITY",
  3: "STEP 3 · THE TOWN",
  4: "STEP 4 · THE PLAN",
};

const STEPS: Step[] = [1, 2, 3, 4];

/** Where a pip goes when it is a link. Step 4 is never one; it is the last. */
const STEP_HREFS: Record<Step, string> = {
  1: "/brief",
  2: "/personality",
  3: "/town",
  4: "/plan",
};

const DONE = "#5C9E4A";
const CURRENT = "#F2B84B";
const TODO = "#5A4634";

/**
 * The persistent 60px dark bar: logo, trip name, current step and four pips.
 * Pips read green for done, gold for current, muted for not-yet.
 *
 * The green ones are links. The flow only ever pushed forward — `/plan` in
 * particular had no way out at all — so a judge who wanted to see the brief
 * again, or re-watch the town, had to reach for the browser's back button and
 * hope. A step already completed is a page that exists and is safe to revisit,
 * which is exactly the set the pips were already colouring green. The ones
 * ahead stay decorative: they are not reachable yet, and a link that lands on
 * a redirect is worse than no link.
 *
 * The 12px square is too small to hit on a projector, so each link carries
 * padding it gives straight back with a negative margin — a 20px target that
 * does not move the row.
 *
 * The logo goes home, which is the one thing a wordmark in a bar is expected to
 * do — and the icon and the words are one target rather than two, because
 * aiming at a 24px coin is not the game. It is the only way out of the flow
 * that does not depend on the browser's back button: `/` is static, reads no
 * cookie and no session, so it is reachable from any screen and from any state.
 */
export function TopBar({
  step,
  tripName = "Grad Trip ’27",
}: {
  step: Step;
  tripName?: string;
}) {
  return (
    <header className="flex h-[60px] shrink-0 items-center justify-between bg-ink px-6 text-parchment sm:px-12">
      <Link
        href="/"
        aria-label="twocents.ai — back to the start"
        className="flex items-center gap-3 text-parchment no-underline"
      >
        <CoinIcon size={24} />
        <span className="disp text-[12px]">twocents.ai</span>
      </Link>

      <div className="head hidden text-[20px] font-semibold sm:block">
        {tripName}
      </div>

      <div className="flex items-center gap-3.5">
        <div className="disp text-[9px] text-gold">{STEP_LABELS[step]}</div>
        <nav aria-label="Completed steps" className="flex gap-1.5">
          {STEPS.map((s) =>
            s < step ? (
              <Link
                key={s}
                href={STEP_HREFS[s]}
                aria-label={`Back to ${STEP_LABELS[s]}`}
                className="-m-1 p-1"
              >
                <span className="block h-3 w-3" style={{ background: DONE }} />
              </Link>
            ) : (
              <span
                key={s}
                aria-hidden="true"
                className="block h-3 w-3"
                style={{ background: s === step ? CURRENT : TODO }}
              />
            ),
          )}
        </nav>
      </div>
    </header>
  );
}
