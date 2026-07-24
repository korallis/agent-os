import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/console/PagePlaceholder";

export const metadata: Metadata = { title: "Analytics — Agent OS Console" };

export default function AnalyticsPage() {
  return (
    <PagePlaceholder
      title="Analytics"
      phase="Lands in Phases 6–8"
      description="Usage and cost by connection, role, project, and day — billing-surface and Brain-token breakdowns with estimate confidence, reconciled against the event log."
      blocks={["Cost by connection & role", "Brain-token breakdown", "Billing-surface split", "Estimate confidence"]}
    />
  );
}
