import Link from "next/link";
import { CoinIcon } from "@/components/ui/PixelIcons";
import { CharacterSprite } from "@/components/ui/Sprite";
import {
  CHARACTER_LIST,
  PARTICIPANT_IDS,
  YOU,
  displayNameFor,
} from "@/lib/characters";
import { getOrCreateDefault } from "@/lib/session";
import { displayNamesOf } from "@/lib/types";

/**
 * The title screen, which now has a job beyond looking good.
 *
 * Four sprites and a PRESS START told a judge nothing about what they were
 * about to do, and the first question in the room was always the same one:
 * which of these am I, and why are the other three already done? Both answers
 * are one line each, so they are on the screen before anybody has to ask. The
 * four steps are named for the same reason — the top bar counts them from
 * step 1 onward, and a judge who has seen the list once can read that counter.
 *
 * Still one screen and still the pixel language: a name tag, four numbered
 * cards, one button. It is not a landing page and must not grow into one.
 */

/**
 * The names come from the session, not the cast.
 *
 * A judges' round renames all four seats, and this is the screen people come
 * back to between rounds. Rendering it per request costs the app its one
 * static page and buys a title screen that never introduces a judge to
 * somebody who is not in the room any more.
 */
export const dynamic = "force-dynamic";

const STEPS: { n: number; name: string; gloss: string }[] = [
  { n: 1, name: "BRIEF", gloss: "Tell your agent the truth, real budget included." },
  { n: 2, name: "PERSONALITY", gloss: "Decide how hard it fights, and how it sounds." },
  { n: 3, name: "THE TOWN", gloss: "The four agents argue it out at the table." },
  { n: 4, name: "THE PLAN", gloss: "One trip, and a private note on what it cost you." },
];

export default function TitleScreen() {
  const names = displayNamesOf(getOrCreateDefault());
  const yourName = displayNameFor(names, YOU);
  const otherNames = PARTICIPANT_IDS.filter((id) => id !== YOU).map((id) =>
    displayNameFor(names, id),
  );

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-parchment px-6 py-12">
      <div className="flex items-center gap-4">
        <CoinIcon size={44} />
        <h1 className="disp text-[28px] leading-none sm:text-[40px]">
          twocents.ai
        </h1>
      </div>

      <p className="head max-w-[620px] text-center text-[26px] leading-tight text-ink sm:text-[32px]">
        Four friends. Four agents. One plan nobody loses on.
      </p>

      <div className="flex items-end gap-6">
        {CHARACTER_LIST.map((c, i) => (
          <div key={c.id} className="flex flex-col items-center gap-2">
            <div className="bob" style={{ animationDelay: `${i * 0.18}s` }}>
              <CharacterSprite id={c.id} size={96} state="idle" />
            </div>
            <div
              className="disp px-2 py-1 text-[7px] text-white"
              style={{ background: c.color }}
            >
              {c.id === YOU
                ? `${displayNameFor(names, c.id).toUpperCase()} · YOU`
                : displayNameFor(names, c.id).toUpperCase()}
            </div>
          </div>
        ))}
      </div>

      <p className="max-w-[620px] text-center text-[15px] font-semibold text-bark">
        You are {yourName}. {otherNames.join(", ")} have already briefed their
        agents in private. Yours is waiting to hear from you.
      </p>

      <ol className="m-0 grid w-full max-w-[940px] list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 min-[1100px]:grid-cols-4">
        {STEPS.map((step) => (
          <li
            key={step.n}
            className="flex flex-col gap-2 border-[3px] border-ink bg-card px-4 py-3.5"
          >
            <div className="disp text-[9px] text-ink">
              {step.n} · {step.name}
            </div>
            <div className="text-[14px] leading-snug font-semibold text-bark">
              {step.gloss}
            </div>
          </li>
        ))}
      </ol>

      <Link
        href="/brief"
        className="disp px-press px-shadow inline-flex h-16 items-center justify-center border-4 border-ink bg-coral px-10 text-[12px] text-white no-underline"
      >
        PRESS START
      </Link>

      <p className="max-w-[540px] text-center text-[15px] font-semibold text-bark">
        You brief your agent in private. It argues your side in the open, and
        never repeats your number.
      </p>
    </main>
  );
}
