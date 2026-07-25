import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { NetworkList } from "@/components/network/NetworkList";

export const metadata: Metadata = { title: "Network I/O — AgentOS" };

/** Network I/O — the daemon's own outbound HTTP calls (§7, Figma `41:4815`). */
export default function NetworkPage() {
  return (
    <>
      <Topbar title="Network I/O" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-[22px] font-bold text-fg-1">Network I/O</h2>
          <p className="text-[13px] text-fg-2">
            Every outbound HTTP call Agent OS originated — recorded from the durable event log,
            with credentials redacted at capture
          </p>
        </div>
        <NetworkList />
      </main>
    </>
  );
}
