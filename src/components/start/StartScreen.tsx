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
import { CHARACTERS, displayNameFor, type ParticipantId } from "@/lib/characters";
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
          topic: draft.topic,
          when: draft.when,
          seats: draft.seats,
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
}: {
  images: PreparedImage[];
  stage: Stage;
  problem: string | null;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onPick: (files: FileList | null) => void;
  onRemove: (index: number) => void;
  onRead: () => void;
}) {
  const reading = stage === "reading";

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

      <div className="flex flex-col gap-4 border-[3px] border-ink bg-card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <PixelButton
            variant="dark"
            onClick={() => fileRef.current?.click()}
            disabled={reading || images.length >= MAX_IMAGES}
          >
            {images.length === 0 ? "CHOOSE SCREENSHOTS" : "ADD ANOTHER"}
          </PixelButton>
          <span className="disp text-[7px] text-bark">
            {images.length} OF {MAX_IMAGES}
          </span>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="hidden"
          onChange={(event) => onPick(event.target.files)}
        />

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
            Your screenshot goes to Anthropic to read who is in the chat and what they
            asked for. We keep the text, not the picture — the image is never saved, and
            nobody&rsquo;s budget comes out of it. That number is still only ever between a
            person and their own agent.
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

      <Escapes />
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

  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="head m-0 text-[40px] leading-none font-bold text-ink">
          Here is what we read
        </h1>
        <p className="m-0 max-w-[60ch] text-[15px] leading-relaxed text-bark">
          Fix anything that is wrong. Each of these people gets their own agent, and each
          of them will tell it the one thing that never made it into the chat.
        </p>
        {draft.offline ? (
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

      <PixelButton
        variant="primary"
        raised
        onClick={onConfirm}
        disabled={busy || draft.seats.every((seat) => !seat.name.trim())}
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
  const label = displayNameFor({ [id]: seat.name }, id);
  const unsure = seat.draft?.confidence === "unsure";

  return (
    <section
      className={`flex min-w-0 flex-col gap-3 border-[3px] bg-card p-4 ${
        unsure ? "border-dashed border-bark" : "border-ink"
      }`}
    >
      <header className="flex items-center gap-3">
        <Avatar id={id} size={40} className="shrink-0" names={{ [id]: seat.name }} />
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
        THEIR BUDGET IS THEIRS TO GIVE, NOT OURS TO READ
      </p>
    </section>
  );
}

/** Always on screen. No state in this flow is a dead end. */
function Escapes() {
  return (
    <div className="flex flex-wrap gap-3">
      <PixelLink href="/brief" variant="ghost" className="h-11 px-4 text-[9px]">
        SKIP — BRIEF MY OWN AGENT
      </PixelLink>
      <PixelLink href="/judges" variant="ghost" className="h-11 px-4 text-[9px]">
        TYPE IT INSTEAD
      </PixelLink>
    </div>
  );
}
