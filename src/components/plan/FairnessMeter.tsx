/**
 * The claim the screen makes out loud: nobody was overruled.
 *
 * The five coloured boxes per row are the thing a judge reads from across the
 * room, and they are also the thing a screen reader cannot read at all. So the
 * segments are marked decorative and the caption beside them carries the whole
 * meaning — "4 of 5 wants kept", "3 of 5 · gave up the resort" — with the row
 * labelled by the person's name and that caption together.
 */

import {
  CHARACTERS,
  displayNameFor,
  type DisplayNames,
} from "@/lib/characters";
import { Avatar } from "@/components/ui/Sprite";
import type { FairnessReport, FairnessRow } from "@/lib/types";

/** Fixed slots, so every bar is the same length and rows compare by eye. */
const SLOTS = 5;

/**
 * "3 of 5 · gave up the resort".
 *
 * `gaveUp` arrives already phrased as a sentence fragment and usually already
 * carries the verb ("gave up the resort"), so the prefix is added only when it
 * is missing rather than unconditionally.
 */
function captionFor(row: FairnessRow): string {
  const total = row.wantsTotal || SLOTS;
  const gaveUp = row.gaveUp?.trim();
  if (!gaveUp) return `${row.wantsKept} of ${total} wants kept`;

  const phrase = /^gave up\b/i.test(gaveUp)
    ? gaveUp.charAt(0).toLowerCase() + gaveUp.slice(1)
    : `gave up ${gaveUp.charAt(0).toLowerCase()}${gaveUp.slice(1)}`;
  return `${row.wantsKept} of ${total} · ${phrase}`;
}

/** Five boxes, `filled` of them in the person's accent. Decorative by design. */
function Segments({ filled, color }: { filled: number; color: string }) {
  return (
    <div
      aria-hidden="true"
      className="grid w-full min-w-[120px] grid-cols-5 gap-1.5"
    >
      {Array.from({ length: SLOTS }, (_, i) => (
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
  const filled = Math.max(0, Math.min(SLOTS, row.wantsKept));

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
        <Segments filled={filled} color={character.color} />
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
