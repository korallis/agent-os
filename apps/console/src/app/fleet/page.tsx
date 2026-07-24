import type { Metadata } from "next";
import { FleetDashboard } from "@/components/console/FleetDashboard";

export const metadata: Metadata = { title: "Fleet — Agent OS Console" };

export default function FleetPage() {
  return <FleetDashboard />;
}
