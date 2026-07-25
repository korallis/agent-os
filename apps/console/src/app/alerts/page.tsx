import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { AlertsView } from "@/components/alerts/AlertsView";

export const metadata: Metadata = { title: "Recent Alerts — AgentOS" };

/** Recent Alerts — Figma frame `41:5674`. */
export default function AlertsPage() {
  return (
    <>
      <Topbar title="Recent alerts" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[22px] font-bold text-fg-1">Recent alerts</h2>
          <p className="text-[13px] text-fg-2">
            Quota thresholds, escalations, billing mismatches and policy violations
          </p>
        </div>
        <AlertsView />
      </main>
    </>
  );
}
