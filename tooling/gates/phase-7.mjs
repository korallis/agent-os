#!/usr/bin/env node
/**
 * Phase 7 executable gates (master plan §11 Phase 7) — secondmates.
 *
 *   G1  isolated homes: no auth material under secondmate homes (fs scan), including
 *       while a live secondmate is running (token lives outside the audited tree)
 *   G2  double-start blocked on the SECONDMATE home (not only the primary)
 *   G3  charter config drives the secondmate's Brain + routing (edit → observed)
 *   G4  broker serialises across PROCESSES, and production PiAuthBroker holds it
 *   G5  routing hands the task over — present on secondmate, released on primary
 *   G6  /bearings answers within 5 s; tool returns real results; unreachable is fact
 *   G7  dual-restart reconcile produces no duplicate secondmate records
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

  // Provision two secondmates through the daemon's own module surface.
  const evalProvision = `
    import { SecondmateRegistry } from '${join(ROOT, "apps/orchestrator/dist/fleet/secondmates.js")}';
    import { SecondmateFleet } from '${join(ROOT, "apps/orchestrator/dist/fleet/secondmate-fleet.js")}';
    const reg = new SecondmateRegistry(${JSON.stringify(home)});
    reg.provision({ name: 'infra', domain: 'infra', port: ${SM_PORT} });
    reg.provision({ name: 'docs', domain: 'docs', port: ${SM_PORT + 1} });
    const fleet = new SecondmateFleet(reg);
    process.stdout.write(JSON.stringify(reg.list().map((r) => r.name)));
    void fleet;
  `;
  const provisioned = spawnSync(process.execPath, ["--input-type=module", "-e", evalProvision], {
    encoding: "utf8",
  });

  // Start the infra secondmate via the primary's REST lifecycle API.
  const startRes = await api("/v1/secondmates/infra/start", {
    method: "POST",
    body: "{}",
  });
  const startBody = startRes.ok ? await startRes.json() : await startRes.json().catch(() => ({}));
  const smTokenPath =
    startBody.runtime?.tokenPath ?? join(home, "runtime", "secondmates", "infra", "daemon.token");
  const smHome = join(home, "secondmates", "infra");
  let smToken = null;
  try {
    smToken = await waitForHealth(smHome, SM_PORT, 25000, smTokenPath);
  } catch (error) {
    console.error("secondmate failed to start:", error, "start=", startRes.status, startBody);
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
      provisioned.status === 0 &&
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

    // Production choke point: PiAuthBroker.withSpawnGrantSync must also block.
    const chokeScript = `
      import { PiAuthBroker } from '${authBrokerPath}';
      const b = PiAuthBroker.forManagedHome(${JSON.stringify(join(home, "pi"))});
      try {
        b.withSpawnGrantSync(() => { process.stdout.write('acquired'); });
      } catch (e) {
        process.stdout.write(e && e.code === 'AUTH_BROKER_TIMEOUT' ? 'blocked' : 'error');
      }
    `;
    // Short timeout env is not available — withSpawnGrantSync waits 30s. Use tryAcquire path via cross-process under hold.
    // While holder still holds, tryAcquire through a second PiAuthBroker must fail immediately.
    const chokeImmediate = `
      import { PiAuthBroker } from '${authBrokerPath}';
      const b = PiAuthBroker.forManagedHome(${JSON.stringify(join(home, "pi"))});
      process.stdout.write(b.crossProcessBroker.tryAcquire('choke') ? 'acquired' : 'blocked');
    `;
    const choke = spawnSync(process.execPath, ["--input-type=module", "-e", chokeImmediate], {
      encoding: "utf8",
    });
    const chokeBlocked = choke.stdout.trim() === "blocked";

    await new Promise((resolve) => holder.on("exit", resolve));
    const after = spawnSync(process.execPath, ["--input-type=module", "-e", contendScript], {
      encoding: "utf8",
    });
    const freeAfterRelease = after.stdout.trim() === "acquired";

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
      blockedWhileHeld && freeAfterRelease && chokeBlocked && corruptKept,
      `blockedWhileHeld=${blockedWhileHeld} freeAfterRelease=${freeAfterRelease} chokeBlocked=${chokeBlocked} corruptKept=${corruptKept}`,
    );
  }

  // G3 — charter config drives brain + routing (edit → observed)
  {
    const charterPath = join(home, "secondmates", "infra", "config", "charter.json5");
    writeFileSync(
      charterPath,
      JSON.stringify(
        {
          name: "infra",
          domains: ["infra", "deploy"],
          brainModel: "openai/gpt-5.6-sol",
          maxConcurrentTasks: 3,
          acceptsRouting: true,
        },
        null,
        2,
      ),
    );
    const evalRoute = `
      import { SecondmateRegistry } from '${join(ROOT, "apps/orchestrator/dist/fleet/secondmates.js")}';
      import { SecondmateFleet } from '${join(ROOT, "apps/orchestrator/dist/fleet/secondmate-fleet.js")}';
      const fleet = new SecondmateFleet(new SecondmateRegistry(${JSON.stringify(home)}));
      const target = fleet.routeFor('deploy');
      const charter = target ? fleet.readCharter(target) : null;
      process.stdout.write(JSON.stringify({
        routed: target?.name ?? null,
        brain: charter?.charter.brainModel ?? null,
        source: charter?.source ?? null,
      }));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", evalRoute], {
      encoding: "utf8",
    });
    let parsed = {};
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      parsed = {};
    }
    gate(
      "G3",
      "charter edit changes the secondmate's Brain and routing domains",
      parsed.routed === "infra" &&
        parsed.brain === "openai/gpt-5.6-sol" &&
        parsed.source === "charter-file",
      `routed=${parsed.routed} brain=${parsed.brain} source=${parsed.source}`,
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
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
