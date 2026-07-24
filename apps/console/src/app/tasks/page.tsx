import type { Metadata } from "next";
import { cn } from "@agent-os/ui";
import { Topbar } from "@/components/shell/Topbar";
import { Icon } from "@/components/shell/Icon";

export const metadata: Metadata = { title: "Inference Jobs — AgentOS" };

type JobStatus = "Done" | "Running" | "Failed" | "Queued";

/* Pixel-faithful placeholder rows from the Figma design — the task engine
   that feeds this table lands in Phase 2 (master plan §11). */
const JOBS: {
  id: string;
  model: string;
  agent: string;
  tokens: string;
  latency: string;
  status: JobStatus;
  time: string;
}[] = [
  { id: "inf-7a3f8b2c", model: "claude-opus-4", agent: "Coder Agent", tokens: "12,480", latency: "1.2s", status: "Done", time: "2m ago" },
  { id: "inf-4d9e1f6a", model: "claude-sonnet-4-5", agent: "Writer Agent", tokens: "8,240", latency: "0.8s", status: "Running", time: "Just now" },
  { id: "inf-9d2e4f1a", model: "claude-sonnet-4-5", agent: "Writer Agent", tokens: "8,240", latency: "0.8s", status: "Running", time: "Just now" },
  { id: "inf-5c8b3e7d", model: "claude-haiku-4-5", agent: "QA Agent", tokens: "3,120", latency: "0.3s", status: "Done", time: "5m ago" },
  { id: "inf-1b6a9c4e", model: "claude-opus-4", agent: "Research Agent", tokens: "24,680", latency: "2.4s", status: "Failed", time: "12m ago" },
  { id: "inf-8e4d2a6f", model: "claude-sonnet-4-5", agent: "Data Agent", tokens: "6,890", latency: "0.6s", status: "Done", time: "18m ago" },
  { id: "inf-3f7c1d5b", model: "claude-opus-4", agent: "Coder Agent", tokens: "18,340", latency: "1.8s", status: "Done", time: "25m ago" },
  { id: "inf-6d9f3b8a", model: "claude-haiku-4-5", agent: "Writer Agent", tokens: "2,150", latency: "0.2s", status: "Queued", time: "Just now" },
];

const STATUS_DOT: Record<JobStatus, string> = {
  Done: "bg-ok",
  Running: "bg-electric",
  Failed: "bg-danger",
  Queued: "bg-warn",
};

const STATUS_TEXT: Record<JobStatus, string> = {
  Done: "text-ok",
  Running: "text-electric",
  Failed: "text-danger",
  Queued: "text-warn",
};

/**
 * Tasks (§7.3) — the Figma "Inference Jobs" screen. Static placeholder
 * data until the Phase 2 task engine streams real jobs over SSE.
 */
export default function TasksPage() {
  return (
    <>
      <Topbar title="Inference Jobs" />
      <main className="flex-1 flex flex-col gap-5 p-8">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Icon src="ij-cpu.svg" className="size-[22px]" />
            <h2 className="text-[22px] font-bold text-fg-1">Inference Jobs</h2>
            <span className="rounded-md bg-panel-2 px-2.5 py-1 text-xs font-medium text-fg-2">
              156 total
            </span>
          </div>
          <span className="flex items-center gap-1.5 h-9 rounded-lg bg-fg-1 px-4 text-[13px] font-semibold text-black">
            <Icon src="ij-plus.svg" className="size-4" />
            New Job
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex-1 flex items-center gap-2 h-9 rounded-lg bg-panel border border-line-1 px-3">
            <Icon src="ij-search.svg" className="size-4" />
            <span className="text-[13px] text-fg-3">Search jobs by model, agent, or ID...</span>
          </div>
          {["All Status", "All Models"].map((label) => (
            <span
              key={label}
              className="flex items-center gap-1.5 h-9 rounded-lg bg-panel border border-line-1 px-3 text-[13px] font-medium text-fg-2"
            >
              {label}
              <Icon src="ij-chevron.svg" className="size-3.5" />
            </span>
          ))}
        </div>
        <div className="flex-1 rounded-[14px] bg-panel border border-line-2 overflow-hidden">
          <div className="flex items-center h-[37px] bg-panel-2 px-5 text-[11px] font-semibold text-fg-2">
            <span className="w-[200px] shrink-0">Job ID</span>
            <span className="flex-1">Model</span>
            <span className="w-[140px] shrink-0">Agent</span>
            <span className="w-[100px] shrink-0">Tokens</span>
            <span className="w-[90px] shrink-0">Latency</span>
            <span className="w-[90px] shrink-0">Status</span>
            <span className="w-[100px] shrink-0">Time</span>
          </div>
          {JOBS.map((job) => (
            <div
              key={job.id}
              className={cn(
                "flex items-center h-[44.5px] border-b border-line-1 px-5 text-xs",
                job.status === "Running" && "bg-teal-brand/[0.02]",
              )}
            >
              <span className="w-[200px] shrink-0 font-mono text-job-id">{job.id}</span>
              <span className="flex-1 font-medium text-fg-1">{job.model}</span>
              <span className="w-[140px] shrink-0 text-fg-1">{job.agent}</span>
              <span className="w-[100px] shrink-0 text-fg-1">{job.tokens}</span>
              <span className="w-[90px] shrink-0 text-fg-1">{job.latency}</span>
              <span className="w-[90px] shrink-0 flex items-center gap-1.5">
                <span className={cn("size-2 rounded", STATUS_DOT[job.status])} />
                <span className={cn("font-medium", STATUS_TEXT[job.status])}>{job.status}</span>
              </span>
              <span className="w-[100px] shrink-0 text-fg-3">{job.time}</span>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
