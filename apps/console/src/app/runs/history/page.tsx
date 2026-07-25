import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { RunHistory } from "@/components/runs/RunHistory";
import { RunsSubnav } from "@/components/runs/RunsSubnav";

export const metadata: Metadata = { title: "Run History — AgentOS" };

/** Pipeline Runs (`41:5136`) / Workflow Run History (`41:7213`). */
export default function RunHistoryPage() {
  return (
    <>
      <Topbar title="Run history" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[22px] font-bold text-fg-1">Run history</h2>
            <p className="text-[13px] text-fg-2">
              Every task&apos;s gate and fusion journey, aggregated from the durable event log
            </p>
          </div>
          <RunsSubnav />
        </div>
        <RunHistory />
      </main>
    </>
  );
}
