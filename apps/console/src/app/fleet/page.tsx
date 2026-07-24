import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { FleetDashboard } from "@/components/fleet/FleetDashboard";

export const metadata: Metadata = { title: "Dashboard — AgentOS" };

export default function FleetPage() {
  return (
    <>
      <Topbar title="Dashboard" />
      <main className="flex-1">
        <FleetDashboard />
      </main>
    </>
  );
}
