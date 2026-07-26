#!/usr/bin/env node
/**
 * Phase 2 executable gates (master plan §11 Phase 2).
 * Boots a real agentosd and asserts Pi pin surface, connections, quota
 * allowlist, onboarding, family classification, and secret canary hygiene.
 *
 * Fixture-proven completion criteria (usage/lifecycle persist+project,
 * auth-store integrity, ambient-key block, exact probe enablement) live in
 * tooling/gates/phase-2b.mjs — run that suite too (pnpm gates / CI does).
 *
 * Usage: node tooling/gates/phase-2.mjs
 * Exit 0 = all gates green.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pickPort } from "./lib/ports.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const PORT = Number(process.env.GATE_PORT ?? 4792);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Daemons and temp dirs opened by the doctor differential, cleaned up below. */
const strayChildren = [];
const strayDirs = [];

function startDaemon(home, port = PORT, extraEnv = {}) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(port), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(timeoutMs = 10000, base = BASE) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/v1/health`);
      if (response.ok) return;
    } catch {
      // not up
    }
    await sleep(100);
  }
  throw new Error("daemon did not come up");
}

async function api(path, token, init = {}) {
  const headers = { ...(init.headers ?? {}), "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { ...init, headers });
}

async function stopDaemon(proc) {
  proc.kill("SIGTERM");
  await sleep(300);
  try {
    proc.kill("SIGKILL");
  } catch {
    // gone
  }
}

/** Absolute path of the `which` the daemon's doctor probe will shell out to. */
function resolveWhichBinary() {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "which");
    if (existsSync(candidate)) return candidate;
  }
  return "/usr/bin/which";
}

/**
 * The host PATH with every directory that ships a `uv` removed, so the only
 * `uv` the probed daemon can ever see is the one the shim dir decides to
 * provide. Everything else (sh, env, …) stays reachable.
 */
function pathWithoutUv() {
  return (process.env.PATH ?? "")
    .split(":")
    .filter((dir) => dir.length > 0 && !existsSync(join(dir, "uv")))
    .join(":");
}

function writeShim(dir, name, output) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/**
 * A stub toolchain the doctor probe will find: every required tool at a
 * satisfying version, with `uv` present or absent as asked. `pi` is handed
 * over via PI_BINARY because findPiBinary() prefers that over PATH.
 */
function makeToolShims({ includeUv, piVersion }) {
  const dir = mkdtempSync(join(tmpdir(), "agentos-p2-shim-"));
  strayDirs.push(dir);
  symlinkSync(resolveWhichBinary(), join(dir, "which"));
  writeShim(dir, "tmux", "tmux 3.5a");
  writeShim(dir, "git", "git version 2.49.0");
  writeShim(dir, "gh", "gh version 2.60.0");
  writeShim(dir, "pi", piVersion);
  if (includeUv) writeShim(dir, "uv", "uv 0.5.11");
  return dir;
}

/**
 * Boot a throwaway daemon whose environment differs from its sibling in one
 * variable — whether `uv` is on PATH — and report what refresh-doctor did.
 */
async function probeDoctorWithToolchain({ includeUv, piVersion, parseJson5 }) {
  const shimDir = makeToolShims({ includeUv, piVersion });
  const probeHome = mkdtempSync(join(tmpdir(), "agentos-p2-doctor-"));
  strayDirs.push(probeHome);
  const probePort = pickPort(4800, 60);
  const probeBase = `http://127.0.0.1:${probePort}`;
  const proc = startDaemon(probeHome, probePort, {
    PATH: `${shimDir}:${pathWithoutUv()}`,
    PI_BINARY: join(shimDir, "pi"),
  });
  strayChildren.push(proc);
  try {
    await waitForHealth(15000, probeBase);
    const probeToken = readFileSync(join(probeHome, "daemon.token"), "utf8").trim();
    const response = await fetch(`${probeBase}/v1/onboarding`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${probeToken}` },
      body: JSON.stringify({ action: "refresh-doctor" }),
    });
    const payload = await response.json();
    const persisted = parseJson5(readFileSync(join(probeHome, "onboarding.json5"), "utf8"));
    return {
      status: response.status,
      step: payload.state?.step,
      doctor: Array.isArray(payload.state?.doctor) ? payload.state.doctor : [],
      persistedStep: persisted.step,
      persistedDoctor: Array.isArray(persisted.doctor) ? persisted.doctor : [],
    };
  } finally {
    await stopDaemon(proc);
  }
}

let home;
let child;
let exitCode = 0;
try {
  home = mkdtempSync(join(tmpdir(), "agentos-p2-"));
  child = startDaemon(home);
  await waitForHealth();
  const token = readFileSync(join(home, "daemon.token"), "utf8").trim();

  // G1 — Pi pin reported on status
  {
    const res = await api("/v1/status", token);
    const body = await res.json();
    const ok =
      res.ok &&
      body.pi?.pinnedVersion === "0.82.0" &&
      typeof body.pi?.managedHome === "string";
    gate("G1", "Pi pin + managed home on /v1/status", ok, `pin=${body.pi?.pinnedVersion}`);
  }

  // G2 — quota domain installed in effective config
  {
    const res = await api("/v1/config/effective", token);
    const body = await res.json();
    const ok =
      res.ok &&
      body.config?.quota?.pollIntervalSeconds === 300 &&
      body.sources["quota.pollIntervalSeconds"] === "shipped";
    gate("G2", "quota.json5 shipped domain", ok);
  }

  // G3 — api-key connection (no secret in response body canary)
  {
    const canary = "agentos-canary-secret-DO-NOT-LEAK-7f3a9c";
    const res = await api("/v1/connections/api-key", token, {
      method: "POST",
      body: JSON.stringify({
        provider: "openrouter",
        apiKey: canary,
        label: "OpenRouter test",
      }),
    });
    const body = await res.json();
    const text = JSON.stringify(body);
    const ok =
      res.ok &&
      body.connection?.provider === "openrouter" &&
      !text.includes(canary) &&
      existsSync(join(home, "secrets", "openrouter.key"));
    gate("G3", "api-key connect + secret not in REST body", ok);
  }

  // G4 — connections list
  {
    const res = await api("/v1/connections", token);
    const body = await res.json();
    gate(
      "G4",
      "GET /v1/connections",
      res.ok && Array.isArray(body.connections) && body.connections.length >= 1,
      `n=${body.connections?.length}`,
    );
  }

  // G5 — onboarding doctor GATES the wizard on uv, and persists that decision.
  //
  // `Array.isArray(state.doctor)` is true whether uv is probed, required,
  // optional or absent from the checklist entirely — it cannot fail on the
  // defect it exists to catch. So the assertion below is a differential: two
  // daemons whose environments differ in exactly one variable (a resolvable
  // `uv`), which must produce two different wizard steps. Drop uv from the
  // checklist, or demote it to an optional warning like `gh`, and the
  // uv-absent daemon walks on to `providers` and this goes red.
  {
    const res = await api("/v1/onboarding", token, {
      method: "POST",
      body: JSON.stringify({ action: "refresh-doctor" }),
    });
    const body = await res.json();
    const disk = existsSync(join(home, "onboarding.json5"));

    // json5 is not a gate dependency; borrow the daemon's own copy so the
    // persisted file is read exactly the way the daemon writes it.
    const json5Path = createRequire(
      join(ROOT, "apps", "orchestrator", "dist", "onboarding", "state.js"),
    ).resolve("json5");
    const json5Module = await import(pathToFileURL(json5Path).href);
    const json5 = json5Module.default ?? json5Module;
    const parseJson5 = (text) => json5.parse(text);

    const protocol = await import(
      pathToFileURL(join(ROOT, "packages", "protocol", "dist", "index.js")).href
    );
    const piVersion = protocol.PI_PINNED_VERSION;

    const withUv = await probeDoctorWithToolchain({ includeUv: true, piVersion, parseJson5 });
    const withoutUv = await probeDoctorWithToolchain({ includeUv: false, piVersion, parseJson5 });

    const uvPresent = withUv.doctor.find((check) => check.id === "uv");
    const uvAbsent = withoutUv.doctor.find((check) => check.id === "uv");
    const uvAbsentOnDisk = withoutUv.persistedDoctor.find((check) => check.id === "uv");
    // `uvAbsent?.installHint !== null` is also true when the uv check is gone
    // from the checklist entirely (undefined !== null); demand a real string so
    // this clause fails on the same defect the rest of the assertion catches.
    const uvHint = uvAbsent?.installHint;
    const hintOffered = typeof uvHint === "string" && uvHint.length > 0;

    const ok =
      res.ok &&
      Array.isArray(body.state?.doctor) &&
      disk &&
      // A complete toolchain reports uv healthy and releases the doctor step.
      withUv.status === 200 &&
      uvPresent?.ok === true &&
      withUv.step === "providers" &&
      withUv.persistedStep === "providers" &&
      // Remove only uv and the wizard is pinned to doctor, on the wire and on disk.
      withoutUv.status === 200 &&
      uvAbsent?.ok === false &&
      hintOffered &&
      withoutUv.step === "doctor" &&
      withoutUv.persistedStep === "doctor" &&
      uvAbsentOnDisk?.ok === false;
    gate(
      "G5",
      "onboarding doctor gates on uv + persists step",
      ok,
      // Every asserted value is printed: a failure has to say which half of the
      // differential broke, otherwise a red looks identical to a green.
      `uv-present→${withUv.step}/disk ${withUv.persistedStep} (uv ok=${uvPresent?.ok}), ` +
        `uv-absent→${withoutUv.step}/disk ${withoutUv.persistedStep} ` +
        `(uv ok=${uvAbsent?.ok}, disk uv ok=${uvAbsentOnDisk?.ok}, hint=${hintOffered})`,
    );
  }

  // G6 — Claude subscription path blocks complete without SDK verification
  {
    await api("/v1/onboarding", token, {
      method: "POST",
      body: JSON.stringify({ action: "set-providers", providers: ["anthropic"] }),
    });
    await api("/v1/onboarding", token, {
      method: "POST",
      body: JSON.stringify({ action: "set-claude-billing", claudeBillingMode: "subscription-sdk" }),
    });
    const res = await api("/v1/onboarding", token, {
      method: "POST",
      body: JSON.stringify({ action: "complete" }),
    });
    const body = await res.json();
    gate(
      "G6",
      "Claude SDK path blocks incomplete complete()",
      res.status === 409 && body.error?.code === "ONBOARDING_BLOCKED",
      `status=${res.status}`,
    );
  }

  // G7 — the extension socket hub is actually LISTENING, owner-only.
  //
  // `existsSync(home/sockets)` could not fail on the defect it existed to
  // catch: SocketHub.listen() mkdirs that directory before it binds, and
  // daemon.ts swallows a bind failure with a warning ("socket hub failed to
  // listen — extension channel unavailable"). So the directory is there
  // whether or not the extension channel came up. Connect to hub.sock
  // instead: a hub that never bound refuses the connection.
  {
    const hub = join(home, "sockets", "hub.sock");
    const deadline = Date.now() + 5000;
    let connected = false;
    while (Date.now() < deadline) {
      if (existsSync(hub)) {
        connected = await new Promise((resolve) => {
          const socket = connect(hub);
          const settle = (value) => {
            socket.destroy();
            resolve(value);
          };
          socket.on("connect", () => settle(true));
          socket.on("error", () => settle(false));
          socket.setTimeout(2000, () => settle(false));
        });
        if (connected) break;
      }
      await sleep(200);
    }
    // Owner-only: the control channel must not be reachable by other local
    // users on a shared host.
    const mode = existsSync(hub) ? statSync(hub).mode & 0o777 : null;
    gate(
      "G7",
      "extension socket hub listening (owner-only)",
      connected && mode !== null && (mode & 0o077) === 0,
      `connect=${connected} mode=${mode === null ? "absent" : mode.toString(8)}`,
    );
  }

  // G8 — family classification via protocol (imported through status pin already);
  // re-assert claude-agent-sdk family by running a tiny node eval against dist
  {
    const { spawnSync } = await import("node:child_process");
    const evalJs = `
      import { familyOfModelRef } from '${join(ROOT, "packages/protocol/dist/index.js")}';
      if (familyOfModelRef('claude-agent-sdk/claude-opus-4-5') !== 'anthropic') process.exit(1);
      if (familyOfModelRef('anthropic/claude-fable-5') !== 'anthropic') process.exit(1);
      if (familyOfModelRef('openai/gpt-5') !== 'openai') process.exit(1);
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", evalJs], {
      encoding: "utf8",
    });
    gate("G8", "claude-agent-sdk family=anthropic", r.status === 0, r.stderr?.slice(0, 120));
  }

  // G9 — probe allowlist module denies evil URLs
  {
    const { spawnSync } = await import("node:child_process");
    const mod = join(ROOT, "apps/orchestrator/dist/quota-probes/allowlist.js");
    const evalJs = `
      import { isProbeUrlAllowed } from '${mod}';
      if (isProbeUrlAllowed('https://evil.example/x')) process.exit(2);
      if (!isProbeUrlAllowed('https://api.anthropic.com/api/oauth/usage')) process.exit(3);
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", evalJs], {
      encoding: "utf8",
    });
    gate("G9", "probe URL allowlist boundary", r.status === 0, `status=${r.status}`);
  }
} catch (error) {
  console.error(error);
  gate("GX", "gate runner", false, error instanceof Error ? error.message : String(error));
} finally {
  if (child !== undefined) {
    await stopDaemon(child);
  }
  for (const stray of strayChildren) {
    await stopDaemon(stray);
  }
  const dirs = home !== undefined ? [home, ...strayDirs] : strayDirs;
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
exitCode = failed.length === 0 ? 0 : 1;
process.exit(exitCode);
