import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/console/PagePlaceholder";

export const metadata: Metadata = { title: "Runs — Agent OS Console" };

export default function RunsPage() {
  return (
    <PagePlaceholder
      title="Runs"
      phase="Lands in Phases 4–5"
      description="Fusion run artifacts: attributed spans, consensus & divergence panels, gate evidence with RED-baseline proof, per-role telemetry, and the run's resolved config snapshot."
      blocks={["Attributed fusion spans", "Consensus & divergence", "Gate evidence (RED → GREEN)", "Config snapshot & policy overrides"]}
    />
  );
}
