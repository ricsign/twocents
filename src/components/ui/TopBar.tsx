import { CoinIcon } from "./PixelIcons";

export type Step = 1 | 2 | 3 | 4;

const STEP_LABELS: Record<Step, string> = {
  1: "STEP 1 · BRIEF",
  2: "STEP 2 · PERSONALITY",
  3: "STEP 3 · THE TOWN",
  4: "STEP 4 · THE PLAN",
};

/**
 * The persistent 60px dark bar: logo, trip name, current step and four pips.
 * Pips read green for done, gold for current, muted for not-yet.
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
      <div className="flex items-center gap-3">
        <CoinIcon size={24} />
        <div className="disp text-[12px]">twocents.ai</div>
      </div>

      <div className="head hidden text-[20px] font-semibold sm:block">
        {tripName}
      </div>

      <div className="flex items-center gap-3.5">
        <div className="disp text-[9px] text-gold">{STEP_LABELS[step]}</div>
        <div className="flex gap-1.5" aria-hidden="true">
          {([1, 2, 3, 4] as Step[]).map((s) => (
            <div
              key={s}
              className="h-3 w-3"
              style={{
                background:
                  s < step ? "#5C9E4A" : s === step ? "#F2B84B" : "#5A4634",
              }}
            />
          ))}
        </div>
      </div>
    </header>
  );
}
