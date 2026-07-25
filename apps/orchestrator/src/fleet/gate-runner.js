import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scrubEnv } from "../security/env-scrub.js";
/**
 * Minimal allowlist env for gate subprocesses. Brain-authored gates are untrusted
 * code on the Captain's machine — never inherit provider keys or the daemon env.
 */
export function buildGateEnv(parent, target) {
    const extraAllow = {
        AGENTOS_GATE_TARGET: target,
    };
    // uv run needs its cache dir when present; still no secrets.
    if (parent.UV_CACHE_DIR !== undefined && parent.UV_CACHE_DIR.length > 0) {
        extraAllow.UV_CACHE_DIR = parent.UV_CACHE_DIR;
    }
    if (parent.UV_PYTHON_INSTALL_DIR !== undefined &&
        parent.UV_PYTHON_INSTALL_DIR.length > 0) {
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
 *
 * RED proofs and FAIL ledgers are process-local (daemon memory). Disk under
 * validation/ is an audit cache only — never the authorisation source.
 */
export class GateRunner {
    home;
    config;
    /** Sole source of truth for RED proofs while the daemon is alive. */
    redProofs = new Map();
    /** Sole source of truth for verbatim FAIL inject while the daemon is alive. */
    failLedgers = new Map();
    proofSecret = null;
    constructor(home, config) {
        this.home = home;
        this.config = config;
    }
    updateConfig(config) {
        this.config = config;
    }
    gateWorkspace(taskId) {
        const dir = join(this.home, "runs", taskId, "gate-workspace");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }
    /**
     * Audit/cache directory. Seats must not be trusted to write here; the daemon
     * never authorises candidate runs from files under this path alone.
     */
    validationDir(taskId) {
        const dir = join(this.home, "runs", taskId, "validation");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }
    writeGateSource(taskId, source, language = this.config.gateLanguage) {
        const dir = this.gateWorkspace(taskId);
        const file = language === "py" ? join(dir, "gate.py") : join(dir, "gate.ts");
        writeFileSync(file, source, { mode: 0o600 });
        return file;
    }
    /** sha256 of the current gate source — its revision identity. */
    gateSourceHash(taskId, language = this.config.gateLanguage) {
        const dir = this.gateWorkspace(taskId);
        const file = language === "py" ? join(dir, "gate.py") : join(dir, "gate.ts");
        if (!existsSync(file))
            return null;
        return hash(readFileSync(file, "utf8"));
    }
    redProofPath(taskId) {
        return join(this.validationDir(taskId), "red-proof.json");
    }
    getProofSecret() {
        if (this.proofSecret !== null)
            return this.proofSecret;
        const dir = join(this.home, "secrets");
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
            chmodSync(dir, 0o700);
        }
        catch {
            // best-effort owner-only
        }
        const path = join(dir, "gate-proof.key");
        if (existsSync(path)) {
            this.proofSecret = readFileSync(path);
            try {
                chmodSync(path, 0o600);
            }
            catch {
                // best-effort owner-only
            }
        }
        else {
            const secret = randomBytes(32);
            writeFileSync(path, secret, { mode: 0o600 });
            try {
                chmodSync(path, 0o600);
            }
            catch {
                // best-effort owner-only
            }
            this.proofSecret = secret;
        }
        return this.proofSecret;
    }
    signGateSourceHash(gateSourceHash) {
        return createHmac("sha256", this.getProofSecret()).update(gateSourceHash).digest("hex");
    }
    verifyProofHmac(proof) {
        const expected = this.signGateSourceHash(proof.gateSourceHash);
        try {
            const a = Buffer.from(expected, "utf8");
            const b = Buffer.from(proof.hmac, "utf8");
            if (a.length !== b.length)
                return false;
            return timingSafeEqual(a, b);
        }
        catch {
            return false;
        }
    }
    /**
     * Record that a specific gate revision was proven semantically RED at
     * baseline. Process memory is authoritative; optional disk write is cache.
     */
    recordRedProof(taskId, proof) {
        const signed = {
            gateSourceHash: proof.gateSourceHash,
            outcome: proof.outcome,
            provenAt: proof.provenAt,
            hmac: proof.hmac ?? this.signGateSourceHash(proof.gateSourceHash),
        };
        if (!this.verifyProofHmac(signed)) {
            throw new Error("refusing to record RED proof with invalid HMAC");
        }
        this.redProofs.set(taskId, signed);
        try {
            writeFileSync(this.redProofPath(taskId), `${JSON.stringify(signed, null, 2)}\n`, {
                mode: 0o600,
            });
        }
        catch {
            // Cache is best-effort; memory remains the authority.
        }
        return signed;
    }
    getRedProof(taskId) {
        const proof = this.redProofs.get(taskId);
        if (proof === undefined)
            return null;
        if (!this.verifyProofHmac(proof)) {
            this.redProofs.delete(taskId);
            return null;
        }
        return proof;
    }
    /**
     * Install a durable proof (task record or event replay) into process memory.
     * Forged proofs without a valid HMAC are rejected.
     */
    installRedProof(taskId, proof) {
        if (!this.verifyProofHmac(proof))
            return false;
        this.redProofs.set(taskId, proof);
        return true;
    }
    /**
     * Install a proof recovered from the append-only event log.
     * Verifies the stored HMAC against the daemon key — never re-signs disk or
     * log content (re-signing would turn the event log into an authorization oracle).
     */
    installRedProofFromEvent(taskId, input) {
        const proof = {
            gateSourceHash: input.gateSourceHash,
            outcome: input.outcome,
            provenAt: input.provenAt,
            hmac: input.hmac,
        };
        if (!this.installRedProof(taskId, proof))
            return null;
        return proof;
    }
    /**
     * A candidate run is only meaningful when THIS gate revision has been proven
     * red at baseline. Authorisation reads process memory only — never a file a
     * spawned seat could have written under validation/ or gate-workspace/.
     */
    hasRedProofForCurrentSource(taskId, language = this.config.gateLanguage) {
        const current = this.gateSourceHash(taskId, language);
        if (current === null)
            return false;
        const proof = this.getRedProof(taskId);
        if (proof === null)
            return false;
        return proof.gateSourceHash === current;
    }
    /** Persist the exact FAIL bytes plus their hash for verbatim re-injection. */
    writeFailLedger(taskId, failLines) {
        const text = failLines.join("\n") + (failLines.length > 0 ? "\n" : "");
        const ledger = { text, hash: hash(text) };
        this.failLedgers.set(taskId, ledger);
        try {
            const dir = this.validationDir(taskId);
            writeFileSync(join(dir, "last-fail.txt"), text, { mode: 0o600 });
            writeFileSync(join(dir, "last-fail.sha256"), `${ledger.hash}\n`, { mode: 0o600 });
        }
        catch {
            // Cache is best-effort.
        }
        return ledger;
    }
    getFailLedger(taskId) {
        return this.failLedgers.get(taskId) ?? null;
    }
    installFailLedger(taskId, ledger) {
        this.failLedgers.set(taskId, ledger);
    }
    /**
     * Hash of the last FAIL bytes. `send_to_crew` re-hashes what it is about to
     * inject and compares against daemon memory, so the substrate can prove the
     * builder received the gate's exact words rather than a Brain paraphrase.
     */
    lastFailHash(taskId) {
        return this.failLedgers.get(taskId)?.hash ?? null;
    }
    static hashText(text) {
        return hash(text);
    }
    /**
     * Run the gate against baseline or candidate cwd.
     * Outcome is parsed from stdout lines: PASS | FAIL | GATE_ERROR | EXPECTED_RED.
     */
    run(input) {
        const dir = this.gateWorkspace(input.taskId);
        const language = input.language ?? this.config.gateLanguage;
        const gateFile = language === "py" ? join(dir, "gate.py") : join(dir, "gate.ts");
        if (!existsSync(gateFile)) {
            // Default minimal gate for local-only fixtures: always PASS candidate, EXPECTED_RED baseline when empty.
            const defaultSource = language === "py"
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
            // Outcome resolution order for zero-token fixtures:
            // 1. AGENTOS_FAKE_GATE_OUTCOME env (process-wide)
            // 2. $AGENTOS_HOME/fake-gate-outcome file (per-seed, gate scripts write this)
            // 3. target defaults (baseline → EXPECTED_RED, candidate → PASS)
            const fileOutcomePath = join(this.home, "fake-gate-outcome");
            const fileOutcome = existsSync(fileOutcomePath)
                ? readFileSync(fileOutcomePath, "utf8").trim()
                : "";
            const forced = process.env.AGENTOS_FAKE_GATE_OUTCOME ??
                (fileOutcome.length > 0 ? fileOutcome : undefined);
            if (forced !== undefined) {
                stdout = forced;
            }
            else if (input.target === "baseline") {
                stdout = "EXPECTED_RED\nFAIL baseline must be red\n";
            }
            else {
                stdout = "PASS\n";
            }
        }
        else {
            const spawnOpts = {
                cwd: input.cwd,
                encoding: "utf8",
                timeout: this.config.gateTimeoutSeconds * 1000,
                env: gateEnv,
            };
            const spawned = language === "py"
                ? spawnSync("uv", ["run", gateFile], spawnOpts)
                : spawnSync(process.execPath, ["--experimental-strip-types", gateFile], spawnOpts);
            // Shared for every language: missing runtime, timeout, signal, or no
            // normal exit is infrastructure — partial stdout is never a verdict.
            const infra = infrastructureFromSpawn(spawned, language === "py" ? "uv" : "node", started, gateFile);
            if (infra !== null)
                return infra;
            status = spawned.status ?? 1;
            stdout = spawned.stdout ?? "";
            stderr = spawned.stderr ?? "";
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
    readLastFailLines(taskId) {
        const ledger = this.failLedgers.get(taskId);
        if (ledger === undefined)
            return [];
        return ledger.text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
    }
}
function hash(text) {
    return createHash("sha256").update(text).digest("hex");
}
/**
 * Shared post-spawn gate for every language branch. Timeout, ENOENT, signal,
 * or any non-normal exit is infrastructure — never RED, never FAIL ledger.
 * Partial stdout from a killed process is discarded (not a verdict).
 */
function infrastructureFromSpawn(result, runtime, started, gateFile) {
    const err = result.error;
    const abnormal = err !== undefined ||
        result.status === null ||
        (result.signal !== null && result.signal !== undefined);
    if (!abnormal)
        return null;
    const code = err?.code ??
        (result.signal !== null && result.signal !== undefined
            ? `signal:${result.signal}`
            : "no-exit");
    let message;
    if (err?.code === "ENOENT") {
        message =
            runtime === "uv"
                ? "uv not found — install uv (hard v1 dependency); this is an infrastructure error, not a gate failure"
                : `gate runtime (${runtime}) not found — infrastructure error, not a gate failure`;
    }
    else {
        message = `gate runtime error (${code ?? err?.message ?? "abnormal exit"}) — infrastructure error, not a gate failure`;
    }
    return {
        outcome: "GATE_ERROR",
        stdout: "",
        stderr: message,
        outputHash: hash(""),
        durationMs: Date.now() - started,
        failLines: [],
        gateSourceHash: hash(readFileSync(gateFile, "utf8")),
        infrastructureError: true,
    };
}
function parseOutcome(stdout, status) {
    const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
    for (const line of lines) {
        if (line === "EXPECTED_RED" || line.startsWith("EXPECTED_RED "))
            return "EXPECTED_RED";
        if (line === "PASS" || line.startsWith("PASS "))
            return "PASS";
        if (line === "FAIL" || line.startsWith("FAIL "))
            return "FAIL";
        if (line === "GATE_ERROR" || line.startsWith("GATE_ERROR "))
            return "GATE_ERROR";
    }
    if (status !== 0)
        return "GATE_ERROR";
    return "GATE_ERROR";
}
function defaultGatePy(baselineRed) {
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
function defaultGateTs(baselineRed) {
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
