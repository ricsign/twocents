"use client";

/**
 * The right rail, and the accessible record of the negotiation.
 *
 * The room is decorative; this is where every spoken line lands, which is why
 * it is a `log` with a polite live region rather than a decorative list. Rows
 * are bottom-aligned so the newest line sits where the eye already is, and a
 * turn that put an option on the table renders as a card instead of a quote —
 * an offer is a thing, a rebuttal is a sentence.
 */

import { useEffect, useRef } from "react";
import { agentName } from "@/lib/characters";
import type { NegotiationSourced, NegotiationTurn, Offer, TurnKind } from "@/lib/types";
import type { DisplayNames, ParticipantId } from "@/lib/characters";
import { Avatar } from "@/components/ui/Sprite";

/** The card's second line: the three terms a judge can read in a glance. */
function terms(offer: Offer): string {
  return [
    `$${offer.perPerson.toLocaleString("en-US")} a person`,
    offer.highlights[0],
    offer.flightNote,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The search behind a line, with the pages it opened.
 *
 * Rendered wherever the line is, because a claim and its receipt belong on the
 * same row: the sentence says a search happened and the hosts beside it are
 * the pages that search returned, each one a link a person can open and check.
 * The engine only ever builds this block next to real results, so a row
 * without links is a row that never claims one.
 */
function Sourced({ sourced }: { sourced: NegotiationSourced }) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-1.5 text-[12px] leading-snug font-semibold text-bark">
      <span>{sourced.note}</span>
      {sourced.links.map((link) => (
        <a
          key={link.url}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          title={link.title}
          className="text-sky underline decoration-dotted underline-offset-2"
        >
          {link.host}
        </a>
      ))}
    </p>
  );
}

/** Pushing back is the only turn that gets a colour; the rest stay muted. */
function kindColour(kind: TurnKind): string {
  return kind === "pushes back" ? "#B8432B" : "#7A5A3A";
}

export function Transcript({
  turns,
  thinkingSpeaker,
  names,
}: {
  turns: NegotiationTurn[];
  thinkingSpeaker: ParticipantId | null;
  /** Who each speaker is. Falls back to the cast when the session has none. */
  names?: DisplayNames;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, thinkingSpeaker]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      <div className="disp text-[10px] text-bark">TRANSCRIPT</div>

      <div
        role="log"
        aria-live="polite"
        aria-label="Planning transcript"
        className="pixel-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <div className="mt-auto flex flex-col gap-[22px]">
          {turns.map((turn) => (
            <TurnRow key={turn.id} turn={turn} names={names} />
          ))}

          {thinkingSpeaker ? (
            <div className="flex items-center gap-2.5 text-bark">
              <Avatar
                id={thinkingSpeaker}
                size={28}
                style={{ opacity: 0.7 }}
                names={names}
              />
              <span className="blink text-[14px] font-bold">
                {agentName(thinkingSpeaker, names)} is thinking…
              </span>
            </div>
          ) : null}

          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
}

function TurnRow({
  turn,
  names,
}: {
  turn: NegotiationTurn;
  names?: DisplayNames;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <Avatar id={turn.speaker} size={28} names={names} />
        <span className="head text-[18px] font-bold">
          {agentName(turn.speaker, names)}
        </span>
        <span
          className="text-[13px] font-bold"
          style={{ color: kindColour(turn.kind) }}
        >
          {turn.kind}
        </span>
      </div>

      {turn.offer ? (
        <div className="ml-[38px] flex flex-col gap-1 border-[3px] border-ink bg-card px-3.5 py-3">
          <div className="head text-[22px] font-bold">
            {turn.offer.destination} · {turn.offer.dates}
          </div>
          <div className="text-[14px] font-semibold text-bark">
            {terms(turn.offer)}
          </div>
          {turn.offer.feasibility ? (
            <div
              className="text-[12px] font-semibold"
              style={{ color: kindColour(turn.offer.feasibility.bookable ? "agrees" : "pushes back") }}
            >
              {turn.offer.feasibility.bookable ? "checked" : "not bookable"} ·{" "}
              {turn.offer.feasibility.note}
            </div>
          ) : null}

          {/* The pages behind that verdict, named and clickable. Only ever
              present when the check actually opened them. */}
          {turn.sourced ? <Sourced sourced={turn.sourced} /> : null}
          {/* The card is the readable form; the line itself is what was said,
              and the accessible record has to carry it. */}
          <span className="sr-only">{turn.text}</span>
        </div>
      ) : (
        <div className="ml-[38px] flex flex-col gap-1.5">
          <p className="m-0 text-[16px] leading-[1.45] font-semibold">
            “{turn.text}”
          </p>
          {turn.sourced ? <Sourced sourced={turn.sourced} /> : null}
        </div>
      )}
    </div>
  );
}
