"use client";

/**
 * The judges' round: four agents briefed in about twenty seconds.
 *
 * This screen exists because of one line in the demo script — at 2:20 a judge
 * briefs four agents for their own dinner and watches them argue. Everything
 * here is built against that clock rather than against the briefing screen's
 * more careful idea of a conversation:
 *
 * - **Every field is prefilled with a plausible dinner.** A judge who touches
 *   nothing and presses START still gets a real negotiation with a real secret
 *   in it. Editing is an upgrade, not a requirement.
 * - **Three fields a seat, and one of them is the product.** A name, a want, a
 *   ceiling. The ceiling carries the lock, because a judge needs to see the
 *   thing their agent is about to protect before it protects it.
 * - **One screen, no scroll.** Four seats across, shared topic above, START
 *   below. A judge scrolling is a judge not watching the town.
 *
 * The topic is free text so the round is not hard-coded to trips: it becomes
 * the session's name, printed on the top bar and argued over in the room.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LockIcon } from "@/components/ui/PixelIcons";
import { Avatar } from "@/components/ui/Sprite";
import { CHARACTERS, PARTICIPANT_IDS, type ParticipantId } from "@/lib/characters";

/* -------------------------------------------------------------------------- */
/* Shapes and defaults                                                         */
/* -------------------------------------------------------------------------- */

/** One seat's three fields, held as strings because that is what an input is. */
interface Seat {
  participantId: ParticipantId;
  name: string;
  want: string;
  /** Empty means "no ceiling", which is a real answer and not a blank. */
  budget: string;
}

/**
 * The scenario a judge sees before they type anything.
 *
 * Chosen so the room has an argument in it from the first frame: one low
 * private ceiling, one person happy to overspend, and two wants that cannot
 * both be satisfied by the same restaurant. A prefill that agreed immediately
 * would demo nothing.
 */
const PREFILL: Record<ParticipantId, Omit<Seat, "participantId">> = {
  maya: {
    name: "Dana",
    want: "real vegetarian food, walking distance",
    budget: "25",
  },
  jordan: {
    name: "Raj",
    want: "a proper bar, no reservation needed",
    budget: "45",
  },
  sam: {
    name: "Ben",
    want: "the good steak place, somewhere worth dressing up for",
    budget: "95",
  },
  priya: {
    name: "Kim",
    want: "quiet enough to talk, nothing too spicy",
    budget: "35",
  },
};

const DEFAULT_TOPIC = "Dinner tonight";
const DEFAULT_WHEN = "Tonight, 7pm";

function initialSeats(): Seat[] {
  return PARTICIPANT_IDS.map((participantId) => ({
    participantId,
    ...PREFILL[participantId],
  }));
}

/* -------------------------------------------------------------------------- */
/* Field primitives                                                            */
/* -------------------------------------------------------------------------- */

const INPUT =
  "h-11 w-full min-w-0 border-[3px] border-ink bg-paper px-3 text-[15px] font-semibold text-ink outline-none focus:border-sky disabled:opacity-60";

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  inputMode,
  maxLength,
  trailing,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  inputMode?: "text" | "numeric";
  maxLength?: number;
  /** Rendered to the right of the label. The lock lives here. */
  trailing?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="disp text-[7px] text-bark">
          {label}
        </label>
        {trailing}
      </div>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        disabled={disabled}
        autoComplete="off"
        className={INPUT}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One seat                                                                    */
/* -------------------------------------------------------------------------- */

