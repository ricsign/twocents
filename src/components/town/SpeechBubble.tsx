/**
 * A line, floating over the agent who said it.
 *
 * The tail is a hand-built 20x11 div rather than a CSS triangle, because a
 * border-triangle antialiases its edges and every other edge on this screen is
 * hard. It is positioned per speaker so it points at the right head.
 *
 * `privateReasonKept` is the reason this product exists: the agent moved the
 * group without saying why. The marker under the bubble is the visible proof,
 * so it is always rendered, never truncated, and never shows the reason itself.
 */

import { LockIcon } from "@/components/ui/PixelIcons";

export function SpeechBubble({
  text,
  privateReasonKept,
  tailLeft,
  width,
}: {
  text: string;
  privateReasonKept?: string;
  /** Tail offset from the bubble's left edge, in room pixels. */
  tailLeft: number;
  width: number;
}) {
  return (
    <div className="flex flex-col gap-[10px]" style={{ width }}>
      <div className="pop relative border-[3px] border-ink bg-paper px-[18px] py-4 text-[17px] leading-[1.4] font-bold text-ink">
        {text}
        <div
          aria-hidden="true"
          className="absolute h-[11px] w-5 border-r-[3px] border-b-[3px] border-l-[3px] border-ink bg-paper"
          style={{ left: tailLeft, bottom: -14 }}
        />
      </div>

      {privateReasonKept ? (
        <div className="flex w-fit items-center gap-2 border-l-[6px] border-gold bg-card/90 py-1 pr-2 pl-2">
          <LockIcon size={12} color="#2B1E14" keyhole="#F2B84B" />
          <span className="text-[13px] font-bold text-ink">
            Reason kept private
          </span>
        </div>
      ) : null}
    </div>
  );
}
