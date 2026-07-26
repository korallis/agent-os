#!/usr/bin/env node
/**
 * Phase 1 executable gates (master plan §11 "Phase 1" + deferred Phase 0
 * console-shell/daemon-boot/CLI items). Boots a REAL agentosd on a temp
 * AGENTOS_HOME and asserts, over the wire:
 *
 *   G1  loopback-only + 401s (auth enforced, health open)
 *   G1b the Console BFF proxies to the daemon WITHOUT handing the browser the
 *       daemon token (master plan §11 Phase 1 "BFF never leaks the token")
 *   G2  kill -9 after >100 events → exactly-once projection + SSE resume;
 *       corrupt tail quarantined
 *   G3  a state change reflects over SSE within 500 ms
 *   G4  config gates: defaults install; hot-reload observed; task>project>
 *       global>shipped precedence (unit matrix ran in vitest — re-checked
 *       here for global); /v1/config/effective per-key sources; invalid
 *       config → typed path-precise error, nothing applied; safety write
 *       needs confirmation + emits policy.changed; project layer refused
 *       (trust stub)
 *   G5  doctor actually PROBES tmux/git/gh/node/pi/uv — verified against a
 *       fixture PATH (reports what each binary printed) and against an empty
 *       PATH (reports every tool missing, still exit 0)
 *
 * Usage: node tooling/gates/phase-1.mjs
 * Exit 0 = all gates green.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pickPort } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const CLI_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentos.js");
const CONSOLE_DIR = join(ROOT, "apps", "console");
const PORT = Number(process.env.GATE_PORT ?? 4790);
// 3600s: a band no other gate draws from (phase-6 3300–3499, wizard 3200s,
// fidelity 3400s, phase-8 4000/4100), so a leftover server cannot be mistaken
// for this run's Console.
const CONSOLE_PORT = pickPort(3600, 60);
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;

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

/**
 * Boots the REAL Console production server against the same AGENTOS_HOME, so
 * G1b exercises the shipped BFF route handlers rather than a stand-in. The
 * Console is the only thing that ever reads `daemon.token` on the browser's
 * behalf; asserting the property without it running asserts nothing.
 */
