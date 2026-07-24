import type { Metadata } from "next";
import { Topbar } from "@/components/shell/Topbar";
import { ProjectsBoard } from "@/components/projects/ProjectsBoard";

export const metadata: Metadata = { title: "Workflows — AgentOS" };

/**
 * Projects (§7.2) — live registered projects (Phase 3).
 */
export default function ProjectsPage() {
  return (
    <>
      <Topbar title="Workflows" />
      <ProjectsBoard />
    </>
  );
}
