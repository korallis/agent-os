import { execFileSync } from "node:child_process";

/**
 * `agentos doctor` — environment preflight (master plan §11 Phase 1 gate:
 * "doctor verifies tmux/git/gh/node/pi/uv"; §4.10 wizard reuses the same
 * probes). Missing tools remain non-fatal warnings here; the onboarding
 * wizard (§4.10) drives guided installs and hard blocks for Pi / Claude SDK
 * paths. Fleet-hard deps (tmux) still land with Phase 3.
 */

export interface DoctorCheck {
  tool: string;
  ok: boolean;
  version: string | null;
  note: string;
}

interface ToolSpec {
  tool: string;
  args: string[];
  note: string;
}

const TOOLS: readonly ToolSpec[] = [
  { tool: "node", args: ["--version"], note: "runtime (require >=24)" },
  { tool: "tmux", args: ["-V"], note: "session backend — hard dependency from Phase 3" },
  { tool: "git", args: ["--version"], note: "worktrees + delivery" },
  { tool: "gh", args: ["--version"], note: "PR delivery modes" },
  { tool: "pi", args: ["--version"], note: "the one worker harness (pinned @earendil-works/pi-coding-agent)" },
  { tool: "uv", args: ["--version"], note: "gate runtime — hard v1 dependency (Phase 5)" },
];

function probe(spec: ToolSpec): DoctorCheck {
  try {
    const output = execFileSync(spec.tool, spec.args, {
      encoding: "utf8",
      timeout: 5000,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const version = output.split("\n")[0]?.trim() ?? "";
    return { tool: spec.tool, ok: true, version, note: spec.note };
  } catch {
    return { tool: spec.tool, ok: false, version: null, note: spec.note };
  }
}

export function runDoctor(): DoctorCheck[] {
  return TOOLS.map(probe);
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
  const lines: string[] = ["agentos doctor — environment preflight", ""];
  for (const check of checks) {
    const status = check.ok ? "✓" : "⚠ missing";
    const version = check.version ?? "—";
    lines.push(`  ${check.tool.padEnd(6)} ${status.padEnd(10)} ${version.padEnd(28)} ${check.note}`);
  }
  const missing = checks.filter((c) => !c.ok);
  lines.push("");
  lines.push(
    missing.length === 0
      ? "all tools present."
      : `${missing.length} tool(s) missing — reported as warnings (${missing
          .map((c) => c.tool)
          .join(", ")}); use the Console onboarding wizard for guided install.`,
  );
  return lines.join("\n");
}
