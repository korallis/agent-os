import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ValidationConfig } from "@agent-os/protocol";
import { scrubEnv } from "../security/env-scrub.js";

export type GateOutcome = "PASS" | "FAIL" | "GATE_ERROR" | "EXPECTED_RED";

export interface GateRunResult {
  outcome: GateOutcome;
  stdout: string;
  stderr: string;
  outputHash: string;
  durationMs: number;
  failLines: string[];
  /** sha256 of the gate SOURCE this outcome came from (revision identity). */
  gateSourceHash: string;
  /**
   * True when the gate could not run at all (missing runtime, timeout, crash).
   * Infrastructure failure is never a RED verdict — a gate that did not execute
   * has proven nothing about the code.
   */
  infrastructureError: boolean;
}

/** RED-proof ledger entry: which gate revision was proven red, and when. */
export interface RedProof {
  gateSourceHash: string;
  outcome: Extract<GateOutcome, "EXPECTED_RED" | "FAIL">;
  provenAt: string;
}

/**
 * Minimal allowlist env for gate subprocesses. Brain-authored gates are untrusted
 * code on the Captain's machine — never inherit provider keys or the daemon env.
 */
export function buildGateEnv(
  parent: NodeJS.ProcessEnv,
  target: "baseline" | "candidate",
): Record<string, string> {
  const extraAllow: Record<string, string> = {
    AGENTOS_GATE_TARGET: target,
  };
  // uv run needs its cache dir when present; still no secrets.
  if (parent.UV_CACHE_DIR !== undefined && parent.UV_CACHE_DIR.length > 0) {
    extraAllow.UV_CACHE_DIR = parent.UV_CACHE_DIR;
  }
  if (
    parent.UV_PYTHON_INSTALL_DIR !== undefined &&
    parent.UV_PYTHON_INSTALL_DIR.length > 0
  ) {
    extraAllow.UV_PYTHON_INSTALL_DIR = parent.UV_PYTHON_INSTALL_DIR;
  }
  return scrubEnv(parent, {
    grantProviderKey: null,
    extraAllow,
    assertSingle: false,
  }).env;
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

  /**
   * Daemon-owned evidence directory outside the validator write-jail.
   * RED proofs and FAIL ledgers live here so a spawned seat cannot forge them.
   */
  validationDir(taskId: string): string {
    const dir = join(this.home, "runs", taskId, "validation");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  writeGateSource(taskId: string, source: string, language: "py" | "ts" = this.config.gateLanguage): string {
    const dir = this.gateWorkspace(taskId);
    const file = language === "py" ? join(dir, "gate.py") : join(dir, "gate.ts");
    writeFileSync(file, source, { mode: 0o600 });
    return file;
  }

  /** sha256 of the current gate source — its revision identity. */
  gateSourceHash(taskId: string, language: "py" | "ts" = this.config.gateLanguage): string | null {
    const dir = this.gateWorkspace(taskId);
    const file = language === "py" ? join(dir, "gate.py") : join(dir, "gate.ts");
    if (!existsSync(file)) return null;
    return hash(readFileSync(file, "utf8"));
  }

  private redProofPath(taskId: string): string {
    return join(this.validationDir(taskId), "red-proof.json");
  }

  /**
   * Record that a specific gate revision was proven semantically RED at
   * baseline. Keyed by source hash so an edited gate loses its proof.
   * Written only by the daemon into validation/ — never into the validator jail.
   */
  recordRedProof(taskId: string, proof: RedProof): void {
    writeFileSync(this.redProofPath(taskId), `${JSON.stringify(proof, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  readRedProof(taskId: string): RedProof | null {
    const path = this.redProofPath(taskId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as RedProof;
    } catch {
      return null;
    }
  }

  /**
   * A candidate run is only meaningful when THIS gate revision has been proven
   * red at baseline. The daemon hashes the gate file it is about to judge and
   * compares against the daemon-owned proof — never an on-disk proof the
   * validator could have written inside its jail.
   */
  hasRedProofForCurrentSource(
    taskId: string,
    language: "py" | "ts" = this.config.gateLanguage,
  ): boolean {
    const current = this.gateSourceHash(taskId, language);
    if (current === null) return false;
    return this.readRedProof(taskId)?.gateSourceHash === current;
  }

  /** Persist the exact FAIL bytes plus their hash for verbatim re-injection. */
  private writeFailLedger(taskId: string, failLines: string[]): void {
    const dir = this.validationDir(taskId);
    const text = failLines.join("\n") + (failLines.length > 0 ? "\n" : "");
    writeFileSync(join(dir, "last-fail.txt"), text, { mode: 0o600 });
    writeFileSync(join(dir, "last-fail.sha256"), `${hash(text)}\n`, { mode: 0o600 });
  }

  /**
   * Hash of the last FAIL bytes. `send_to_crew` re-hashes what it is about to
   * inject and compares, so the substrate can prove the builder received the
   * gate's exact words rather than a Brain paraphrase.
   */
  lastFailHash(taskId: string): string | null {
    const path = join(this.validationDir(taskId), "last-fail.sha256");
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf8").trim();
    } catch {
      return null;
    }
  }

  static hashText(text: string): string {
    return hash(text);
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
    /** Override gate language for this run (tests / explicit authoring). */
    language?: "py" | "ts";
  }): GateRunResult {
    const dir = this.gateWorkspace(input.taskId);
    const language = input.language ?? this.config.gateLanguage;
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
    const gateEnv = buildGateEnv(process.env, input.target);

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
          env: gateEnv,
        },
      );
      status = uv.status ?? 1;
      stdout = uv.stdout ?? "";
      stderr = uv.stderr ?? "";
      if (uv.error !== undefined) {
        const code = (uv.error as NodeJS.ErrnoException).code;
        // Missing runtime or a timeout is INFRASTRUCTURE, never a RED verdict:
        // a gate that never executed has proven nothing about the code.
        return {
          outcome: "GATE_ERROR",
          stdout: "",
          stderr:
            code === "ENOENT"
              ? "uv not found — install uv (hard v1 dependency); this is an infrastructure error, not a gate failure"
              : `gate runtime error (${code ?? uv.error.message}) — infrastructure error, not a gate failure`,
          outputHash: hash(""),
          durationMs: Date.now() - started,
          failLines: [],
          gateSourceHash: hash(readFileSync(gateFile, "utf8")),
          infrastructureError: true,
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
          env: gateEnv,
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
    const gateSourceHash = hash(readFileSync(gateFile, "utf8"));

    if (outcome === "FAIL" || outcome === "EXPECTED_RED") {
      this.writeFailLedger(input.taskId, failLines);
    }
    // A baseline that is genuinely red proves THIS revision of the gate.
    if (input.target === "baseline" && (outcome === "EXPECTED_RED" || outcome === "FAIL")) {
      this.recordRedProof(input.taskId, {
        gateSourceHash,
        outcome,
        provenAt: new Date().toISOString(),
      });
    }

    return {
      outcome,
      stdout,
      stderr,
      outputHash: hash(stdout),
      durationMs: Date.now() - started,
      failLines,
      gateSourceHash,
      // A non-zero exit with no recognised verdict line means the gate crashed
      // rather than judged; treat it as infrastructure, not as RED.
      infrastructureError: outcome === "GATE_ERROR",
    };
  }

  readLastFailLines(taskId: string): string[] {
    const path = join(this.validationDir(taskId), "last-fail.txt");
    if (!existsSync(path)) return [];
    try {
      return readFileSync(path, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    } catch {
      return [];
    }
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
