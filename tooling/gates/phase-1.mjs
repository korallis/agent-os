#!/usr/bin/env node
/**
 * Phase 1 executable gates (master plan §11 "Phase 1" + deferred Phase 0
 * console-shell/daemon-boot/CLI items). Boots a REAL agentosd on a temp
 * AGENTOS_HOME and asserts, over the wire:
 *
 *   G1  loopback-only + 401s (auth enforced, health open)
 *   G2  kill -9 after >100 events → exactly-once projection + SSE resume;
 *       corrupt tail quarantined
 *   G3  a state change reflects over SSE within 500 ms
 *   G4  config gates: defaults install; hot-reload observed; task>project>
 *       global>shipped precedence (unit matrix ran in vitest — re-checked
 *       here for global); /v1/config/effective per-key sources; invalid
 *       config → typed path-precise error, nothing applied; safety write
 *       needs confirmation + emits policy.changed; project layer refused
 *       (trust stub)
 *   G5  doctor runs and reports tmux/git/gh/node/pi/uv (warnings only)
 *
 * Usage: node tooling/gates/phase-1.mjs
 * Exit 0 = all gates green.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const PORT = Number(process.env.GATE_PORT ?? 4790);
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
  const child = spawn(process.execPath, [DAEMON_BIN], {
    env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function waitForHealth(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/v1/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error("daemon did not come up");
}

async function api(path, token, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { ...init, headers });
}

/** Reads SSE frames until predicate or timeout; returns envelopes. */
async function readSse(token, headers, until, timeoutMs = 4000) {
  const controller = new AbortController();
  const response = await fetch(`${BASE}/v1/events`, {
    headers: { authorization: `Bearer ${token}`, ...headers },
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames = [];
  let buffer = "";
  let pending = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    pending ??= reader.read();
    const race = await Promise.race([pending, sleep(150).then(() => "timeout")]);
    if (race === "timeout") {
      if (until(frames)) break;
      continue;
    }
    pending = null;
    if (race.done) break;
    buffer += decoder.decode(race.value, { stream: true });
    let sep = buffer.indexOf("\n\n");
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) frames.push(JSON.parse(dataLine.slice(6)));
      sep = buffer.indexOf("\n\n");
    }
    if (until(frames)) break;
  }
  controller.abort();
  return frames;
}

const home = mkdtempSync(join(tmpdir(), "agentos-gate-"));
let child = startDaemon(home);
let exitCode = 1;

