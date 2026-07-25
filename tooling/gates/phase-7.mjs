#!/usr/bin/env node
/**
 * Phase 7 executable gates (master plan §11 Phase 7) — secondmates.
 *
 *   G1  isolated homes: no auth material under secondmate homes (fs scan), including
 *       while a live secondmate is running (token lives outside the audited tree)
 *   G2  double-start blocked on the SECONDMATE home (not only the primary)
 *   G3  charter config drives the LIVE secondmate Brain model (edit → observed)
 *   G4  broker serialises across PROCESSES, and production PiAuthBroker holds it
 *   G5  routing hands the task over — present on secondmate, released on primary
 *   G6  /bearings answers within 5 s; tool returns real results; unreachable is fact
 *   G7  dual-restart reconcile produces no duplicate secondmate records
 *   G8  provision through REST (not out-of-band modules); start waits for ready
 *   G9  maxConcurrentTasks is enforced on the routing path
 *   G10 secondmate api-key grants resolve from primary secrets without copying
 *   G11 primary bound port blocks secondmate provision without AGENTOS_PORT
 *   G12 secondmate own tmux server; primary Brain survives secondmate start
 *   G13 concurrent stop+start leaves exactly one live process matching registry
 *
 * Real daemons on real homes; only the model is simulated.
 * Usage: node tooling/gates/phase-7.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p7-${process.pid}`;
const PORT = 4700 + 900 + Math.floor(Math.random() * 80);
const SM_PORT = PORT + 10;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon(home, port, extraEnv = {}) {
  return spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(port),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      AGENTOS_FAKE_GIT: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(home, port, timeoutMs = 20000, tokenPath = null) {
  const deadline = Date.now() + timeoutMs;
  const path = tokenPath ?? join(home, "daemon.token");
  while (Date.now() < deadline) {
    try {
      if (!existsSync(path)) {
        await sleep(100);
        continue;
      }
      const token = readFileSync(path, "utf8").trim();
      const res = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok && (await res.json()).daemon?.home === home) return token;
    } catch {
      // not up
    }
    await sleep(100);
  }
  throw new Error(`daemon did not come up on ${port}`);
}

/** Recursively collect every file under a root (for the auth-material scan). */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const cleanups = [];
let child;
let smChild;

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p7-home-"));
  cleanups.push(home);
  child = startDaemon(home, PORT);
  const token = await waitForHealth(home, PORT);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const api = (path, init = {}) =>
    fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });

  // G8 — provision through the shipped REST surface (not node -e against dist).
  const provisionInfra = await api("/v1/secondmates", {
    method: "POST",
    body: JSON.stringify({
      name: "infra",
      domain: "infra",
      port: SM_PORT,
      brainModel: "openai/gpt-4.1",
      maxConcurrentTasks: 1,
    }),
  });
  const provisionDocs = await api("/v1/secondmates", {
    method: "POST",
    body: JSON.stringify({
      name: "docs",
      domain: "docs",
      port: SM_PORT + 1,
      brainModel: "openai/gpt-4.1",
    }),
  });
  const provisionedOk = provisionInfra.ok && provisionDocs.ok;

  // Start the infra secondmate via the primary's REST lifecycle API.
  // start() must not return until the secondmate is healthy.
  const startRes = await api("/v1/secondmates/infra/start", {
    method: "POST",
    body: "{}",
  });
  const startBody = startRes.ok ? await startRes.json() : await startRes.json().catch(() => ({}));
  const smTokenPath =
    startBody.runtime?.tokenPath ?? join(home, "runtime", "secondmates", "infra", "daemon.token");
  const smHome = join(home, "secondmates", "infra");
  let smToken = null;
  if (startRes.ok && existsSync(smTokenPath)) {
    smToken = readFileSync(smTokenPath, "utf8").trim();
    // Confirm /v1/status already answers (start waited for ready).
    try {
      const st = await fetch(`http://127.0.0.1:${SM_PORT}/v1/status`, {
        headers: { authorization: `Bearer ${smToken}` },
      });
      if (!st.ok) smToken = null;
    } catch {
      smToken = null;
    }
  }

  gate(
    "G8",
    "provision via REST; start returns only when secondmate is ready",
    provisionedOk && startRes.ok && smToken !== null && startBody.runtime?.pid > 0,
    `provisionOk=${provisionedOk} start=${startRes.status} readyToken=${smToken !== null}`,
  );

  // G12 — isolation: secondmate gets its own tmux server; starting it must not
  // kill the primary Brain (shared socket would share agentos:brain).
  {
    const smTmuxSocket = "agentos-infra";
    const primaryList = spawnSync(
      "tmux",
      ["-L", TMUX_SOCKET, "list-windows", "-t", "agentos", "-F", "#{window_name}"],
      { encoding: "utf8" },
    );
    const smList = spawnSync(
      "tmux",
      ["-L", smTmuxSocket, "list-windows", "-t", "agentos", "-F", "#{window_name}"],
      { encoding: "utf8" },
    );
    const primaryWindows = (primaryList.stdout ?? "").trim().split("\n").filter(Boolean);
    const smWindows = (smList.stdout ?? "").trim().split("\n").filter(Boolean);
    const primaryBrainAlive =
      primaryList.status === 0 && primaryWindows.includes("brain");
    const smBrainAlive = smList.status === 0 && smWindows.includes("brain");
    // Different servers: the secondmate socket must not be the primary socket,
    // and each server must own its brain window independently.
    const isolated =
      smTmuxSocket !== TMUX_SOCKET &&
      primaryBrainAlive &&
      smBrainAlive &&
      startRes.ok;
    gate(
      "G12",
      "secondmate own tmux server; primary Brain survives secondmate start",
      isolated,
      `primarySocket=${TMUX_SOCKET} smSocket=${smTmuxSocket} primaryBrain=${primaryBrainAlive} smBrain=${smBrainAlive} primaryWins=${primaryWindows.join(",")} smWins=${smWindows.join(",")}`,
    );
  }

  // G1 — no auth material under any secondmate home (while live)
  {
    const smRoot = join(home, "secondmates");
    const files = walk(smRoot);
    const banned = files.filter((f) =>
      /auth\.json$|daemon\.token$|\/secrets\/|credentials|\.key$/.test(f),
    );
    const auditRes = await api("/v1/secondmates/audit");
    const audit = auditRes.ok ? await auditRes.json() : { ok: false };
    gate(
      "G1",
      "live secondmate homes carry no auth material (fs scan + audit)",
      provisionedOk &&
        files.length > 0 &&
        banned.length === 0 &&
        audit.ok === true &&
        smToken !== null &&
        existsSync(smTokenPath) &&
        !smTokenPath.startsWith(smRoot + "/") &&
        !smTokenPath.startsWith(smRoot + "\\"),
      `files=${files.length} offenders=${banned.length} auditOk=${audit.ok} liveTokenOutside=${existsSync(smTokenPath)}`,
    );
  }

  // G2 — double-start on the SECONDMATE home is refused
  {
    const second = startDaemon(smHome, SM_PORT + 50, {
      AGENTOS_TOKEN_PATH: join(home, "runtime", "secondmates", "infra-dup", "daemon.token"),
      AGENTOS_PI_HOME: join(home, "pi"),
    });
    let stderr = "";
    second.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const exitCode = await new Promise((resolve) => {
      second.on("exit", (code) => resolve(code));
      setTimeout(() => {
        try {
          second.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve(null);
      }, 8000);
    });
    gate(
      "G2",
      "a second daemon on the SECONDMATE home is refused (home lock)",
      exitCode !== 0 && /already in use|lock/i.test(stderr),
      `exit=${exitCode} lockError=${/already in use|lock/i.test(stderr)}`,
    );
  }

  // G4 — the broker serialises across PROCESSES; PiAuthBroker is the choke point
  {
    const lockDir = join(home, "pi", "agent");
    mkdirSync(lockDir, { recursive: true });
    const brokerPath = join(ROOT, "apps/orchestrator/dist/pi/cross-process-broker.js");
    const authBrokerPath = join(ROOT, "apps/orchestrator/dist/pi/auth-broker.js");
    const holdScript = `
      import { CrossProcessAuthBroker } from '${brokerPath}';
      const b = new CrossProcessAuthBroker(${JSON.stringify(lockDir)});
      if (!b.tryAcquire('hold')) process.exit(3);
      process.stdout.write('held');
      setTimeout(() => { b.release(); process.exit(0); }, 2500);
    `;
    const holder = spawn(process.execPath, ["--input-type=module", "-e", holdScript], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve) => holder.stdout.once("data", resolve));

    const contendScript = `
      import { CrossProcessAuthBroker } from '${brokerPath}';
      const b = new CrossProcessAuthBroker(${JSON.stringify(lockDir)});
      process.stdout.write(b.tryAcquire('contend') ? 'acquired' : 'blocked');
    `;
    const contender = spawnSync(process.execPath, ["--input-type=module", "-e", contendScript], {
      encoding: "utf8",
    });
    const blockedWhileHeld = contender.stdout.trim() === "blocked";

    // Production choke point: async withSpawnGrant must block while held, then
    // proceed after release — not only tryAcquire (which ignores wait/timeout).
    const chokeWhileHeldScript = `
      import { PiAuthBroker } from '${authBrokerPath}';
      const b = PiAuthBroker.forManagedHome(${JSON.stringify(join(home, "pi"))});
      const p = b.withSpawnGrant(async () => { process.stdout.write('acquired'); });
      const t = setTimeout(() => { process.stdout.write('blocked'); process.exit(0); }, 400);
      try {
        await p;
      } catch (e) {
        process.stdout.write(e && e.code === 'AUTH_BROKER_TIMEOUT' ? 'blocked' : 'error');
      } finally {
        clearTimeout(t);
      }
    `;
    const chokeWhileHeld = spawn(process.execPath, ["--input-type=module", "-e", chokeWhileHeldScript], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chokeWhileHeldOut = await new Promise((resolve) => {
      let buf = "";
      const done = () => resolve(buf.trim());
      chokeWhileHeld.stdout.on("data", (chunk) => {
        buf += String(chunk);
        if (buf.includes("blocked") || buf.includes("acquired") || buf.includes("error")) done();
      });
      chokeWhileHeld.on("exit", done);
      setTimeout(done, 3000);
    });
    const chokeBlocked =
      chokeWhileHeldOut.includes("blocked") && !chokeWhileHeldOut.includes("acquired");
    try {
      chokeWhileHeld.kill("SIGKILL");
    } catch {
      // ignore
    }

    // Immediate tryAcquire through a second PiAuthBroker must also fail while held.
    const chokeImmediate = `
      import { PiAuthBroker } from '${authBrokerPath}';
      const b = PiAuthBroker.forManagedHome(${JSON.stringify(join(home, "pi"))});
      process.stdout.write(b.crossProcessBroker.tryAcquire('choke') ? 'acquired' : 'blocked');
    `;
    const chokeImm = spawnSync(process.execPath, ["--input-type=module", "-e", chokeImmediate], {
      encoding: "utf8",
    });
    const chokeImmBlocked = chokeImm.stdout.trim() === "blocked";

    await new Promise((resolve) => holder.on("exit", resolve));
    const after = spawnSync(process.execPath, ["--input-type=module", "-e", contendScript], {
      encoding: "utf8",
    });
    const freeAfterRelease = after.stdout.trim() === "acquired";

    // After release, withSpawnGrant must actually proceed (not only tryAcquire).
    const chokeAfterScript = `
      import { PiAuthBroker } from '${authBrokerPath}';
      const b = PiAuthBroker.forManagedHome(${JSON.stringify(join(home, "pi"))});
      await b.withSpawnGrant(async () => { process.stdout.write('acquired'); });
    `;
    const chokeAfter = spawnSync(process.execPath, ["--input-type=module", "-e", chokeAfterScript], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const chokeProceedsAfterRelease = chokeAfter.stdout.trim() === "acquired";

    // Corrupt lock must not be releasable by a non-holder (unreadable → refuse).
    const corruptScript = `
      import { writeFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { CrossProcessAuthBroker } from '${brokerPath}';
      const dir = ${JSON.stringify(lockDir)};
      const lockPath = join(dir, 'auth-broker.lock');
      writeFileSync(lockPath, 'not-json');
      const b = new CrossProcessAuthBroker(dir);
      b.release();
      process.stdout.write(existsSync(lockPath) ? 'kept' : 'removed');
    `;
    const corrupt = spawnSync(process.execPath, ["--input-type=module", "-e", corruptScript], {
      encoding: "utf8",
    });
    const corruptKept = corrupt.stdout.trim() === "kept";
    try {
      rmSync(join(lockDir, "auth-broker.lock"), { force: true });
    } catch {
      // ignore
    }

    gate(
      "G4",
      "auth broker serialises across processes via PiAuthBroker choke point",
      blockedWhileHeld &&
        freeAfterRelease &&
        chokeBlocked &&
        chokeImmBlocked &&
        chokeProceedsAfterRelease &&
        corruptKept,
      `blockedWhileHeld=${blockedWhileHeld} freeAfterRelease=${freeAfterRelease} chokeBlocked=${chokeBlocked} chokeImmBlocked=${chokeImmBlocked} chokeProceedsAfterRelease=${chokeProceedsAfterRelease} corruptKept=${corruptKept}`,
    );
  }

  // G3 — charter edit changes the LIVE secondmate Brain model
  {
    let modelBefore = null;
    let modelAfter = null;
    let routeOk = false;
    if (smToken) {
      try {
        const before = await fetch(`http://127.0.0.1:${SM_PORT}/v1/brain`, {
          headers: { authorization: `Bearer ${smToken}` },
        });
        if (before.ok) {
          const body = await before.json();
          modelBefore = body.brain?.model ?? null;
        }
      } catch {
        modelBefore = null;
      }
    }
    const charterRes = await api("/v1/secondmates/infra/charter", {
      method: "PUT",
      body: JSON.stringify({
        domains: ["infra", "deploy"],
        brainModel: "openai/gpt-5.6-sol",
        maxConcurrentTasks: 1,
        acceptsRouting: true,
      }),
    });
    const charterBody = charterRes.ok ? await charterRes.json() : {};
    // Allow brain restart to settle.
    await sleep(800);
    if (smToken) {
      try {
        const after = await fetch(`http://127.0.0.1:${SM_PORT}/v1/brain`, {
          headers: { authorization: `Bearer ${smToken}` },
        });
        if (after.ok) {
          const body = await after.json();
          modelAfter = body.brain?.model ?? null;
        }
      } catch {
        modelAfter = null;
      }
    }
    // Routing domain also updated.
    const listRes = await api("/v1/secondmates");
    const list = listRes.ok ? await listRes.json() : { secondmates: [] };
    routeOk =
      charterRes.ok &&
      (charterBody.brainSynced === true || modelAfter === "openai/gpt-5.6-sol") &&
      (list.secondmates ?? []).some((s) => s.name === "infra");
    gate(
      "G3",
      "charter edit changes the LIVE secondmate Brain model",
      modelAfter === "openai/gpt-5.6-sol" &&
        modelBefore !== "openai/gpt-5.6-sol" &&
        routeOk,
      `before=${modelBefore} after=${modelAfter} charterOk=${charterRes.ok} brainSynced=${charterBody.brainSynced}`,
    );
  }

  // G6 — bearings (REST + tool) answer quickly; live secondmate reachable
  {
    const started = Date.now();
    const res = await api("/v1/secondmates/bearings");
    const elapsed = Date.now() - started;
    const body = res.ok ? await res.json() : { bearings: [] };
    const infra = (body.bearings ?? []).find((b) => b.name === "infra");
    const toolRes = await api("/v1/tools/call", {
      method: "POST",
      body: JSON.stringify({
        tool: "read_secondmate_bearings",
        input: { name: "infra" },
      }),
    });
    const toolBody = toolRes.ok ? await toolRes.json() : {};
    const toolBearings = toolBody.data?.bearings ?? [];
    const toolInfra = toolBearings.find((b) => b.name === "infra");
    gate(
      "G6",
      "/bearings + read_secondmate_bearings return live results within 5 s",
      res.ok &&
        elapsed <= 5000 &&
        infra !== undefined &&
        infra.reachable === true &&
        toolBody.ok === true &&
        toolInfra?.reachable === true &&
        toolBody.data?.pending !== true,
      `elapsed=${elapsed}ms restReachable=${infra?.reachable} toolReachable=${toolInfra?.reachable} toolOk=${toolBody.ok}`,
    );
  }

  // G5 — routing hands the task over (exists on secondmate, released on primary)
  // G9 — maxConcurrentTasks enforced (infra capped at 1)
  {
    const repo = mkdtempSync(join(tmpdir(), "agentos-p7-repo-"));
    cleanups.push(repo);
    writeFileSync(join(repo, "README.md"), "# p7\n");
    const project = await (
      await api("/v1/projects", {
        method: "POST",
        body: JSON.stringify({ name: "p7", path: repo, mode: "local-only", trusted: true }),
      })
    ).json();
    const task = await (
      await api("/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          spec: {
            shape: "SHIP",
            title: "Routed away",
            intent: "belongs to infra",
            projectId: project.project.id,
            mode: "local-only",
            yolo: true,
          },
        }),
      })
    ).json();
    const badDomain = await (
      await api("/v1/tools/call", {
        method: "POST",
        body: JSON.stringify({
          tool: "route_to_secondmate",
          input: { name: "infra", taskId: task.task.id, domain: "kernel" },
        }),
      })
    ).json();
    const stillThere = await (await api(`/v1/tasks/${task.task.id}`)).json();
    const routed = await (
      await api("/v1/tools/call", {
        method: "POST",
        body: JSON.stringify({
          tool: "route_to_secondmate",
          input: { name: "infra", taskId: task.task.id, domain: "infra" },
        }),
      })
    ).json();
    const after = await (await api(`/v1/tasks/${task.task.id}`)).json();
    let remotePresent = false;
    let remotePhase = null;
    if (routed.ok && routed.data?.remoteTaskId && smToken) {
      try {
        const remote = await fetch(
          `http://127.0.0.1:${SM_PORT}/v1/tasks/${routed.data.remoteTaskId}`,
          { headers: { authorization: `Bearer ${smToken}` } },
        );
        if (remote.ok) {
          const remoteBody = await remote.json();
          remotePresent = remoteBody.task?.id === routed.data.remoteTaskId;
          remotePhase = remoteBody.task?.phase ?? null;
        }
      } catch {
        remotePresent = false;
      }
    }
    gate(
      "G5",
      "routing hands the task over once — present on secondmate, released on primary",
      badDomain.ok === false &&
        stillThere.task?.phase !== "CANCELLED" &&
        routed.ok === true &&
        routed.data?.accepted === true &&
        typeof routed.data?.remoteTaskId === "string" &&
        after.task?.phase === "CANCELLED" &&
        remotePresent === true,
      `domainRefuse=${badDomain.ok === false} keptOnFail=${stillThere.task?.phase} accepted=${routed.data?.accepted} remote=${routed.data?.remoteTaskId} primaryPhase=${after.task?.phase} remotePresent=${remotePresent} remotePhase=${remotePhase}`,
    );

    // G9 — second route while at capacity (maxConcurrentTasks: 1) must refuse
    const task2 = await (
      await api("/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          spec: {
            shape: "SHIP",
            title: "Second route",
            intent: "should hit capacity",
            projectId: project.project.id,
            mode: "local-only",
            yolo: true,
          },
        }),
      })
    ).json();
    const capacity = await (
      await api("/v1/tools/call", {
        method: "POST",
        body: JSON.stringify({
          tool: "route_to_secondmate",
          input: { name: "infra", taskId: task2.task.id, domain: "infra" },
        }),
      })
    ).json();
    const task2After = await (await api(`/v1/tasks/${task2.task.id}`)).json();
    const capacityRefused =
      capacity.ok === false &&
      /capacity|concurrent/i.test(capacity.error?.message ?? "") &&
      task2After.task?.phase !== "CANCELLED";
    gate(
      "G9",
      "maxConcurrentTasks refuses routing when secondmate is at capacity",
      capacityRefused,
      `ok=${capacity.ok} msg=${capacity.error?.message ?? ""} phase=${task2After.task?.phase}`,
    );
  }

  // G10 — api-key grant on live secondmate from primary secrets; home stays clean
  {
    const secretValue = `sk-p7-grant-${process.pid}`;
    const primaryKeyRes = await api("/v1/connections/api-key", {
      method: "POST",
      body: JSON.stringify({ provider: "openai", apiKey: secretValue }),
    });
    // Register connection metadata on the secondmate; writeApiKeyFile must land
    // under AGENTOS_SECRETS_HOME (primary), never under the secondmate home.
    let smKeyOk = false;
    if (smToken !== null) {
      const smKeyRes = await fetch(`http://127.0.0.1:${SM_PORT}/v1/connections/api-key`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${smToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "openai", apiKey: secretValue }),
      });
      smKeyOk = smKeyRes.ok;
    }
    const connectionsPath = join(ROOT, "apps/orchestrator/dist/pi/connections.js");
    const grantScript = `
      import { ConnectionRegistry, resolveProviderKeyGrant } from ${JSON.stringify(connectionsPath)};
      process.env.AGENTOS_SECRETS_HOME = ${JSON.stringify(home)};
      const smHome = ${JSON.stringify(smHome)};
      const reg = new ConnectionRegistry(smHome);
      const grant = resolveProviderKeyGrant(smHome, "openai/gpt-4.1", reg);
      if (!grant || grant.name !== "OPENAI_API_KEY" || grant.value !== ${JSON.stringify(secretValue)}) {
        process.stdout.write("miss:" + JSON.stringify(grant && { name: grant.name, len: grant.value?.length }));
        process.exit(1);
      }
      process.stdout.write("granted");
    `;
    const grantRun = spawnSync(process.execPath, ["--input-type=module", "-e", grantScript], {
      encoding: "utf8",
      env: { ...process.env, AGENTOS_SECRETS_HOME: home },
    });
    const grantOk = grantRun.status === 0 && grantRun.stdout.trim() === "granted";
    const smRoot = join(home, "secondmates");
    const files = walk(smRoot);
    const banned = files.filter((f) =>
      /auth\.json$|daemon\.token$|\/secrets\/|credentials|\.key$/.test(f),
    );
    const auditRes = await api("/v1/secondmates/audit");
    const audit = auditRes.ok ? await auditRes.json() : { ok: false };
    const primarySecretExists = existsSync(join(home, "secrets", "openai.key"));
    gate(
      "G10",
      "secondmate api-key grant from primary secrets; home stays auth-clean",
      primaryKeyRes.ok &&
        smKeyOk &&
        grantOk &&
        primarySecretExists &&
        banned.length === 0 &&
        audit.ok === true &&
        smToken !== null,
      `primaryKey=${primaryKeyRes.status} smKey=${smKeyOk} grant=${grantRun.stdout.trim() || grantRun.stderr.trim()} banned=${banned.length} audit=${audit.ok} primarySecret=${primarySecretExists}`,
    );
  }

  // G13 — concurrent stop+start: registry tracks exactly one live process
  {
    const runtimePath = join(home, "runtime", "secondmates", "infra", "runtime.json");
    const beforePid = existsSync(runtimePath)
      ? JSON.parse(readFileSync(runtimePath, "utf8")).pid
      : null;
    const stopP = api("/v1/secondmates/infra/stop", { method: "POST", body: "{}" });
    const startP = api("/v1/secondmates/infra/start", { method: "POST", body: "{}" });
    const [stopRes, startRes2] = await Promise.all([stopP, startP]);
    let startBody2 = startRes2.ok ? await startRes2.json().catch(() => ({})) : {};
    // Either order is valid on the serial chain: stop→start ends running;
    // start→stop may end stopped. Ensure a final start so we assert one live.
    if (!startRes2.ok || !(startBody2.runtime?.pid > 0)) {
      const retry = await api("/v1/secondmates/infra/start", { method: "POST", body: "{}" });
      startBody2 = retry.ok ? await retry.json().catch(() => ({})) : {};
    }
    const runtime = existsSync(runtimePath)
      ? JSON.parse(readFileSync(runtimePath, "utf8"))
      : null;
    const registryPid = runtime?.pid ?? null;
    let registryAlive = false;
    if (typeof registryPid === "number" && registryPid > 0) {
      try {
        process.kill(registryPid, 0);
        registryAlive = true;
      } catch {
        registryAlive = false;
      }
    }
    let beforeAlive = false;
    if (typeof beforePid === "number" && beforePid > 0 && beforePid !== registryPid) {
      try {
        process.kill(beforePid, 0);
        beforeAlive = true;
      } catch {
        beforeAlive = false;
      }
    }
    // Refresh token after possible restart (token path is stable under runtime/).
    const g13TokenPath =
      startBody2.runtime?.tokenPath ??
      join(home, "runtime", "secondmates", "infra", "daemon.token");
    if (existsSync(g13TokenPath)) {
      smToken = readFileSync(g13TokenPath, "utf8").trim();
    }
    let statusOk = false;
    if (registryAlive && smToken) {
      try {
        const st = await fetch(`http://127.0.0.1:${SM_PORT}/v1/status`, {
          headers: { authorization: `Bearer ${smToken}` },
        });
        if (st.ok) {
          const stBody = await st.json();
          statusOk = stBody.daemon?.home === smHome;
        }
      } catch {
        statusOk = false;
      }
    }
    const oneLiveMatching =
      registryPid !== null &&
      registryAlive &&
      registryPid === startBody2.runtime?.pid &&
      !beforeAlive &&
      statusOk &&
      stopRes.status < 500;
    gate(
      "G13",
      "concurrent stop+start leaves exactly one live process matching registry",
      oneLiveMatching,
      `beforePid=${beforePid} registryPid=${registryPid} startPid=${startBody2.runtime?.pid} beforeAlive=${beforeAlive} registryAlive=${registryAlive} statusOk=${statusOk} stop=${stopRes.status} start=${startRes2.status}`,
    );
  }

  // G7 — dual restart produces no duplicate secondmate records
  {
    try {
      await api("/v1/secondmates/infra/stop", { method: "POST" });
    } catch {
      // ignore
    }
    child.kill("SIGKILL");
    await sleep(400);
    child = startDaemon(home, PORT);
    const token2 = await waitForHealth(home, PORT);
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/secondmates`, {
      headers: { authorization: `Bearer ${token2}` },
    });
    const body = res.ok ? await res.json() : { secondmates: [] };
    const names = (body.secondmates ?? []).map((s) => s.name).sort();
    const unique = [...new Set(names)];
    gate(
      "G7",
      "dual restart reconciles without duplicate secondmate records",
      res.ok && names.length === unique.length && unique.join(",") === "docs,infra",
      `names=${names.join(",")} unique=${unique.length}`,
    );
  }

  // G11 — production path wires the bound port into SecondmateRegistry.
  // Start without AGENTOS_PORT so resolvePrimaryPortFromEnv cannot supply the
  // value; only setPrimaryPort(boundPort) after listen can refuse the clash.
  {
    try {
      child?.kill("SIGKILL");
    } catch {
      // ignore
    }
    await sleep(300);
    const boundHome = mkdtempSync(join(tmpdir(), "agentos-p7-bound-"));
    cleanups.push(boundHome);
    const boundEnv = { ...process.env };
    delete boundEnv.AGENTOS_PORT;
    // Default bind (no AGENTOS_PORT) is DEFAULT_PORT 4700 — the production path
    // the unit tests with explicit primaryPort never exercise.
    const defaultPort = 4700;
    child = spawn(process.execPath, [DAEMON_BIN], {
      env: {
        ...boundEnv,
        AGENTOS_HOME: boundHome,
        AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
        AGENTOS_FAKE_PI: "1",
        AGENTOS_FAKE_BRAIN: "1",
        AGENTOS_FAKE_GATE: "1",
        AGENTOS_FAKE_GIT: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let boundOk = false;
    let boundDetail = "daemon did not start";
    try {
      const boundToken = await waitForHealth(boundHome, defaultPort, 20000);
      const statusRes = await fetch(`http://127.0.0.1:${defaultPort}/v1/status`, {
        headers: { authorization: `Bearer ${boundToken}` },
      });
      const statusBody = statusRes.ok ? await statusRes.json() : {};
      const reportedPort = statusBody.daemon?.port;
      const clashRes = await fetch(`http://127.0.0.1:${defaultPort}/v1/secondmates`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${boundToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "clash",
          domain: "x",
          port: reportedPort ?? defaultPort,
        }),
      });
      const clashBody = await clashRes.json().catch(() => ({}));
      const msg = clashBody.error?.message ?? JSON.stringify(clashBody);
      boundOk =
        clashRes.status === 400 &&
        /collides with the primary/i.test(msg) &&
        reportedPort === defaultPort;
      boundDetail = `status=${clashRes.status} port=${reportedPort} msg=${msg}`;
    } catch (error) {
      boundDetail = error instanceof Error ? error.message : String(error);
    }
    gate(
      "G11",
      "bound primary port refuses secondmate provision without AGENTOS_PORT",
      boundOk,
      boundDetail,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  try {
    child?.kill("SIGTERM");
  } catch {
    // ignore
  }
  try {
    smChild?.kill("SIGTERM");
  } catch {
    // ignore
  }
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  spawnSync("tmux", ["-L", "agentos-infra", "kill-server"], { encoding: "utf8" });
  spawnSync("tmux", ["-L", "agentos-docs", "kill-server"], { encoding: "utf8" });
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
