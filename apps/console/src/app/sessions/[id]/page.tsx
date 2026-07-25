import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { SessionDetail } from "@/components/sessions/SessionDetail";

export const metadata: Metadata = { title: "Agent — AgentOS" };

/** Agent Detail (`41:2`) + Agent Logs (`41:456`) for one crewmate seat. */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <Topbar title="Agent detail" />
      <SessionDetail sessionId={id} />
    </>
  );
}
