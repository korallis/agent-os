import type { Metadata } from "next";
import { LogStream } from "@/components/runs/LogStream";

export const metadata: Metadata = { title: "Live Log Stream — AgentOS" };

export default function RunsPage() {
  return <LogStream />;
}
