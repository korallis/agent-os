import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/console/PagePlaceholder";

export const metadata: Metadata = { title: "Settings — Agent OS Console" };

export default function SettingsPage() {
  return (
    <PagePlaceholder
      title="Settings"
      phase="Completes in Phase 6"
      description="Infrastructure-only settings: orchestrator home ~/.agentos, bind 127.0.0.1:4700 (config-locked 🔒), daemon token rotation, Pi harness pin, data export, and the danger zone."
      blocks={["Orchestrator · home & bind 🔒", "Harness · pi pin & canary", "Brain process (Phase 3)", "Data · export & retention"]}
    />
  );
}
