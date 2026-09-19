import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { PARTICIPANT_IDS, displayNameFor } from "@/lib/characters";
import { Avatar } from "@/components/ui/Sprite";

/**
 * Who has already talked to their agent. The one without a tick is you, which
 * is the whole instruction this screen needs to give.
 */
export function BriefedRoster({
  briefed,
  you,
  names,
}: {
  briefed: ParticipantId[];
  you: ParticipantId;
  /** What the other three are called. You are always "You". */
  names?: DisplayNames;
}) {
  const count = PARTICIPANT_IDS.filter((id) => briefed.includes(id)).length;
  // You sit last, the way the mockup reads: three ticks, then the gap you fill.
  const order: ParticipantId[] = [
    ...PARTICIPANT_IDS.filter((id) => id !== you),
    you,
  ];

  return (
    <section className="flex flex-col gap-3.5">
      <h2 className="disp m-0 text-[10px] font-normal text-bark">
        {count} OF {PARTICIPANT_IDS.length} BRIEFED
      </h2>
      <ul className="m-0 flex list-none flex-wrap items-end gap-x-[22px] gap-y-4 p-0">
        {order.map((id) => {
          const isYou = id === you;
          return (
            <li key={id} className="flex flex-col items-center gap-1.5">
              <Avatar id={id} size={48} names={names} />
              <span
                className={`text-[13px] font-bold ${
                  isYou ? "text-bark" : "text-leaf-deep"
                }`}
              >
                {isYou ? "You" : `${displayNameFor(names, id)} ✓`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