function startConsole(home) {
  const next = join(CONSOLE_DIR, "node_modules", ".bin", "next");
  if (!existsSync(join(CONSOLE_DIR, ".next", "BUILD_ID"))) {
    throw new Error("apps/console is not built — run `pnpm run build` before this gate");
  }
  const server = spawn(next, ["start", "-p", String(CONSOLE_PORT), "-H", "127.0.0.1"], {
    cwd: CONSOLE_DIR,
    env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // A stale Console left listening on the drawn port makes `next start` exit
  // with EADDRINUSE while the port still answers — the gate would then quietly
  // grade someone else's server. Record the death so waitForConsole can say so.
  server.stderr.on("data", (chunk) => {
    server.gateStderr = `${server.gateStderr ?? ""}${chunk}`;
  });
  server.on("exit", (code) => {
    server.gateExited = code ?? "signal";
  });
  return server;
}

async function waitForConsole(server, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.gateExited !== undefined) {
      throw new Error(
        `console exited (${server.gateExited}) instead of serving ${CONSOLE}: ` +
          `${(server.gateStderr ?? "").trim().split("\n").slice(-3).join(" / ")}`,
      );
    }
    try {
      const response = await fetch(`${CONSOLE}/fleet`);
      if (response.ok) {
        await response.text();
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("console did not come up");
}

/**
 * `<script src="…">` — built from a string rather than written as a regex
 * literal on purpose. `scripts/verify-gate-cleanup.mjs` blanks quoted regions
 * before looking for this file's top-level `finally`, and its scanner does not
 * know about regex literals: an odd number of `"` inside one desynchronises its
 * quote pairing and blanks the rest of the file, so the verifier reports
 * "no top-level finally" and silently stops checking this gate at all. Inside a
 * single-quoted string the same characters are blanked correctly.
 */
const SCRIPT_SRC = new RegExp('<script[^>]+src="([^"]+)"', "g");

/** Every header of a response, flattened, so a token smuggled in one is caught. */
function headerText(response) {
  return [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n");
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
const cleanups = [home];
let child = startDaemon(home);
let consoleServer = null;
let exitCode = 1;

try {
  await waitForHealth();
  const token = readFileSync(join(home, "daemon.token"), "utf8").trim();

  // Boot the Console now so its (slow) start overlaps the daemon-level gates;
  // G1b awaits readiness once the daemon has finished being killed by G2.
  consoleServer = startConsole(home);

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
    // Every shipped default domain must be materialised into the home — the
    // set grows per phase, so compare against the shipped directory itself
    // rather than a hard-coded count.
    const shipped = readdirSync(join(ROOT, "apps", "orchestrator", "defaults"))
      .filter((f) => f.endsWith(".json5"))
      .sort();
    const domains = readdirSync(join(home, "config"))
      .filter((f) => f.endsWith(".json5"))
      .sort();
    const effective = await (await api("/v1/config/effective", token)).json();
    const missing = shipped.filter((f) => !domains.includes(f));
    gate(
      "G4a",
      "shipped defaults install; /v1/config/effective per-key source layer",
      shipped.length > 0 &&
        missing.length === 0 &&
        domains.length === shipped.length &&
        effective.sources["supervision.heartbeatSeconds"] === "shipped" &&
        effective.config.policies.scoutReadOnly === true,
      `installed=${domains.length}/${shipped.length}${missing.length ? ` missing=[${missing.join(",")}]` : ""}`,
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

    // Exactly-once: the projection holds every durable log line once — no
    // replay duplicates, no dropped survivors. Boot itself appends events
    // (daemon.started plus subsystem readiness), so the invariant is
    // "projection == log, ids unique", not a fixed delta.
    const logLines = readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    const ids = logLines.map((e) => e.id);
    const uniqueIds = new Set(ids);
    const seqsInLog = logLines.map((e) => e.seq);
    const logMonotonic = seqsInLog.every((s, i) => i === 0 || s > seqsInLog[i - 1]);
    const exactlyOnce =
      after.events.count === logLines.length &&
      uniqueIds.size === ids.length &&
      after.events.count > before.events.count &&
      logMonotonic;

    // SSE resume from the pre-kill cursor: must deliver only post-kill events,
    // starting at the next seq, strictly increasing, including daemon.started.
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
      exactlyOnce &&
        quarantined.length === 1 &&
        resumed.length >= 1 &&
        seqs[0] === before.events.lastSeq + 1 &&
        strictlyIncreasing,
      `before=${before.events.count} after=${after.events.count} log=${logLines.length} dupes=${ids.length - uniqueIds.size} quarantined=${quarantined.length} resumedFrom=#${seqs[0]}`,
    );
  }

  // ---------- G1b: the Console BFF proxies without leaking the daemon token ----------
  {
    // The property under test (master plan §11 Phase 1) is about what reaches
    // the BROWSER, so it can only be observed with the Console actually
    // serving: the token lives server-side in `apps/console/src/lib/daemon.ts`
    // and is attached outbound by the `/api/agentos/[...path]` route handler.
    //
    // Checked over plain HTTP rather than Playwright on purpose — CI installs
    // Chromium only before the Phase 6 gates, and everything the browser would
    // receive (document HTML, inline RSC payload, same-origin JS chunks,
    // response headers) is fetchable directly.
    await waitForConsole(consoleServer);

    // 1. The proxy works with NO client-side credential. Paired with G1's
    //    direct-to-daemon 401 above, a 200 here can only mean the BFF attached
    //    the bearer server-side. `daemon.home` must be THIS run's temp home, so
    //    a stranger's Console on the same port cannot answer for ours.
    const proxied = await fetch(`${CONSOLE}/api/agentos/status`);
    const proxiedText = await proxied.text();
    let proxiedBody = null;
    try {
      proxiedBody = JSON.parse(proxiedText);
    } catch {
      proxiedBody = null;
    }
    const proxyWorks =
      proxied.status === 200 &&
      proxiedBody?.daemon?.home === home &&
      typeof proxiedBody?.daemon?.pid === "number" &&
      typeof proxiedBody?.events?.count === "number";

    // 2. Nothing the browser receives may contain the token — not the proxy
    //    response, not the rendered documents, not the JS chunks they load.
    const scanned = [];
    scanned.push({ what: "GET /api/agentos/status", text: `${headerText(proxied)}\n${proxiedText}` });

    // EVERY route the build marks `ƒ` (server-rendered on demand) is scanned —
    // those are the only documents that can carry THIS run's token, since the
    // `○` pages were prerendered before this daemon existed. Keep this list in
    // step with the build's route table: a dynamic page left out is a document
    // that could leak with the gate still green. Static pages are included too,
    // cheaply, so a page flipping static→dynamic is covered the day it flips.
    const DYNAMIC_PAGES = [
      "/tasks/gate-p1-no-such-task",
      "/sessions/gate-p1-no-such-session",
      "/network/gate-p1-no-such-record",
    ];
    let chunkCount = 0;
    const badPages = [];
    for (const path of [...DYNAMIC_PAGES, "/fleet", "/policies", "/settings"]) {
      const page = await fetch(`${CONSOLE}${path}`);
      const html = await page.text();
      // A 500 returns an error document, which is trivially token-free — count
      // it as a scanned surface and the gate grades a page it never rendered.
      if (!page.ok || !html.includes("</html>")) badPages.push(`${path}=${page.status}`);
      scanned.push({ what: `GET ${path}`, text: `${headerText(page)}\n${html}` });
      // Follow the scripts the document tells the browser to load.
      const sources = [...html.matchAll(SCRIPT_SRC)].map((m) => m[1]);
      for (const source of new Set(sources)) {
        if (source.startsWith("http") && !source.startsWith(CONSOLE)) continue;
        const chunk = await fetch(new URL(source, CONSOLE));
        if (!chunk.ok) continue;
        chunkCount += 1;
        scanned.push({ what: `GET ${source}`, text: await chunk.text() });
      }
    }

    const leaks = scanned.filter((s) => s.text.includes(token)).map((s) => s.what);
    // Guard the guard, twice over. "No leak found" is worthless if nothing was
    // fetched, and equally worthless if the search itself is broken — so the
    // same includes()-over-collected-text pipeline must positively FIND a
    // needle that is genuinely present in what came back. The needle is a
    // closing document tag rather than anything daemon-derived, so the control
    // still speaks when the proxy itself is the thing that broke: if it ever
    // comes up empty, `scanned` is holding empty bodies and "leaks=none" means
    // "searched nothing", which must not read as green.
    const controlFound = scanned.some((s) => s.text.includes("</html>"));
    const scanIsReal =
      scanned.length >= 5 &&
      chunkCount >= 1 &&
      token.length >= 16 &&
      badPages.length === 0 &&
      controlFound;

    gate(
      "G1b",
      "Console BFF reaches the daemon with the browser-held credential absent, and the daemon token appears in nothing the browser receives",
      proxyWorks && scanIsReal && leaks.length === 0,
      `proxy=${proxied.status} scanned=${scanned.length} chunks=${chunkCount} control=${controlFound ? "found" : "MISSING"}${badPages.length ? ` badPages=[${badPages.join(",")}]` : ""} leaks=${leaks.length ? leaks.join(",") : "none"}`,
    );
  }

  // ---------- G5: doctor ----------
  {
    // A substring scan of doctor's output cannot tell a real preflight from a
    // program that prints six tool names, so the tools are staged instead:
    //
    //   run A — a PATH holding nothing but stub binaries that each print a
    //           nonce unique to this run. Doctor can only report those strings
    //           if it EXECUTED each binary and captured its stdout.
    //   run B — a PATH holding nothing at all. Every tool must be reported
    //           missing, with no version, and the exit code must stay 0
    //           (missing tools are warnings, master plan §11 Phase 1).
    const TOOLS = ["node", "tmux", "git", "gh", "pi", "uv"];
    const nonce = `gatefake-${process.pid}-${Date.now().toString(36)}`;
    const shimDir = mkdtempSync(join(tmpdir(), "agentos-doctor-shim-"));
    const emptyDir = mkdtempSync(join(tmpdir(), "agentos-doctor-empty-"));
    cleanups.push(shimDir, emptyDir);
    mkdirSync(shimDir, { recursive: true });
    for (const tool of TOOLS) {
      writeFileSync(join(shimDir, tool), `#!/bin/sh\necho "${nonce}-${tool}"\n`, { mode: 0o755 });
    }

    /** `  node   ✓          v24.0.0                      runtime (…)` */
    const parseRows = (stdout) => {
      const rows = new Map();
      for (const line of (stdout ?? "").split("\n")) {
        const match = /^ {2}(\S+)\s+(✓|⚠ missing)\s+(.*)$/u.exec(line);
        if (match) rows.set(match[1], { ok: match[2] === "✓", rest: match[3].trim() });
      }
      return rows;
    };
    const runDoctor = (path) =>
      spawnSync(process.execPath, [CLI_BIN, "doctor"], {
        encoding: "utf8",
        env: { ...process.env, PATH: path },
      });

    const stubbed = runDoctor(shimDir);
    const stubbedRows = parseRows(stubbed.stdout);
    const notProbed = TOOLS.filter((tool) => {
      const row = stubbedRows.get(tool);
      return row === undefined || !row.ok || !row.rest.startsWith(`${nonce}-${tool}`);
    });

    const bare = runDoctor(emptyDir);
    const bareRows = parseRows(bare.stdout);
    const notWarned = TOOLS.filter((tool) => {
      const row = bareRows.get(tool);
      return row === undefined || row.ok || !row.rest.startsWith("—");
    });

    gate(
      "G5",
      "doctor executes tmux/git/gh/node/pi/uv and reports what each printed; all-absent = warnings, exit 0",
      stubbed.status === 0 &&
        notProbed.length === 0 &&
        stubbed.stdout.includes("all tools present.") &&
        bare.status === 0 &&
        notWarned.length === 0 &&
        bare.stdout.includes(`${TOOLS.length} tool(s) missing`),
      `stubbed=exit${stubbed.status}${notProbed.length ? ` unprobed=[${notProbed.join(",")}]` : " all6-probed"} absent=exit${bare.status}${notWarned.length ? ` unwarned=[${notWarned.join(",")}]` : " all6-warned"}`,
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
  try {
    consoleServer?.kill("SIGTERM");
  } catch {
    // already gone
  }
  await sleep(300);
  try {
    consoleServer?.kill("SIGKILL");
  } catch {
    // already gone
  }
  for (const path of cleanups) {
    rmSync(path, { recursive: true, force: true });
  }
}

process.exit(exitCode);
