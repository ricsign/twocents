import { TopBar } from "@/components/ui/TopBar";

export default function BriefPage() {
  return (
    <div className="flex h-screen flex-col bg-parchment">
      <TopBar step={1} />
      <main className="flex flex-1 items-center justify-center">
        <p className="disp text-[12px] text-bark">BRIEFING — COMING UP</p>
      </main>
    </div>
  );
}
