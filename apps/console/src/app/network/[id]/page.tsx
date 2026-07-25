import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { NetworkDetail } from "@/components/network/NetworkDetail";

export const metadata: Metadata = { title: "Network I/O Detail — AgentOS" };

/** Network I/O Detail — Figma frame `41:4815`. */
export default async function NetworkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <Topbar title="Network I/O" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        {/* key remounts on id change so detail state never shows a prior request */}
        <NetworkDetail key={id} requestId={id} />
      </main>
    </>
  );
}
