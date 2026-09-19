import type { Brief } from "@/lib/types";
import { stripPrivateMarker } from "@/lib/types";
import { LockIcon } from "@/components/ui/PixelIcons";

/**
 * What the agent has picked up so far. Three plain rows and one dark one: the
 * budget is drawn as the thing being held, so the promise is visible before
 * anyone reads the caption.
 */
export function AgentKnowsPanel({ brief }: { brief: Brief }) {
  const dates =
    brief.nights !== null && brief.dates
      ? `${brief.dates} · ${brief.nights} nights`
      : brief.dates;
  const dealbreaker = brief.dealbreakers[0];

  return (
    <section className="flex flex-col">
      <h2 className="disp m-0 pb-[18px] text-[10px] font-normal text-bark">
        YOUR AGENT KNOWS
      </h2>

      <Row label="Destination" value={brief.destinationWant} />
      <Row label="Dates" value={dates} />
      <BudgetRow
        ceiling={brief.budgetCeiling}
        isPrivate={brief.budgetIsPrivate}
      />
      <Row
        label="Dealbreaker"
        value={dealbreaker ? stripPrivateMarker(dealbreaker) : ""}
        last
      />
    </section>
  );
}

function Row({
  label,
  value,
  last = false,
}: {
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 border-t-[3px] border-ink py-3.5 ${
        last ? "border-b-[3px]" : ""
      }`}
    >
      <div className="text-[13px] font-bold text-bark">{label}</div>
      <div className="head text-[24px] leading-tight font-bold">
        {value || <span className="text-bark">Not said yet</span>}
      </div>
    </div>
  );
}

function BudgetRow({
  ceiling,
  isPrivate,
}: {
  ceiling: number | null;
  isPrivate: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 bg-ink px-4 py-3.5 text-parchment">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-bold text-gold">Real budget</div>
        {isPrivate ? (
          <LockIcon size={14} color="#F2B84B" keyhole="#2B1E14" label="private" />
        ) : null}
      </div>
      <div className="head text-[30px] leading-tight font-bold text-gold">
        {ceiling === null ? "Not said yet" : `$${ceiling.toLocaleString("en-US")} max`}
      </div>
      {isPrivate ? (
        <div className="text-[13px] font-semibold text-sand">
          Never said out loud.
        </div>
      ) : null}
    </div>
  );
}