try {
  await waitForHealth();
  const token = readFileSync(join(home, "daemon.token"), "utf8").trim();

  // ---------- G1: loopback + auth ----------
  {
    const health = await api("/v1/health", null);
    const status401 = await api("/v1/status", null);
    const statusOk = await api("/v1/status", token);
    const evilOrigin = await api("/v1/health", null, {
      headers: { origin: "https://evil.example" },
    });
    const body401 = await status401.json();
    gate(
      "G1",
      "loopback-only enforced; 401s; typed errors",
      health.status === 200 &&
        status401.status === 401 &&
        body401.error?.code === "UNAUTHORIZED" &&
        statusOk.status === 200 &&
        evilOrigin.status === 403,
      `health=${health.status} noauth=${status401.status} auth=${statusOk.status} origin=${evilOrigin.status}`,
    );
  }

  // ---------- G4 (part 1): defaults installed + effective sources ----------
  {
    const domains = readdirSync(join(home, "config")).filter((f) => f.endsWith(".json5"));
    const effective = await (await api("/v1/config/effective", token)).json();
    gate(
      "G4a",
      "shipped defaults install; /v1/config/effective per-key source layer",
      domains.length === 3 &&
        effective.sources["supervision.heartbeatSeconds"] === "shipped" &&
        effective.config.policies.scoutReadOnly === true,
      `installed=[${domains.join(",")}]`,
    );
  }

  // ---------- G3: state change → SSE within 500 ms ----------
  {
    let changedAt = 0;
    let observedAt = 0;
    const seen = readSse(
      token,
      {},
      (frames) => {
        if (changedAt === 0) return false;
        const hit = frames.some(
          (f) => f.event.type === "config.changed" && f.event.payload.domain === "supervision",
        );
        if (hit && observedAt === 0) observedAt = Date.now();
        return hit;
      },
      4000,
    );
    await sleep(250);
    changedAt = Date.now();
    const put = await api("/v1/config/global/supervision", token, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "{ heartbeatSeconds: 13 }",
    });
    assert(put.status === 200, "config PUT failed");
    await seen;
    const latency = observedAt - changedAt;
    gate("G3", "state change reflects over SSE within 500 ms", latency > 0 && latency < 500, `${latency}ms`);
  }

  // ---------- G4 (part 2): hot reload of an external file edit ----------
  {
    let editAt = 0;
    let seenAt = 0;
    const seen = readSse(
      token,
      {},
      (frames) => {
        if (editAt === 0) return false;
        const hit = frames.some(
          (f) =>
            f.event.type === "config.changed" &&
            f.event.payload.domain === "supervision" &&
            f.event.payload.hotReloaded === true &&
            Date.parse(f.ts) >= editAt - 50,
        );
        if (hit && seenAt === 0) seenAt = Date.now();
        return hit;
      },
      4000,
    );
    await sleep(250);
    editAt = Date.now();
    writeFileSync(join(home, "config", "supervision.json5"), "{ heartbeatSeconds: 19 }");
    await seen;
    const effective = await (await api("/v1/config/effective", token)).json();
    gate(
      "G4b",
      "global file edit hot-reloads a supervision value (observed)",
      seenAt > 0 && effective.config.supervision.heartbeatSeconds === 19,
      `reload observed after ${seenAt - editAt}ms; heartbeatSeconds=19 source=${effective.sources["supervision.heartbeatSeconds"]}`,
    );
  }

  // ---------- G4 (part 3): invalid config → typed path-precise, nothing applied ----------
  {
    const bad = await api("/v1/config/global/supervision", token, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: '{ heartbeatSeconds: "nope", staleMinutes: { build: 40 } }',
    });
    const body = await bad.json();
    const effective = await (await api("/v1/config/effective", token)).json();
    gate(
      "G4c",
      "invalid config rejected: typed, path-precise, nothing partially applied",
      bad.status === 400 &&
        body.error?.code === "CONFIG_INVALID" &&
        body.error?.issues?.some((i) => i.path === "heartbeatSeconds") &&
        effective.config.supervision.staleMinutes.build === 12 &&
        effective.config.supervision.heartbeatSeconds === 19,
      `code=${body.error?.code} issue=${body.error?.issues?.[0]?.path}`,
    );
  }

  // ---------- G4 (part 4): safety-policy confirmation + policy.changed ----------
  {
    const noConfirm = await api("/v1/config/global/policies", token, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "{ scoutReadOnly: false }",
    });
    const confirmed = await api("/v1/config/global/policies", token, {
      method: "PUT",
      headers: { "content-type": "text/plain", "x-agentos-confirm-safety": "true" },
      body: "{ scoutReadOnly: false }",
    });
    const replay = await (await api("/v1/events/replay", token)).json();
    const policyChanged = replay.events.filter((e) => e.event.type === "policy.changed");
    gate(
      "G4d",
      "safety-policy write requires confirmation and emits policy.changed",
      noConfirm.status === 428 &&
        confirmed.status === 200 &&
        policyChanged.length === 1 &&
        policyChanged[0].event.payload.safetyOverride === true,
      `noConfirm=${noConfirm.status} confirmed=${confirmed.status} events=${policyChanged.length}`,
    );
  }

  // ---------- G4 (part 5): project/task layers refused (trust stub) ----------
  {
    const project = await api("/v1/config/project/supervision", token, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "{ heartbeatSeconds: 3 }",
    });
    const body = await project.json();
    gate(
      "G4e",
      "project layer write refused pre-trust-ack (Phase 1 stub)",
      project.status === 400 && body.error?.code === "LAYER_NOT_WRITABLE",
      `code=${body.error?.code}`,
    );
  }

  // ---------- G2: kill -9 → restart → exactly-once + SSE resume ----------
  {
    // Push the store well past 100 events.
    for (let i = 0; i < 110; i += 1) {
      const put = await api("/v1/config/global/supervision", token, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: `{ heartbeatSeconds: ${20 + (i % 10)} }`,
      });
      assert(put.status === 200, `seed PUT ${i} failed`);
    }
    const before = await (await api("/v1/status", token)).json();
    assert(before.events.count > 100, "expected >100 events");
    const lastIdBeforeKill = before.events.lastId;

    // kill -9 the daemon, then corrupt the log tail like a torn write.
    child.kill("SIGKILL");
    await sleep(300);
    const logPath = join(home, "events", "events.ndjson");
    appendFileSync(logPath, '{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","seq":9999,"ts":"torn');

    // restart
    child = startDaemon(home);
    await waitForHealth();
    const after = await (await api("/v1/status", token)).json();

    const quarantined = readdirSync(join(home, "events")).filter((f) =>
      f.startsWith("quarantine-"),
    );
    // SSE resume from the pre-kill cursor: must deliver the post-restart
    // daemon.started with a strictly increasing seq and no duplicates.
    const resumed = await readSse(
      token,
      { "last-event-id": lastIdBeforeKill },
      (frames) => frames.some((f) => f.event.type === "daemon.started"),
      4000,
    );
    const seqs = resumed.map((f) => f.seq);
    const strictlyIncreasing = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
    gate(
      "G2",
      "kill -9 after 100+ events → exactly-once projection + SSE resume; corrupt tail quarantined",
      after.events.count === before.events.count + 1 && // exactly the new daemon.started
        quarantined.length === 1 &&
        resumed.length >= 1 &&
        seqs[0] === before.events.lastSeq + 1 &&
        strictlyIncreasing,
      `before=${before.events.count} after=${after.events.count} quarantined=${quarantined.length} resumedFrom=#${seqs[0]}`,
    );
  }

  // ---------- G5: doctor ----------
  {
    const doctor = spawnSync(
      process.execPath,
      [join(ROOT, "apps", "orchestrator", "dist", "bin", "agentos.js"), "doctor"],
      { encoding: "utf8" },
    );
    const out = doctor.stdout;
    const mentionsAll = ["node", "tmux", "git", "gh", "pi", "uv"].every((t) => out.includes(t));
    gate(
      "G5",
      "doctor verifies tmux/git/gh/node/pi/uv (missing = warnings, exit 0)",
      doctor.status === 0 && mentionsAll,
      `exit=${doctor.status}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates green`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error("gate run aborted:", error);
  exitCode = 1;
} finally {
  child.kill("SIGKILL");
  await sleep(200);
  rmSync(home, { recursive: true, force: true });
}

process.exit(exitCode);
