import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ValidationConfig } from "@agent-os/protocol";

export type GateOutcome = "PASS" | "FAIL" | "GATE_ERROR" | "EXPECTED_RED";

export interface GateRunResult {
  outcome: GateOutcome;
  stdout: string;
  stderr: string;
  outputHash: string;
  durationMs: number;
  failLines: string[];
}

/**
 * Deterministic gate runner (master plan §6.4).
 * Default: gate.py via `uv run` + PEP 723. Override: gate.ts via node strip-types.
 * Never trusts any LLM — including the Brain.
 */
export class GateRunner {
  constructor(
    private readonly home: string,
    private config: ValidationConfig,
  ) {}

  updateConfig(config: ValidationConfig): void {
    this.config = config;
  }

  gateWorkspace(taskId: string): string {
    const dir = join(this.home, "runs", taskId, "gate-workspace");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  writeGateSource(taskId: string, source: string, language: "py" | "ts" = this.config.gateLanguage): string {
    const dir = this.gateWorkspace(taskId);
    const file = language === "py" ? join(dir, "gate.py") : join(dir, "gate.ts");
    writeFileSync(file, source, { mode: 0o600 });
    return file;
  }

  /**
   * Run the gate against baseline or candidate cwd.
   * Outcome is parsed from stdout lines: PASS | FAIL | GATE_ERROR | EXPECTED_RED.
   */
  run(input: {
    taskId: string;
    target: "baseline" | "candidate";
    cwd: string;
    expectedRed?: boolean;
  }): GateRunResult {
    const dir = this.gateWorkspace(input.taskId);
    const language = this.config.gateLanguage;
    const gateFile = language === "py" ? join(dir, "gate.py") : join(dir, "gate.ts");

    if (!existsSync(gateFile)) {
      // Default minimal gate for local-only fixtures: always PASS candidate, EXPECTED_RED baseline when empty.
      const defaultSource =
        language === "py"
          ? defaultGatePy(input.expectedRed === true && input.target === "baseline")
          : defaultGateTs(input.expectedRed === true && input.target === "baseline");
      writeFileSync(gateFile, defaultSource, { mode: 0o600 });
    }

    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let status = 0;

    if (process.env.AGENTOS_FAKE_GATE === "1") {
      const forced = process.env.AGENTOS_FAKE_GATE_OUTCOME as GateOutcome | undefined;
      if (forced !== undefined) {
        stdout = forced;
      } else if (input.target === "baseline") {
        stdout = "EXPECTED_RED\nFAIL baseline must be red\n";
      } else {
        stdout = "PASS\n";
      }
    } else if (language === "py") {
      const uv = spawnSync(
        "uv",
        ["run", gateFile],
        {
          cwd: input.cwd,
          encoding: "utf8",
          timeout: this.config.gateTimeoutSeconds * 1000,
          env: { ...process.env, AGENTOS_GATE_TARGET: input.target },
        },
      );
      status = uv.status ?? 1;
      stdout = uv.stdout ?? "";
      stderr = uv.stderr ?? "";
      if (uv.error && (uv.error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          outcome: "GATE_ERROR",
          stdout: "",
          stderr: "uv not found — install uv (hard v1 dependency)",
          outputHash: hash(""),
          durationMs: Date.now() - started,
          failLines: [],
        };
      }
    } else {
      const node = spawnSync(
        process.execPath,
        ["--experimental-strip-types", gateFile],
        {
          cwd: input.cwd,
          encoding: "utf8",
          timeout: this.config.gateTimeoutSeconds * 1000,
          env: { ...process.env, AGENTOS_GATE_TARGET: input.target },
        },
      );
      status = node.status ?? 1;
      stdout = node.stdout ?? "";
      stderr = node.stderr ?? "";
    }

    const outcome = parseOutcome(stdout, status);
    const failLines = stdout
      .split("\n")
      .filter((l) => l.startsWith("FAIL") || l.includes("FAIL "))
      .map((l) => l.trim());

    // Persist last FAIL lines for verbatim send_to_crew
    const failPath = join(dir, "last-fail.txt");
    if (outcome === "FAIL" || outcome === "EXPECTED_RED") {
      writeFileSync(failPath, failLines.join("\n") + (failLines.length > 0 ? "\n" : ""), {
        mode: 0o600,
      });
    }

    return {
      outcome,
      stdout,
      stderr,
      outputHash: hash(stdout),
      durationMs: Date.now() - started,
      failLines,
    };
  }

  readLastFailLines(taskId: string): string[] {
    const path = join(this.gateWorkspace(taskId), "last-fail.txt");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseOutcome(stdout: string, status: number): GateOutcome {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const line of lines) {
    if (line === "EXPECTED_RED" || line.startsWith("EXPECTED_RED ")) return "EXPECTED_RED";
    if (line === "PASS" || line.startsWith("PASS ")) return "PASS";
    if (line === "FAIL" || line.startsWith("FAIL ")) return "FAIL";
    if (line === "GATE_ERROR" || line.startsWith("GATE_ERROR ")) return "GATE_ERROR";
  }
  if (status !== 0) return "GATE_ERROR";
  return "GATE_ERROR";
}

function defaultGatePy(baselineRed: boolean): string {
  if (baselineRed) {
    return `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
print("EXPECTED_RED")
print("FAIL baseline empty tree")
raise SystemExit(1)
`;
  }
  return `#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import os
target = os.environ.get("AGENTOS_GATE_TARGET", "candidate")
if target == "baseline":
    print("EXPECTED_RED")
    print("FAIL baseline must fail")
    raise SystemExit(1)
print("PASS")
`;
}

function defaultGateTs(baselineRed: boolean): string {
  if (baselineRed) {
    return `console.log("EXPECTED_RED");
console.log("FAIL baseline empty tree");
process.exit(1);
`;
  }
  return `const target = process.env.AGENTOS_GATE_TARGET ?? "candidate";
if (target === "baseline") {
  console.log("EXPECTED_RED");
  console.log("FAIL baseline must fail");
  process.exit(1);
}
console.log("PASS");
`;
}
