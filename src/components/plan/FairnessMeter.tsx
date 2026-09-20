/**
 * The claim the screen makes out loud: nobody was overruled.
 *
 * The coloured boxes per row are the thing a judge reads from across the room,
 * and they are also the thing a screen reader cannot read at all. So the
 * segments are marked decorative and the caption beside them carries the whole
 * meaning — "4 of 5 wants kept", "3 of 5 · gave up the resort" — with the row
 * labelled by the person's name and that caption together.
 *
 * One box per want, counted from `wantsTotal`. The count is not fixed because
 * the number of wants is not fixed: a judges' round briefs one want a seat plus
 * a private ceiling, and printing five boxes for two wants would claim three
 * concessions that were never asked for. Rows with different totals no longer
 * compare by eye, which is the price of every bar being true.
 */

import {
  CHARACTERS,
  displayNameFor,
  type DisplayNames,
} from "@/lib/characters";
import { Avatar } from "@/components/ui/Sprite";
import type { FairnessReport, FairnessRow } from "@/lib/types";

/** Only used when a brief carried no wants at all, so a row is never empty. */
const MIN_SLOTS = 1;

/**
 * "3 of 5 · gave up the resort".
 *
 * `gaveUp` arrives already phrased as a sentence fragment and usually already
 * carries the verb ("gave up the resort"), so the prefix is added only when it
 * is missing rather than unconditionally.
 *
 * A seat that stated nothing is its own caption. The total used to be coerced
 * with `|| SLOTS`, which turned a person who asked for nothing into "0 of 5
 * wants kept" beside an empty bar — a row that reads as the worst outcome on
 * the screen, printed next to a green "Nobody overruled" that is correctly
 * true of them. The seat in front of the screen starts exactly there, so this
 * is the first thing a judge sees if the run happens before anybody types.
 */
function captionFor(row: FairnessRow): string {
  const gaveUp = row.gaveUp?.trim();
  const phrase = !gaveUp
    ? null
    : /^gave up\b/i.test(gaveUp)
      ? gaveUp.charAt(0).toLowerCase() + gaveUp.slice(1)
      : `gave up ${gaveUp.charAt(0).toLowerCase()}${gaveUp.slice(1)}`;

  if (row.wantsTotal <= 0) {
    return phrase ? `nothing asked for · ${phrase}` : "nothing asked for";
  }

  const kept = `${row.wantsKept} of ${row.wantsTotal}`;
  return phrase ? `${kept} · ${phrase}` : `${kept} wants kept`;
}

/** How many boxes this person's row gets: one per want they briefed. */
function slotsFor(row: FairnessRow): number {
  return Math.max(MIN_SLOTS, row.wantsTotal);
}

/** One box a want, `filled` of them in the person's accent. Decorative. */
function Segments({
  slots,
  filled,
  color,
}: {
  slots: number;
  filled: number;
  color: string;
}) {
  return (
    <div
      aria-hidden="true"
      className="grid w-full min-w-[120px] gap-1.5"
      // Inline rather than a `grid-cols-*` class: the count is data, and
      // Tailwind only ships the classes it can see in the source.
      style={{ gridTemplateColumns: `repeat(${slots}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: slots }, (_, i) => (
        <div
          key={i}
          className="seg"
          style={{ background: i < filled ? color : "var(--color-parchment)" }}
        />
      ))}
    </div>
  );
}

function Row({ row, names }: { row: FairnessRow; names?: DisplayNames }) {
  const character = CHARACTERS[row.participantId];
  const caption = captionFor(row);
  const nameId = `fairness-name-${row.participantId}`;
  const captionId = `fairness-caption-${row.participantId}`;
  // A bar can only fill the slots it has, however the scorer counted.
  const slots = slotsFor(row);
  const filled = Math.max(0, Math.min(slots, row.wantsKept));

  return (
    <li
      role="group"
      aria-labelledby={`${nameId} ${captionId}`}
      className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-4 gap-y-2 min-[700px]:grid-cols-[40px_90px_minmax(0,1fr)_170px]"
    >
      <Avatar id={row.participantId} size={40} names={names} />

      <span id={nameId} className="head text-[20px] font-bold">
        {displayNameFor(names, row.participantId)}
      </span>

      <div className="col-start-2 min-[700px]:col-start-3">
        <Segments slots={slots} filled={filled} color={character.color} />
      </div>

      <span
        id={captionId}
        className="col-start-2 text-[14px] font-bold text-bark min-[700px]:col-start-4"
      >
        {caption}
      </span>
    </li>
  );
}

export function FairnessMeter({
  fairness,
  names,
}: {
  fairness: FairnessReport;
  names?: DisplayNames;
}) {
  if (fairness.rows.length === 0) return null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="disp m-0 text-[10px] font-normal text-bark">FAIRNESS</h2>
        <p
          className={`m-0 text-[14px] font-bold ${
            fairness.nobodyOverruled ? "text-leaf-deep" : "text-rust"
          }`}
        >
          {fairness.nobodyOverruled ? "Nobody overruled" : "Somebody lost ground"}
        </p>
      </div>

      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {fairness.rows.map((row) => (
          <Row key={row.participantId} row={row} names={names} />
        ))}
      </ul>
    </section>
  );
}
