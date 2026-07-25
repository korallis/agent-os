import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { TaskDetail } from "@/components/tasks/TaskDetail";

export const metadata: Metadata = { title: "Task Detail — AgentOS" };

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <Topbar title="Task Detail" />
      <TaskDetail taskId={id} />
    </>
  );
}
