import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { PipelineView } from "@/components/pipeline/PipelineView";

export const metadata: Metadata = { title: "Pipeline — AgentOS" };

/** Live view of the local no-mistakes gate (master plan §11 Phase 9). */
export default function PipelinePage() {
  return (
    <>
      <Topbar title="Pipeline" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[22px] font-bold text-fg-1">Pipeline</h2>
          <p className="text-[13px] text-fg-2">
            Live state of the no-mistakes gate — read-only, and the transport it is using is
            stated rather than implied
          </p>
        </div>
        <PipelineView />
      </main>
    </>
  );
}