function SeatCard({
  seat,
  onChange,
  disabled,
}: {
  seat: Seat;
  onChange: (patch: Partial<Seat>) => void;
  disabled: boolean;
}) {
  const character = CHARACTERS[seat.participantId];
  return (
    <section className="flex min-w-0 flex-col gap-3 border-[3px] border-ink bg-card p-4">
      <header className="flex items-center gap-3">
        <Avatar id={seat.participantId} size={40} className="shrink-0" />
        <div
          className="disp px-2 py-1 text-[7px] text-white"
          style={{ background: character.color }}
        >
          {character.name.toUpperCase()}
        </div>
      </header>

      <Field
        id={`${seat.participantId}-name`}
        label="WHO IT SPEAKS FOR"
        value={seat.name}
        onChange={(name) => onChange({ name })}
        placeholder="Their name"
        maxLength={40}
        disabled={disabled}
      />

      <Field
        id={`${seat.participantId}-want`}
        label="WHAT THEY WANT"
        value={seat.want}
        onChange={(want) => onChange({ want })}
        placeholder="One line, in their words"
        maxLength={240}
        disabled={disabled}
      />

      <Field
        id={`${seat.participantId}-budget`}
        label="MOST THEY'LL SPEND"
        value={seat.budget}
        onChange={(budget) => onChange({ budget: budget.replace(/[^0-9]/g, "") })}
        placeholder="Leave blank for no limit"
        inputMode="numeric"
        maxLength={6}
        disabled={disabled}
        trailing={
          <span className="flex items-center gap-1 text-bark">
            <LockIcon size={10} />
            <span className="disp text-[7px]">PRIVATE</span>
          </span>
        }
      />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The screen                                                                  */
/* -------------------------------------------------------------------------- */

/** Digits only, already filtered by the input; empty is a deliberate null. */
function budgetOf(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export function JudgesScreen() {
  const router = useRouter();
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [when, setWhen] = useState(DEFAULT_WHEN);
  const [seats, setSeats] = useState<Seat[]>(initialSeats);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);

  const patchSeat = useCallback((id: ParticipantId, patch: Partial<Seat>) => {
    setSeats((current) =>
      current.map((seat) => (seat.participantId === id ? { ...seat, ...patch } : seat)),
    );
  }, []);

  // Every field the route requires has to be non-empty, checked here so the
  // judge learns it from a dimmed button rather than from a 400.
  const ready = useMemo(
    () =>
      topic.trim().length > 0 &&
      when.trim().length > 0 &&
      seats.every((seat) => seat.name.trim().length > 0 && seat.want.trim().length > 0),
    [topic, when, seats],
  );

  async function start(): Promise<void> {
    if (!ready || starting) return;
    setStarting(true);
    setFailed(false);
    try {
      const res = await fetch("/api/judges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          when: when.trim(),
          people: seats.map((seat) => ({
            participantId: seat.participantId,
            name: seat.name.trim(),
            want: seat.want.trim(),
            budget: budgetOf(seat.budget),
          })),
        }),
      });
      if (!res.ok) throw new Error(`judges responded ${res.status}`);
      // The route seeded the session the town already reads, so there is
      // nothing to hand along but the navigation itself.
      router.push("/town");
    } catch {
      setStarting(false);
      setFailed(true);
    }
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-5 px-4 pt-6 pb-7 sm:px-8 min-[1100px]:px-14 min-[1100px]:pt-7 min-[1100px]:pb-8">
      <header className="flex flex-col gap-4 min-[1100px]:flex-row min-[1100px]:items-end min-[1100px]:justify-between min-[1100px]:gap-10">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="head m-0 text-[32px] leading-none font-bold min-[1100px]:text-[40px]">
            Your turn. Brief four agents.
          </h1>
          <p className="m-0 text-[15px] font-semibold text-bark">
            Tell each agent what its person wants and the most they will spend.
            The number stays between them.
          </p>
        </div>

        <div className="flex shrink-0 gap-4">
          <div className="w-[240px]">
            <Field
              id="judges-topic"
              label="WHAT THEY'RE DECIDING"
              value={topic}
              onChange={setTopic}
              placeholder="Dinner tonight"
              maxLength={60}
              disabled={starting}
            />
          </div>
          <div className="w-[190px]">
            <Field
              id="judges-when"
              label="WHEN"
              value={when}
              onChange={setWhen}
              placeholder="Tonight, 7pm"
              maxLength={60}
              disabled={starting}
            />
          </div>
        </div>
      </header>

      <div className="grid min-h-0 grid-cols-1 gap-4 sm:grid-cols-2 min-[1100px]:grid-cols-4 min-[1100px]:gap-5">
        {seats.map((seat) => (
          <SeatCard
            key={seat.participantId}
            seat={seat}
            disabled={starting}
            onChange={(patch) => patchSeat(seat.participantId, patch)}
          />
        ))}
      </div>

      <div className="mt-auto flex flex-col items-stretch gap-3 pt-1 min-[1100px]:flex-row min-[1100px]:items-center min-[1100px]:gap-6">
        <button
          type="button"
          onClick={() => void start()}
          disabled={!ready || starting}
          className="disp px-press px-shadow h-16 shrink-0 cursor-pointer border-4 border-ink bg-coral px-12 text-[12px] text-white disabled:cursor-default disabled:opacity-45 min-[1100px]:h-[68px]"
        >
          {starting ? "SEATING THEM…" : "START"}
        </button>

        <p
          aria-live="polite"
          className={`m-0 text-[14px] font-semibold ${failed ? "text-rust" : "text-bark"}`}
        >
          {failed
            ? "That didn’t take. Press START again."
            : ready
              ? "Four agents walk to the table and argue it out. About forty seconds."
              : "Every seat needs a name and one line about what they want."}
        </p>
      </div>
    </main>
  );
}
