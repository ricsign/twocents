"use client";

/**
 * Step zero: the group chat that never booked anything.
 *
 * Three states in one screen — pick the screenshots, look at what we read,
 * share the link — because the whole point is that it takes one pass. The
 * middle state is the one that matters: everything on it is editable, every
 * person carries the line we read them off, and nothing has been written down
 * yet. A host who disagrees with all of it can still fix all of it.
 *
 * There is no state here without a way out. Both escape hatches are on screen
 * from the first frame: brief your own agent, or type the four people in.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CHARACTERS, PARTICIPANT_IDS, displayNameFor, type ParticipantId } from "@/lib/characters";
import { MAX_IMAGES, MAX_TOTAL_B64 } from "@/lib/ingest/schema";
import type { DroppedPerson, SeatedChat } from "@/lib/ingest/seats";
import type { SeatBrief } from "@/lib/room/seat";
import type { Usage } from "@/lib/types";
import { Avatar } from "@/components/ui/Sprite";
import { PixelButton, PixelLink } from "@/components/ui/PixelButton";
import { LockIcon } from "@/components/ui/PixelIcons";
import {
  ACCEPT_ATTRIBUTE,
  UnreadableFileError,
  prepareImage,
  type PreparedImage,
} from "./downscale";

const INPUT =
  "h-11 w-full min-w-0 border-[3px] border-ink bg-paper px-3 text-[15px] font-semibold text-ink outline-none focus:border-sky disabled:opacity-60";

type Stage = "picking" | "reading" | "reviewing" | "minting";

interface Draft extends SeatedChat {
  usage?: Usage;
  offline?: boolean;
}

export function StartScreen() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("picking");
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function pick(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setProblem(null);

    const next: PreparedImage[] = [];
    for (const file of Array.from(files).slice(0, MAX_IMAGES - images.length)) {
      try {
        next.push(await prepareImage(file));
      } catch (error) {
        setProblem(
          error instanceof UnreadableFileError
            ? error.message
            : `${file.name} could not be read.`,
        );
      }
    }
    if (next.length > 0) setImages((prev) => [...prev, ...next].slice(0, MAX_IMAGES));
    if (fileRef.current) fileRef.current.value = "";
  }

  async function read(): Promise<void> {
    if (images.length === 0 || stage === "reading") return;

    const total = images.reduce((sum, image) => sum + image.dataBase64.length, 0);
    if (total > MAX_TOTAL_B64) {
      setProblem("Those come to more than we can send at once. Try fewer, or crop them tighter.");
      return;
    }

    setStage("reading");
    setProblem(null);
    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          images: images.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })),
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        draft?: SeatedChat;
        usage?: Usage;
        offline?: boolean;
        reason?: string;
      };

      if (!data.ok || !data.draft) {
        // Back to picking with the files still listed, never to a dead end.
        setProblem(data.reason ?? "We could not read those. Try another shot.");
        setStage("picking");
        return;
      }

      setDraft({ ...data.draft, usage: data.usage, offline: data.offline });
      setStage("reviewing");
    } catch {
      setProblem("Something went wrong reading those. Try again, or type it instead.");
      setStage("picking");
    }
  }

  async function mint(): Promise<void> {
    if (!draft || stage === "minting") return;
    setStage("minting");
    setProblem(null);
    try {
      const response = await fetch("/api/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: draft.topic.trim(),
          when: draft.when.trim() || "To be decided",
          // A seat needs a name and a want to be a seat. Anything short of
          // that is a chair nobody has described yet, and `seedRoom` fills it
          // with an open seat — which is also what a three-person chat
          // produces, so the two paths land in the same place.
          seats: draft.seats.filter((seat) => seat.name.trim() && seat.want.trim()),
          ...(draft.usage ? { usage: draft.usage } : {}),
        }),
      });
      if (!response.ok) throw new Error(`room responded ${response.status}`);
      const data = (await response.json()) as { joinPath: string };
      // Straight to the join link. The host claims their own seat there, the
      // same way everybody else will, which is also what makes them the host.
      router.push(data.joinPath);
    } catch {
      setProblem("The room could not be made. Try once more.");
      setStage("reviewing");
    }
  }

  /**
   * Skip the photograph and describe the four people by hand.
   *
   * Lands on the same review screen a reading lands on, because it is the same
   * job: four seats with a name and a want, corrected by a human before any of
   * it becomes a room. A separate form for typing would be a second way to do
   * one thing, and the two would drift.
   *
   * No budget field, here or there. That number is the one thing the host must
   * not type on somebody else's behalf — each person gives it to their own
   * agent on the briefing screen, which is the whole claim.
   */
  function typeThemIn(): void {
    setProblem(null);
    setDraft({
      topic: "",
      when: "",
      seats: PARTICIPANT_IDS.map((participantId) => ({
        participantId,
        name: "",
        want: "",
        budget: null,
      })),
      dropped: [],
      notes: [],
    });
    setStage("reviewing");
  }

  function editSeat(index: number, patch: Partial<SeatBrief>): void {
    setDraft((prev) =>
      prev
        ? { ...prev, seats: prev.seats.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)) }
        : prev,
    );
  }

  /** Swap somebody who did not fit into a seat, keeping the chair's id. */
  function swapIn(index: number, person: DroppedPerson): void {
    setDraft((prev) => {
      if (!prev) return prev;
      const seat = prev.seats[index];
      if (!seat) return prev;
      const outgoing: DroppedPerson = {
        handle: seat.draft?.handle ?? seat.name,
        displayName: seat.name,
        messageCount: 0,
      };
      return {
        ...prev,
        seats: prev.seats.map((current, i) =>
          i === index
            ? {
              ...current,
              name: person.displayName,
              want: "",
              draft: { source: "photo", handle: person.handle, confidence: "unsure" },
            }
            : current,
        ),
        dropped: prev.dropped.map((d) => (d.handle === person.handle ? outgoing : d)),
      };
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-8 px-4 pt-8 pb-12 sm:px-8">
      {stage === "reviewing" || stage === "minting" ? (
        <Review
          draft={draft}
          busy={stage === "minting"}
          onEdit={editSeat}
          onSwap={swapIn}
          onTopic={(topic) => setDraft((prev) => (prev ? { ...prev, topic } : prev))}
          onWhen={(when) => setDraft((prev) => (prev ? { ...prev, when } : prev))}
          onConfirm={() => void mint()}
          problem={problem}
        />
      ) : (
        <Picker
          images={images}
          stage={stage}
          problem={problem}
          fileRef={fileRef}
          onPick={(files) => void pick(files)}
          onRemove={(index) => setImages((prev) => prev.filter((_, i) => i !== index))}
          onRead={() => void read()}
          onTypeInstead={typeThemIn}
        />
      )}
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Picking                                                                     */
/* -------------------------------------------------------------------------- */

function Picker({
  images,
  stage,
  problem,
  fileRef,
  onPick,
  onRemove,
  onRead,
  onTypeInstead,
}: {
  images: PreparedImage[];
  stage: Stage;
  problem: string | null;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onPick: (files: FileList | null) => void;
  onRemove: (index: number) => void;
  onRead: () => void;
  onTypeInstead: () => void;
}) {
  const reading = stage === "reading";
  const [dragging, setDragging] = useState(false);

  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="head m-0 text-[40px] leading-none font-bold text-ink">
          Start with the group chat
        </h1>
        <p className="m-0 max-w-[60ch] text-[15px] leading-relaxed text-bark">
          Screenshot the conversation that has been going nowhere. We will work out who
          is in it and what each of them asked for, then you can fix whatever we got
          wrong.
        </p>
      </header>

      {/* One target that is both a drop zone and a button. The label wraps the
          hidden input, so a click anywhere in it opens the picker without any
          JavaScript, and the drag handlers add the other half. Keyboard users
          get the input's own focus ring rather than a div pretending to be a
          control. */}
      <label
        onDragOver={(event) => {
          event.preventDefault();
          if (!reading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!reading) onPick(event.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center gap-3 border-[3px] border-dashed p-8 text-center transition-colors ${dragging ? "border-sky bg-paper" : "border-ink bg-card"
          } ${reading || images.length >= MAX_IMAGES ? "cursor-default opacity-60" : ""}`}
      >
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          disabled={reading || images.length >= MAX_IMAGES}
          className="sr-only"
          onChange={(event) => onPick(event.target.files)}
        />

        <span className="disp text-[11px] text-ink">
          {dragging ? "DROP THEM HERE" : "DRAG SCREENSHOTS IN"}
        </span>
        <span className="text-[14px] leading-relaxed text-bark">
          or <span className="font-bold underline">click to choose</span> — up to{" "}
          {MAX_IMAGES}, PNG or JPEG
        </span>
        <span className="disp text-[7px] text-bark">
          {images.length} OF {MAX_IMAGES} ADDED
        </span>
      </label>

      <div className="flex flex-col gap-4 border-[3px] border-ink bg-card p-5">
        {images.length > 0 ? (
          <ul className="m-0 flex list-none flex-wrap gap-3 p-0">
            {images.map((image, index) => (
              <li key={`${image.name}-${index}`} className="flex flex-col items-center gap-1.5">
                {/* eslint-disable-next-line @next/next/no-img-element -- a local
                    data URI that never reaches the server; next/image would try
                    to optimise bytes that exist only in this tab. */}
                <img
                  src={image.previewUrl}
                  alt=""
                  className="h-[96px] w-[72px] border-[3px] border-ink object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  disabled={reading}
                  className="disp cursor-pointer border-0 bg-transparent p-0 text-[7px] text-bark underline"
                >
                  REMOVE
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="m-0 flex items-start gap-2 text-[12px] leading-relaxed text-bark">
          <span className="mt-[3px] shrink-0"><LockIcon size={12} /></span>
          <span>
            TwoCents reads your screenshot to see who is in the chat and what they asked for.
            Brief your own agent more later in a chat to give it more context.
          </span>
        </p>
      </div>

      {problem ? (
        <p className="m-0 border-[3px] border-ink bg-paper p-3 text-[14px] leading-relaxed text-ink">
          {problem}
        </p>
      ) : null}

      <PixelButton
        variant="primary"
        raised
        onClick={onRead}
        disabled={images.length === 0 || reading}
        className="h-16 w-full"
      >
        {reading ? "READING THE CHAT…" : "READ THE CHAT"}
      </PixelButton>

      <Escapes onTypeInstead={onTypeInstead} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Reviewing                                                                   */
/* -------------------------------------------------------------------------- */

function Review({
  draft,
  busy,
  problem,
  onEdit,
  onSwap,
  onTopic,
  onWhen,
  onConfirm,
}: {
  draft: Draft | null;
  busy: boolean;
  problem: string | null;
  onEdit: (index: number, patch: Partial<SeatBrief>) => void;
  onSwap: (index: number, person: DroppedPerson) => void;
  onTopic: (topic: string) => void;
  onWhen: (when: string) => void;
  onConfirm: () => void;
}) {
  if (!draft) return null;

  // Read off a chat, or typed by hand. Only the copy and the caveats differ:
  // it is the same four seats going to the same room either way.
  const read = draft.seats.some((seat) => seat.draft);
  const ready = draft.topic.trim().length > 0 && draft.seats.some(
    (seat) => seat.name.trim() && seat.want.trim(),
  );

  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="head m-0 text-[40px] leading-none font-bold text-ink">
          {read ? "Here is what we read" : "Who is coming?"}
        </h1>
        <p className="m-0 max-w-[60ch] text-[15px] leading-relaxed text-bark">
          {read
            ? "Fix anything that is wrong. Each of these people gets their own agent, and each of them will tell it the one thing that never made it into the chat."
            : "A name and one line about what each of them wants. Leave a seat blank if it is not taken yet. Each of them gets their own agent, and tells it the rest themselves."}
        </p>
        {read && draft.offline ? (
          <p className="disp m-0 text-[8px] leading-relaxed text-bark">
            ● NO API KEY — THIS IS A PLACEHOLDER ROOM, NOT A READING
          </p>
        ) : null}
      </header>

      {draft.notes.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 border-[3px] border-ink bg-paper p-3">
          {draft.notes.map((note) => (
            <li key={note} className="text-[13px] leading-relaxed text-bark">
              {note}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="disp text-[7px] text-bark">WHAT YOU ARE PLANNING</span>
          <input
            value={draft.topic}
            maxLength={60}
            disabled={busy}
            onChange={(event) => onTopic(event.target.value)}
            className={INPUT}
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="disp text-[7px] text-bark">WHEN</span>
          <input
            value={draft.when}
            maxLength={60}
            disabled={busy}
            onChange={(event) => onWhen(event.target.value)}
            className={INPUT}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-2">
        {draft.seats.map((seat, index) => (
          <SeatDraft
            key={seat.participantId}
            seat={seat}
            busy={busy}
            dropped={draft.dropped}
            onEdit={(patch) => onEdit(index, patch)}
            onSwap={(person) => onSwap(index, person)}
          />
        ))}
      </div>

      {problem ? (
        <p className="m-0 border-[3px] border-ink bg-paper p-3 text-[14px] leading-relaxed text-ink">
          {problem}
        </p>
      ) : null}

      {!ready ? (
        <p className="disp m-0 text-center text-[7px] leading-relaxed text-bark">
          NEEDS WHAT YOU ARE PLANNING, AND AT LEAST ONE PERSON WITH A NAME AND A WANT
        </p>
      ) : null}

      <PixelButton
        variant="primary"
        raised
        onClick={onConfirm}
        disabled={busy || !ready}
        className="h-16 w-full"
      >
        {busy ? "MAKING THE ROOM…" : "MAKE THE ROOM →"}
      </PixelButton>

      <Escapes />
    </>
  );
}

function SeatDraft({
  seat,
  busy,
  dropped,
  onEdit,
  onSwap,
}: {
  seat: SeatBrief;
  busy: boolean;
  dropped: DroppedPerson[];
  onEdit: (patch: Partial<SeatBrief>) => void;
  onSwap: (person: DroppedPerson) => void;
}) {
  const id = seat.participantId as ParticipantId;
  const character = CHARACTERS[id];
  // A blank seat is Player n, not a cast name. `displayNameFor` would fall
  // back to the sprite's own name, which introduces somebody who is not here.
  const label = seat.name.trim()
    ? displayNameFor({ [id]: seat.name }, id)
    : `Player ${PARTICIPANT_IDS.indexOf(id) + 1}`;
  const unsure = seat.draft?.confidence === "unsure";

  return (
    <section
      className={`flex min-w-0 flex-col gap-3 border-[3px] bg-card p-4 ${unsure ? "border-dashed border-bark" : "border-ink"
        }`}
    >
      <header className="flex items-center gap-3">
        <Avatar id={id} size={40} className="shrink-0" names={{ [id]: label }} />
        <div
          className="disp px-2 py-1 text-[7px] text-white"
          style={{ background: character.color }}
        >
          {label.toUpperCase()}
        </div>
        {unsure ? <span className="disp text-[7px] text-bark">GUESSED</span> : null}
      </header>

      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="disp text-[7px] text-bark">WHO IT SPEAKS FOR</span>
        <input
          value={seat.name}
          maxLength={40}
          disabled={busy}
          onChange={(event) => onEdit({ name: event.target.value })}
          className={INPUT}
        />
      </label>

      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="disp text-[7px] text-bark">WHAT THEY WANT</span>
        <input
          value={seat.want}
          maxLength={240}
          disabled={busy}
          onChange={(event) => onEdit({ want: event.target.value, wants: undefined })}
          className={INPUT}
        />
      </label>

      {/* The working, shown rather than summarised: a host reading the line we
          took this off can tell in half a second whether we got it right. */}
      {seat.draft && dropped.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="disp text-[7px] text-bark">SWAP IN</span>
          {dropped.slice(0, 4).map((person) => (
            <button
              key={person.handle}
              type="button"
              disabled={busy}
              onClick={() => onSwap(person)}
              className="disp cursor-pointer border-[3px] border-ink bg-paper px-2 py-1 text-[7px] text-ink"
            >
              {person.displayName.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}

      <p className="disp m-0 flex items-center gap-1.5 text-[7px] text-bark">
        <LockIcon size={10} />
        THEY TELL THEIR OWN AGENT WHAT THEY CAN SPEND
      </p>
    </section>
  );
}

/** Always on screen. No state in this flow is a dead end. */
/**
 * Always on screen. No state in this flow is a dead end.
 *
 * `onTypeInstead` is absent once you are already reviewing, because by then
 * you are typing: the offer would point at the screen you are looking at.
 */
function Escapes({ onTypeInstead }: { onTypeInstead?: () => void }) {
  return (
    <div className="flex flex-wrap gap-3">
      <PixelLink href="/brief" variant="ghost" className="h-11 px-4 text-[9px]">
        JUST ME, NO ROOM
      </PixelLink>
      {onTypeInstead ? (
        <PixelButton variant="ghost" onClick={onTypeInstead} className="h-11 px-4 text-[9px]">
          NO SCREENSHOT — TYPE THEM IN
        </PixelButton>
      ) : null}
    </div>
  );
}
