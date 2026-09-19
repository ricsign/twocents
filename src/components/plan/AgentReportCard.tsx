/**
 * The private debrief, and the emotional payoff of the whole product.
 *
 * Everything else on this screen is the group's. This card is one person's: it
 * is the only place the number they never said out loud gets spoken back to
 * them ("$60 under your number"), and the only place the trade made on their
 * behalf is named. So it is the one dark panel on a parchment screen, and the
 * "Only you can see this" line sits directly under the heading in gold where it
 * cannot be missed — the card has to *look* like it is not for the room.
 */

import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { Avatar } from "@/components/ui/Sprite";
import type { AgentReport } from "@/lib/types";

interface Block {
  label: string;
  body: string;
  /** The label's colour: got is green, traded is coral, why is gold. */
  className: string;
  /** The `why` block is reasoning rather than a result, so it reads softer. */
  muted?: boolean;
}

export function AgentReportCard({
  report,
  you,
  names,
}: {
  report: AgentReport;
  you: ParticipantId;
  /** Only reaches the avatar's alt text; the card speaks to you directly. */
  names?: DisplayNames;
}) {
  const blocks: Block[] = [
    { label: "GOT YOU", body: report.gotYou, className: "text-leaf" },
    { label: "TRADED AWAY", body: report.tradedAway, className: "text-coral" },
    { label: "WHY", body: report.why, className: "text-gold", muted: true },
  ];

  return (
    <section className="flex flex-col gap-5 border-4 border-ink bg-ink px-7 pt-6 pb-7 text-parchment">
      <div className="flex items-center gap-3.5">
        <Avatar id={you} size={48} className="bob" names={names} />
        <div className="flex flex-col gap-1">
          <h2 className="head m-0 text-[24px] leading-none font-bold">
            Your agent’s report
          </h2>
          <p className="m-0 text-[13px] font-bold text-gold">
            Only you can see this
          </p>
        </div>
      </div>

      {blocks.map((block) => (
        <div key={block.label} className="flex flex-col gap-1.5">
          <h3 className={`disp m-0 text-[9px] font-normal ${block.className}`}>
            {block.label}
          </h3>
          <p
            className={`m-0 text-[17px] ${
              block.muted
                ? "leading-normal font-semibold text-cream-dim"
                : "leading-snug font-bold"
            }`}
          >
            {block.body}
          </p>
        </div>
      ))}
    </section>
  );
}
