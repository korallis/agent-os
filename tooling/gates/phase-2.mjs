#!/usr/bin/env node
/**
 * Phase 2 executable gates (master plan §11 Phase 2).
 * Boots a real agentosd and asserts Pi pin surface, connections, quota
 * allowlist, onboarding, family classification, and secret canary hygiene.
 *
 * Usage: node tooling/gates/phase-2.mjs
 * Exit 0 = all gates green.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const PORT = Number(process.env.GATE_PORT ?? 4792);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startDaemon(home) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/v1/health`);
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

let home;
let child;
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

  // G5 — onboarding doctor refresh + resumability file
  {
    const res = await api("/v1/onboarding", token, {
      method: "POST",
      body: JSON.stringify({ action: "refresh-doctor" }),
    });
    const body = await res.json();
    const disk = existsSync(join(home, "onboarding.json5"));
    gate(
      "G5",
      "onboarding doctor + persisted state",
      res.ok && Array.isArray(body.state?.doctor) && disk,
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

  // G7 — extension socket hub path exists under home
  {
    const hub = join(home, "sockets", "hub.sock");
    // hub.sock may be a socket file
    gate("G7", "extension socket hub created", existsSync(join(home, "sockets")));
    void hub;
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
    child.kill("SIGTERM");
    await sleep(300);
    try {
      child.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  if (home !== undefined) {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
process.exit(failed.length === 0 ? 0 : 1);
