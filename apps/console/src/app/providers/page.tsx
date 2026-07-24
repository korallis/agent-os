import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/console/PagePlaceholder";

export const metadata: Metadata = { title: "Providers — Agent OS Console" };

export default function ProvidersPage() {
  return (
    <PagePlaceholder
      title="Providers"
      phase="Lands in Phase 2"
      description="Provider connections through the Pi harness: subscription OAuth and API-key connections, live quota & balance cards with honesty tiers (● LIVE / ◌ BEST-EFFORT / ≈ ESTIMATE), and the extra-usage billing warnings."
      blocks={["Quota card grid (live probes)", "Connection health & billing surface", "pi /login · /logout flows", "Budgets & ceilings"]}
    />
  );
}
