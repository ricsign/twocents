import Link from "next/link";
import { CoinIcon } from "@/components/ui/PixelIcons";
import { CharacterSprite } from "@/components/ui/Sprite";
import { CHARACTER_LIST } from "@/lib/characters";

export default function TitleScreen() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 bg-parchment px-6 py-16">
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
            <div
              className="bob"
              style={{ animationDelay: `${i * 0.18}s` }}
            >
              <CharacterSprite id={c.id} size={96} state="idle" />
            </div>
            <div
              className="disp px-2 py-1 text-[7px] text-white"
              style={{ background: c.color }}
            >
              {c.name.toUpperCase()}
            </div>
          </div>
        ))}
      </div>

      <Link
        href="/brief"
        className="disp px-press px-shadow inline-flex h-16 items-center justify-center border-4 border-ink bg-coral px-10 text-[12px] text-white no-underline"
      >
        PRESS START
      </Link>

      <p className="max-w-[540px] text-center text-[15px] font-semibold text-bark">
        You brief your agent in private. It works out the plan with the others
        in the open, and never repeats your number.
      </p>
    </main>
  );
}
