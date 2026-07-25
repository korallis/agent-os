import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { AnalyticsView } from "@/components/analytics/AnalyticsView";

export const metadata: Metadata = { title: "Token Usage — AgentOS" };

/**
 * Analytics — Figma "Token Usage" (`37:2265`).
 * All figures come from `/v1/analytics`, derived from the daemon event log.
 */
export default function AnalyticsPage() {
  return (
    <>
      <Topbar title="Token Usage" />
      <AnalyticsView />
    </>
  );
}
