import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { TasksBoard } from "@/components/tasks/TasksBoard";

export const metadata: Metadata = { title: "Inference Jobs — AgentOS" };

/**
 * Tasks (§7.3) — live Inference Jobs board (Phase 3 task engine).
 */
export default function TasksPage() {
  return (
    <>
      <Topbar title="Inference Jobs" />
      <TasksBoard />
    </>
  );
}
