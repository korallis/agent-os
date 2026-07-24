import type { Metadata } from "next";
import { PagePlaceholder } from "@/components/console/PagePlaceholder";

export const metadata: Metadata = { title: "Projects — Agent OS Console" };

export default function ProjectsPage() {
  return (
    <PagePlaceholder
      title="Projects"
      phase="Lands in Phase 3"
      description="Registered local git projects: modes (pipeline / direct-pr / local-only), worktree pools, per-project .agentos/ policy overrides with trust acknowledgment."
      blocks={["Registered repositories", "Worktree pools", "Project modes & +yolo scope", "Trust-gated .agentos/ overrides"]}
    />
  );
}
