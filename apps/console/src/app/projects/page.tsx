import type { Metadata } from "next";
import { cn } from "@agent-os/ui";
import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/shell/Icon";

export const metadata: Metadata = { title: "Workflows — AgentOS" };

type WorkflowStatus = "Active" | "Paused" | "Failed" | "Draft";

/* Pixel-faithful placeholder cards from the Figma design — registered
   project workflows land in Phase 3 (master plan §11). */
const WORKFLOWS: {
  status: WorkflowStatus;
  title: string;
  description: string;
  nodes: string;
  runs: string;
  updated: string;
}[] = [
  { status: "Active", title: "Code Review Pipeline", description: "Automated code review with Coder and QA agents for all pull requests", nodes: "8 nodes", runs: "347 runs", updated: "2h ago" },
  { status: "Active", title: "Content Generation", description: "Writer agent generates blog posts, docs, and marketing copy on schedule", nodes: "6 nodes", runs: "214 runs", updated: "5h ago" },
  { status: "Active", title: "Research & Analysis", description: "Research agent gathers market data and generates analytical reports weekly", nodes: "10 nodes", runs: "128 runs", updated: "12h ago" },
  { status: "Paused", title: "Data Ingestion Flow", description: "Processes incoming data feeds and updates knowledge base embeddings", nodes: "5 nodes", runs: "89 runs", updated: "1d ago" },
  { status: "Failed", title: "Security Scan Pipeline", description: "Runs vulnerability scanning across codebase and dependency checks", nodes: "12 nodes", runs: "56 runs", updated: "30m ago" },
  { status: "Draft", title: "Deployment Pipeline", description: "CI/CD pipeline for automated testing, staging, and production deployment", nodes: "15 nodes", runs: "0 runs", updated: "" },
];

const STATUS_STYLE: Record<WorkflowStatus, { dot: string; text: string }> = {
  Active: { dot: "bg-ok", text: "text-ok" },
  Paused: { dot: "bg-warn", text: "text-warn" },
  Failed: { dot: "bg-danger", text: "text-danger" },
  Draft: { dot: "bg-fg-3", text: "text-fg-3" },
};

/**
 * Projects (§7.2) — the Figma "Workflow List" screen. Registered git
 * projects with modes and worktree pools arrive in Phase 3; these cards
 * are the pixel-faithful surface awaiting that wiring.
 */
export default function ProjectsPage() {
  return (
    <>
      <Topbar title="Workflows" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <h2 className="text-[22px] font-bold text-fg-1">Workflows</h2>
            <span className="rounded-md bg-panel-2 px-2.5 py-1 text-xs font-medium text-fg-2">
              12
            </span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="flex items-center gap-1.5 h-9 rounded-lg bg-fg-1 px-4 text-[13px] font-semibold text-black">
              <Icon src="ij-plus.svg" className="size-4" />
              New Workflow
            </span>
            <span className="flex items-center gap-1.5 h-9 rounded-lg bg-panel border border-line-1 px-4 text-[13px] font-medium text-fg-1">
              Import
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex-1 flex items-center gap-2 h-10 rounded-lg bg-panel border border-line-1 px-3.5">
            <Icon src="ij-search.svg" className="size-4" />
            <span className="text-[13px] text-fg-3">Search workflows...</span>
          </div>
          {["All Status", "Last Modified"].map((label) => (
            <span
              key={label}
              className="flex items-center gap-1.5 h-10 rounded-lg bg-panel border border-line-1 px-3.5 text-[13px] font-medium text-fg-2"
            >
              {label}
              <Icon src="ij-chevron.svg" className="size-3.5" />
            </span>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {WORKFLOWS.map((workflow) => (
            <div
              key={workflow.title}
              className="rounded-[14px] bg-panel border border-line-2 p-5 flex flex-col gap-3"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-1.5 rounded-[3px]", STATUS_STYLE[workflow.status].dot)} />
                  <span className={cn("text-[11px] font-semibold", STATUS_STYLE[workflow.status].text)}>
                    {workflow.status}
                  </span>
                </span>
                <Icon src="kebab.svg" className="size-4" />
              </div>
              <h3 className="text-[15px] font-semibold text-fg-1">{workflow.title}</h3>
              <p className="text-xs leading-[18px] text-fg-2 min-h-9">{workflow.description}</p>
              <div className="flex items-center justify-between pt-2 text-[11px] text-fg-3">
                <span>{workflow.nodes}</span>
                <span>{workflow.runs}</span>
                <span>{workflow.updated}</span>
              </div>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
