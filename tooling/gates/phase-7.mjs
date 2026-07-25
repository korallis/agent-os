#!/usr/bin/env node
/**
 * Phase 7 executable gates (master plan §11 Phase 7) — secondmates.
 *
 *   G1  isolated homes: no auth material anywhere under a secondmate home (fs scan)
 *   G2  double-start blocked — a second daemon on the same home is refused
 *   G3  charter config drives the secondmate's Brain + routing (edit → observed)
 *   G4  broker serialises across PROCESSES, not just within one
 *   G5  routing hands the task over — it does not run on both fleets
 *   G6  /bearings answers within 5 s and reports unreachable as a fact
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

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon(home, port) {
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(home, port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const token = readFileSync(join(home, "daemon.token"), "utf8").trim();
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
    reg.provision({ name: 'infra', domain: 'infra' });
    reg.provision({ name: 'docs', domain: 'docs' });
    const fleet = new SecondmateFleet(reg);
    process.stdout.write(JSON.stringify(reg.list().map((r) => r.name)));
    void fleet;
  `;
  const provisioned = spawnSync(process.execPath, ["--input-type=module", "-e", evalProvision], {
    encoding: "utf8",
  });

  // G1 — no auth material under any secondmate home
  {
    const smRoot = join(home, "secondmates");
    const files = walk(smRoot);
    const banned = files.filter((f) =>
      /auth\.json$|daemon\.token$|\/secrets\/|credentials|\.key$/.test(f),
    );
    gate(
      "G1",
      "isolated homes carry no auth material (fs scan)",
      provisioned.status === 0 && files.length > 0 && banned.length === 0,
      `files=${files.length} offenders=${banned.length}`,
    );
  }

  // G2 — double-start on the same home is refused
  {
    const second = startDaemon(home, PORT + 1);
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
      "a second daemon on the same home is refused (home lock)",
      exitCode !== 0 && /already in use|lock/i.test(stderr),
      `exit=${exitCode} lockError=${/already in use|lock/i.test(stderr)}`,
    );
  }

  // G4 — the broker serialises across PROCESSES
  {
    const lockDir = join(home, "pi", "agent");
    mkdirSync(lockDir, { recursive: true });
    const brokerPath = join(ROOT, "apps/orchestrator/dist/pi/cross-process-broker.js");
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

    await new Promise((resolve) => holder.on("exit", resolve));
    const after = spawnSync(process.execPath, ["--input-type=module", "-e", contendScript], {
      encoding: "utf8",
    });
    const freeAfterRelease = after.stdout.trim() === "acquired";

    gate(
      "G4",
      "auth broker serialises across processes, not just within one",
      blockedWhileHeld && freeAfterRelease,
      `blockedWhileHeld=${blockedWhileHeld} freeAfterRelease=${freeAfterRelease}`,
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

  // G6 — bearings answers quickly and reports unreachable as a fact
  {
    const started = Date.now();
    const res = await api("/v1/secondmates/bearings");
    const elapsed = Date.now() - started;
    const body = res.ok ? await res.json() : { bearings: [] };
    const infra = (body.bearings ?? []).find((b) => b.name === "infra");
    gate(
      "G6",
      "/bearings answers within 5 s and reports unreachable as a fact",
      res.ok &&
        elapsed <= 5000 &&
        infra !== undefined &&
        infra.reachable === false &&
        infra.active === null &&
        infra.brainStatus === null,
      `elapsed=${elapsed}ms reachable=${infra?.reachable} active=${infra?.active}`,
    );
  }

  // G5 — routing hands the task over rather than running it twice
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
    const routed = await (
      await api("/v1/tools/call", {
        method: "POST",
        body: JSON.stringify({
          tool: "route_to_secondmate",
          input: { name: "infra", taskId: task.task.id },
        }),
      })
    ).json();
    const after = await (await api(`/v1/tasks/${task.task.id}`)).json();
    gate(
      "G5",
      "routing hands the task over — it does not stay live on the primary",
      routed.ok === true &&
        routed.data?.accepted === true &&
        after.task?.phase === "CANCELLED",
      `accepted=${routed.data?.accepted} primaryPhase=${after.task?.phase}`,
    );
  }

  // G7 — dual restart produces no duplicate secondmate records
  {
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
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
