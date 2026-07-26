#!/usr/bin/env node
/**
 * Phase 2 completion gates (master plan §11 Phase 2) — the criteria that can be
 * proven with fixtures, against a real daemon.
 *
 *   P1  extension usage + lifecycle frames persist AND project into analytics
 *       (fake-Pi fixture path; live extension socket is covered by real-Pi flows)
 *   P2  auth-store integrity: Agent OS never opens `auth.json` for write, and no
 *       durable frame carries token material (canary sweep)
 *   P3  env hygiene: an ambient cast-matching key is detected and blocks complete
 *   P5  onboarding detection auto-enables probes for exactly the detected
 *       providers, and leaves the others off
 *
 * Broker-lock coverage (login exclusive, steady-state concurrent, abandoned-lock
 * reclaim) lives in tooling/gates/phase-7.mjs, where the cross-process broker was
 * built — that gate is not on this branch, so this suite does not claim broker
 * locks or any holder wait/exit-race fix.
 *
 * What this file deliberately does NOT claim: anything needing the Captain's own
 * live provider credentials — a real `/login` OAuth round trip, or "each
 * CONNECTED provider shows a live/best-effort metric". Those cannot be honestly
 * evidenced from a fixture, and asserting them here would be the kind of
 * over-claim the gates exist to prevent. They stay open in the plan with that
 * reason recorded.
 *
 * Usage: node tooling/gates/phase-2b.mjs
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
import { pickPort } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p2b-${process.pid}`;
const PORT = pickPort(6100, 40);
const BASE = `http://127.0.0.1:${PORT}`;

/** Planted in the fixture auth store; must never reach anything durable. */
const TOKEN_CANARY = "AGENTOS-TOKEN-CANARY-3f9a71c4e08b-NEVER-PERSIST";

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let exitCode = 0;
const cleanups = [];
let daemon;

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p2b-home-"));
  cleanups.push(home);

  // Fixture Pi auth store on the managed path the daemon actually reads:
  // managedPiHome(AGENTOS_HOME) → $AGENTOS_HOME/pi/agent/auth.json.
  // Two providers present, others absent. The token value is the canary — the
  // daemon may READ this file, never write it, and must never copy its contents
  // into anything durable.
  const authJsonPath = join(home, "pi", "agent", "auth.json");
  mkdirSync(dirname(authJsonPath), { recursive: true });
  writeFileSync(
    authJsonPath,
    JSON.stringify(
      {
        anthropic: { access_token: TOKEN_CANARY, expires_at: Date.now() + 3_600_000 },
        xai: { api_key: TOKEN_CANARY },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const authBefore = readFileSync(authJsonPath, "utf8");

  daemon = spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      // Isolate shared ~/.pi fallback so host credentials cannot pollute
      // detection / enable-probes "exactly" assertions.
      HOME: home,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(PORT),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      AGENTOS_FAKE_GIT: "1",
      // P3: an ambient key that matches a cast the fleet could resolve.
      ANTHROPIC_API_KEY: "sk-ant-ambient-fixture-not-a-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 30_000;
  let token = null;
  while (Date.now() < deadline && token === null) {
    try {
      const candidate = readFileSync(join(home, "daemon.token"), "utf8").trim();
      if ((await fetch(`${BASE}/v1/health`)).ok) token = candidate;
    } catch {
      // not up
    }
    if (token === null) await sleep(150);
  }
  if (token === null) throw new Error("daemon did not start");

  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const get = async (path) => (await fetch(`${BASE}${path}`, { headers: auth })).json();
  const post = async (path, body) =>
    (await fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json();
  const postRaw = async (path, body) => {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  };

  // ── P5 — onboarding detection auto-enables exactly the detected providers ─
  {
    // Seed deterministic quota fixtures first: otherwise enabling probes fires
    // real requests at provider endpoints with a fixture credential, which is
    // slow, flaky, and tests the network rather than the enablement decision.
    mkdirSync(join(home, "fake-quota"), { recursive: true });
    for (const provider of ["anthropic", "xai"]) {
      writeFileSync(
        join(home, "fake-quota", `${provider}.json`),
        JSON.stringify([
          {
            kind: "weekly-window-pct",
            value: 12,
            unit: "percent",
            tier: "live",
            source: "OAUTH",
            syncedAt: new Date().toISOString(),
            reason: null,
            resetsAt: null,
            limitReached: false,
          },
        ]),
      );
    }

    await post("/v1/onboarding", { action: "refresh-doctor" });
    const enableRes = await postRaw("/v1/onboarding", { action: "enable-probes" });
    await sleep(800);
    const effective = await get("/v1/config/effective");
    const providers = effective.config?.quota?.providers ?? {};
    const enabled = Object.entries(providers)
      .filter(([, cfg]) => cfg?.enabled === true)
      .map(([name]) => name)
      .sort();
    // The fixture store holds anthropic + xai. Others must stay OFF: enabling a
    // probe for a provider the Captain never connected would poll an endpoint
    // they never authorised. Both directions required — missing enables are
    // failures too (empty enable-probes must not pass).
    const detected = ["anthropic", "xai"];
    const unexpected = enabled.filter((p) => !detected.includes(p));
    const missing = detected.filter((p) => !enabled.includes(p));
    const enableOk = enableRes.status >= 200 && enableRes.status < 300;
    gate(
      "P5",
      "onboarding enables probes for exactly the detected providers and leaves the rest off",
      enableOk && unexpected.length === 0 && missing.length === 0,
      `enableStatus=${enableRes.status} enabled=[${enabled.join(",")}] unexpectedlyEnabled=[${unexpected.join(",")}] missing=[${missing.join(",")}]`,
    );
  }

  // ── P1 — extension frames persist and project ─────────────────────────
  {
    const repo = mkdtempSync(join(tmpdir(), "agentos-p2b-repo-"));
    cleanups.push(repo);
    const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "p2b@agent-os.local");
    git("config", "user.name", "phase2b");
    writeFileSync(join(repo, "README.md"), "# p2b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");

    const projectId = (
      await post("/v1/projects", { name: "p2b", path: repo, mode: "local-only", trusted: true })
    ).project.id;
    const taskId = (
      await post("/v1/tasks", {
        spec: { shape: "SHIP", title: "extension frames", intent: "p2b", projectId, mode: "local-only", yolo: true },
      })
    ).task.id;
    await post("/v1/tools/call", {
      tool: "resolve_cast",
      input: {
        taskId,
        roles: [{ role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true }],
        familyCheckOverride: false,
      },
    });
    await post("/v1/tools/call", {
      tool: "spawn_crewmate",
      input: { taskId, role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", vars: {}, redBaselineOverride: true },
    });
    await sleep(1500);

    // Persisted: present in the durable log.
    const usage = await get("/v1/events/replay?types=ext.usage&limit=1000");
    const spawns = await get("/v1/events/replay?types=session.spawned&limit=1000");
    const usageFrames = (usage.events ?? []).filter(
      (e) => e.event?.payload?.inputTokens !== undefined,
    );

    // Projected: the derived analytics view must equal the sum of persisted
    // ext.usage inputTokens — non-zero alone would admit double-counts or drops.
    const analytics = await get("/v1/analytics?days=1");
    const projectedTokens = analytics.totals?.inputTokens ?? 0;
    const summedUsageTokens = usageFrames.reduce(
      (sum, e) => sum + (typeof e.event.payload.inputTokens === "number" ? e.event.payload.inputTokens : 0),
      0,
    );

    gate(
      "P1",
      "extension usage + lifecycle frames are persisted AND projected into analytics",
      usageFrames.length > 0 &&
        (spawns.events ?? []).length > 0 &&
        projectedTokens === summedUsageTokens &&
        summedUsageTokens > 0 &&
        usageFrames.every((e) => typeof e.event.payload.inputTokens === "number"),
      `usageFrames=${usageFrames.length} spawnFrames=${(spawns.events ?? []).length} projectedInputTokens=${projectedTokens} summedUsageInputTokens=${summedUsageTokens}`,
    );
  }

  // ── P2 — auth-store integrity: never written, never leaked ────────────
  {
    const authAfter = existsSync(authJsonPath) ? readFileSync(authJsonPath, "utf8") : "";
    const untouched = authAfter === authBefore;

    // Canary sweep across everything durable the daemon owns.
    const offenders = [];
    for (const file of walk(home)) {
      // The planted fixture itself holds the canary; only non-auth.json durable
      // copies are leaks.
      if (file === authJsonPath) continue;
      let contents;
      try {
        contents = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (contents.includes(TOKEN_CANARY)) offenders.push(file.slice(home.length + 1));
    }
    // And over the API surface, including a full replay.
    const replay = JSON.stringify(await get("/v1/events/replay?order=desc&limit=10000"));
    const connections = JSON.stringify(await get("/v1/connections"));
    const apiLeak = replay.includes(TOKEN_CANARY) || connections.includes(TOKEN_CANARY);

    gate(
      "P2",
      "auth.json is never written by Agent OS, and no token material reaches anything durable",
      untouched && offenders.length === 0 && !apiLeak,
      `authJsonUntouched=${untouched} durableOffenders=${offenders.length}${offenders.length > 0 ? ` (${offenders.slice(0, 3).join(", ")})` : ""} apiLeak=${apiLeak}`,
    );
  }

  // ── P3 — env hygiene: an ambient key BLOCKS the subscription path ─────
  {
    // The real rule (§4.10 Step 2a): with an ambient ANTHROPIC_API_KEY set, the
    // subscription-sdk path must REFUSE to verify. Silently proceeding would
    // switch a Claude Max subscription onto API billing without the Captain
    // ever being told — a bill they did not agree to.
    // The verdict is recorded against the anthropic provider on the
    // subscription-sdk path, so select that path before verifying.
    await post("/v1/onboarding", { action: "set-providers", providers: ["anthropic"] });
    await post("/v1/onboarding", {
      action: "set-claude-billing",
      claudeBillingMode: "subscription-sdk",
    });
    const verify = await post("/v1/onboarding", { action: "verify-claude-sdk" });
    const anthropic = (verify.state?.providers ?? []).find((p) => p.provider === "anthropic");
    const sdk = anthropic?.claudeSdk;
    // noAmbientApiKey false === the ambient key was detected.
    const ambientDetected = sdk !== undefined && sdk.noAmbientApiKey === false;
    // Product gate: complete must refuse with ONBOARDING_BLOCKED (not a proxy
    // like catalogHealthcheck, which can be true with an ambient key present).
    const completeRes = await postRaw("/v1/onboarding", { action: "complete" });
    const blocksCompletion =
      completeRes.status === 409 && completeRes.json?.error?.code === "ONBOARDING_BLOCKED";

    gate(
      "P3",
      "an ambient ANTHROPIC_API_KEY is detected and blocks the subscription-sdk path",
      ambientDetected && blocksCompletion,
      `ambientDetected=${ambientDetected} completeStatus=${completeRes.status} completeCode=${completeRes.json?.error?.code ?? "none"} claudeSdk=${JSON.stringify(sdk ?? null).slice(0, 120)}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  // Set the code; exit AFTER the finally block has torn everything down.
  // process.exit() does not unwind `finally`, so exiting here would orphan the
  // daemon, the tmux server and the temp homes on every single run — including
  // the successful ones. Accumulated orphans starve later gates of ports and
  // CPU, which surfaces as unrelated gates failing for no visible reason.
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try {
    daemon?.kill("SIGTERM");
  } catch {
    // ignore
  }
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const path of cleanups) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

process.exit(exitCode);
