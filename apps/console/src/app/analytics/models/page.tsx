import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { ModelPerformance } from "@/components/analytics/ModelPerformance";

export const metadata: Metadata = { title: "Model Performance — AgentOS" };

/** Model Performance — Figma frame `41:4355`. */
export default function ModelPerformancePage() {
  return (
    <>
      <Topbar title="Model performance" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[22px] font-bold text-fg-1">Model performance</h2>
          <p className="text-[13px] text-fg-2">
            Measured per-model usage from extension telemetry
          </p>
        </div>
        <ModelPerformance />
      </main>
    </>
  );
}
