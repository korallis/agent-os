import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrossProcessAuthBroker } from "../src/pi/cross-process-broker.js";
import { PiAuthBroker } from "../src/pi/auth-broker.js";
import {
  SecondmateRegistry,
  secondmateTmuxSocket,
} from "../src/fleet/secondmates.js";
import {
  SecondmateCapacityError,
  SecondmateFleet,
  SecondmateHandoverError,
} from "../src/fleet/secondmate-fleet.js";
import { FleetService } from "../src/fleet/service.js";
import { ConfigService } from "../src/config/service.js";
import { SHIPPED_DEFAULTS_DIR, startDaemon, type RunningDaemon } from "../src/daemon.js";

/**
 * Phase 7 units: the cross-process auth lock that orders a primary against a
 * secondmate, isolated homes carrying no auth material, and charter-driven
 * routing.
 */

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("cross-process auth broker", () => {
  it("grants the lock to exactly one holder at a time", () => {
    const dir = temp("agentos-p7-lock-");
    const a = new CrossProcessAuthBroker(dir);
    const b = new CrossProcessAuthBroker(dir);

    expect(a.tryAcquire("login")).toBe(true);
    // A second process must not get the store while the first holds it.
    expect(b.tryAcquire("refresh")).toBe(false);

    a.release();
    expect(b.tryAcquire("refresh")).toBe(true);
    b.release();
  });

  it("refuses to let a non-holder release someone else's lock", () => {
    const dir = temp("agentos-p7-release-");
    const holder = new CrossProcessAuthBroker(dir);
    expect(holder.tryAcquire("login")).toBe(true);

    // Simulate another process by rewriting the holder pid to a live-but-other
    // pid; release() must then be a no-op rather than freeing the store.
    const lockPath = join(dir, "auth-broker.lock");
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: process.pid + 1, acquiredAt: Date.now(), purpose: "login" })}\n`,
    );
    holder.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("refuses to release an unreadable/corrupt lock", () => {
    const dir = temp("agentos-p7-corrupt-");
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "auth-broker.lock");
    writeFileSync(lockPath, "not-json-at-all");
    const broker = new CrossProcessAuthBroker(dir);
    broker.release();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("writes lock metadata through the exclusive fd (no empty file window)", () => {
    const dir = temp("agentos-p7-fd-");
    const broker = new CrossProcessAuthBroker(dir);
    expect(broker.tryAcquire("login")).toBe(true);
    const info = broker.holder();
    expect(info).not.toBeNull();
    expect(info?.pid).toBe(process.pid);
    expect(info?.purpose).toBe("login");
    broker.release();
  });

  it("reclaims a lock whose holder process is gone", () => {
    const dir = temp("agentos-p7-stale-");
    const lockPath = join(dir, "auth-broker.lock");
    mkdirSync(dir, { recursive: true });
    // A pid that is certainly not running; a crashed daemon must not wedge the
    // Captain's fleet forever.
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 999_999_998, acquiredAt: Date.now(), purpose: "login" })}\n`,
    );

    const broker = new CrossProcessAuthBroker(dir);
    expect(broker.tryAcquire("login")).toBe(true);
    broker.release();
  });

  it("serialises awaited sections so two callers cannot overlap", async () => {
    const dir = temp("agentos-p7-serial-");
    const broker = new CrossProcessAuthBroker(dir);
    const order: string[] = [];

    const first = broker.withAuthLock("a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 40));
      order.push("a-end");
    });
    const second = broker.withAuthLock("b", async () => {
      order.push("b-start");
      order.push("b-end");
    });

    await Promise.all([first, second]);
    // b must not begin until a has finished.
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });
});

describe("PiAuthBroker choke point", () => {
  it("withSpawnGrant acquires the cross-process lock asynchronously", async () => {
    const dir = temp("agentos-p7-choke-");
    const piHome = join(dir, "pi");
    mkdirSync(join(piHome, "agent"), { recursive: true });
    const broker = PiAuthBroker.forManagedHome(piHome);
    const peer = new CrossProcessAuthBroker(join(piHome, "agent"));

    let ran = false;
    await broker.withSpawnGrant(async () => {
      ran = true;
      expect(broker.holdsAuthLock()).toBe(true);
      // While held, a peer process cannot acquire.
      expect(peer.tryAcquire("peer")).toBe(false);
    });
    expect(ran).toBe(true);
    expect(broker.holdsAuthLock()).toBe(false);
    expect(peer.tryAcquire("peer")).toBe(true);
    peer.release();
  });

  it("withSpawnGrant waits out a long peer hold beyond the old 30s default", async () => {
    // Login hold is 5 minutes; spawn-grant timeout must be derived from that
    // (LOGIN_HOLD + skew), not CrossProcessAuthBroker's 30s default.
    const dir = temp("agentos-p7-grant-timeout-");
    const piHome = join(dir, "pi");
    mkdirSync(join(piHome, "agent"), { recursive: true });
    const broker = PiAuthBroker.forManagedHome(piHome);
    const peer = new CrossProcessAuthBroker(join(piHome, "agent"));
    expect(peer.tryAcquire("login-hold")).toBe(true);

    let acquired = false;
    const grant = broker.withSpawnGrant(async () => {
      acquired = true;
    });
    // Still held after >30s would have timed out under the old default; release
    // at 50ms and prove the spawn grant proceeds rather than AUTH_BROKER_TIMEOUT.
    await new Promise((r) => setTimeout(r, 50));
    expect(acquired).toBe(false);
    peer.release();
    await grant;
    expect(acquired).toBe(true);
  });

  it("beginLoginHold resolves only after the cross-process lock is held", async () => {
    const dir = temp("agentos-p7-login-hold-");
    const piHome = join(dir, "pi");
    mkdirSync(join(piHome, "agent"), { recursive: true });
    const broker = PiAuthBroker.forManagedHome(piHome);
    const peer = new CrossProcessAuthBroker(join(piHome, "agent"));

    const { settled } = await broker.beginLoginHold({
      baselineMtimeMs: 0,
      timeoutMs: 200,
    });
    // Attach command may be minted only after this point — peer must be blocked.
    expect(broker.holdsAuthLock()).toBe(true);
    expect(peer.tryAcquire("spawn-grant")).toBe(false);
    await settled;
    expect(broker.holdsAuthLock()).toBe(false);
    expect(peer.tryAcquire("spawn-grant")).toBe(true);
    peer.release();
  });
});

describe("secondmate homes", () => {
  it("assigns a distinct tmux socket per secondmate name", () => {
    expect(secondmateTmuxSocket("infra")).toBe("agentos-infra");
    expect(secondmateTmuxSocket("docs")).toBe("agentos-docs");
    // Must not collide with the default primary socket name.
    expect(secondmateTmuxSocket("infra")).not.toBe("agentos");
  });

  it("provisions an isolated home carrying no auth material", async () => {
    const home = temp("agentos-p7-home-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "infra", domain: "infra" });

    expect(record.home).toContain("secondmates");
    expect(existsSync(join(record.home, "config"))).toBe(true);
    // The whole point: a secondmate never holds credentials of its own.
    expect(existsSync(join(record.home, "auth.json"))).toBe(false);
    expect(existsSync(join(record.home, "secrets"))).toBe(false);
    expect(registry.auditNoAuthMaterial().ok).toBe(true);
  });

  it("refuses a duplicate name rather than clobbering an existing home", async () => {
    const home = temp("agentos-p7-dupe-");
    const registry = new SecondmateRegistry(home);
    await registry.provision({ name: "docs", domain: "docs" });
    await expect(registry.provision({ name: "docs", domain: "docs" })).rejects.toThrow(/already exists/);
  });

  it("fails the audit when auth material appears under a secondmate home", async () => {
    const home = temp("agentos-p7-audit-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "leaky", domain: "x" });
    writeFileSync(join(record.home, "daemon.token"), "should-not-be-here\n");

    const audit = registry.auditNoAuthMaterial();
    expect(audit.ok).toBe(false);
    expect(audit.offenders.join(" ")).toContain("daemon.token");
  });

  it("keeps runtime tokens outside the audited secondmate home", async () => {
    const home = temp("agentos-p7-token-out-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "infra", domain: "infra" });
    const tokenPath = registry.runtimeTokenPath(record.name);
    expect(tokenPath.startsWith(record.home)).toBe(false);
    expect(tokenPath).toContain(join("runtime", "secondmates", "infra"));
    mkdirSync(join(tokenPath, ".."), { recursive: true });
    writeFileSync(tokenPath, "runtime-token\n", { mode: 0o600 });
    // Token outside the home must not fail the home audit.
    expect(registry.auditNoAuthMaterial().ok).toBe(true);
    expect(registry.readRuntimeToken("infra")).toBe("runtime-token");
  });
});

describe("charter-driven routing", () => {
  it("routes by domain and honours a charter that declines routing", async () => {
    const home = temp("agentos-p7-route-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);

    const infra = await registry.provision({ name: "infra", domain: "infra" });
    await registry.provision({ name: "docs", domain: "docs" });

    expect(fleet.routeFor("infra")?.name).toBe("infra");
    expect(fleet.routeFor("docs")?.name).toBe("docs");
    // No destination is invented for an unknown domain.
    expect(fleet.routeFor("kernel")).toBeNull();

    await fleet.writeCharter(infra, {
      name: "infra",
      domains: ["infra"],
      brainModel: "anthropic/claude-fable-5",
      maxConcurrentTasks: 2,
      acceptsRouting: false,
    });
    expect(fleet.routeFor("infra")).toBeNull();
  });

  it("named acceptsDomain checks the target charter, not first-wins routeFor", async () => {
    const home = temp("agentos-p7-named-route-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);

    // Provision order: alpha first. Both accept "shared".
    const alpha = await registry.provision({ name: "alpha", domain: "shared" });
    const beta = await registry.provision({ name: "beta", domain: "other" });
    await fleet.writeCharter(alpha, {
      name: "alpha",
      domains: ["shared"],
      brainModel: null,
      maxConcurrentTasks: 2,
      acceptsRouting: true,
    });
    await fleet.writeCharter(beta, {
      name: "beta",
      domains: ["shared", "other"],
      brainModel: null,
      maxConcurrentTasks: 2,
      acceptsRouting: true,
    });

    // Auto-pick still first-wins.
    expect(fleet.routeFor("shared")?.name).toBe("alpha");
    // Named beta must still accept shared via its own charter.
    expect(fleet.acceptsDomain(beta, "shared")).toBe(true);
    expect(fleet.acceptsDomain(alpha, "other")).toBe(false);
    expect(fleet.acceptsDomain(beta, "other")).toBe(true);
  });

  it("reads a charter edit back — the charter is config, not code", async () => {
    const home = temp("agentos-p7-charter-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);
    const record = await registry.provision({ name: "infra", domain: "infra" });

    await fleet.writeCharter(record, {
      name: "infra",
      domains: ["infra", "deploy"],
      brainModel: "openai/gpt-5.6-sol",
      maxConcurrentTasks: 4,
      acceptsRouting: true,
    });

    const { charter, source } = fleet.readCharter(record);
    expect(source).toBe("charter-file");
    expect(charter.brainModel).toBe("openai/gpt-5.6-sol");
    expect(charter.domains).toEqual(["infra", "deploy"]);
    expect(fleet.routeFor("deploy")?.name).toBe("infra");
  });

  it("partial charter sync merges omitted fields instead of resetting them", async () => {
    const home = temp("agentos-p7-charter-merge-");
    mkdirSync(join(home, "config"), { recursive: true });
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
      agentosdBin: process.execPath,
    });
    await service.start();
    const record = await service.provisionSecondmate({
      name: "infra",
      domain: "infra",
      brainModel: "openai/gpt-5.6-sol",
      maxConcurrentTasks: 4,
    });
    expect(record.brainModel).toBe("openai/gpt-5.6-sol");

    // Domains-only update must keep brainModel, capacity, and acceptsRouting.
    const result = await service.syncSecondmateCharter("infra", {
      domains: ["infra", "deploy"],
    });
    expect(result.charter.domains).toEqual(["infra", "deploy"]);
    expect(result.charter.brainModel).toBe("openai/gpt-5.6-sol");
    expect(result.charter.maxConcurrentTasks).toBe(4);
    expect(result.charter.acceptsRouting).toBe(true);

    const { charter } = service.secondmateFleet.readCharter(
      service.secondmates.get("infra")!,
    );
    expect(charter.brainModel).toBe("openai/gpt-5.6-sol");
    expect(charter.maxConcurrentTasks).toBe(4);
    expect(charter.acceptsRouting).toBe(true);
    expect(charter.domains).toEqual(["infra", "deploy"]);
  });

  it("falls back to the provision record when a charter is malformed", async () => {
    const home = temp("agentos-p7-bad-charter-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);
    const record = await registry.provision({ name: "infra", domain: "infra" });
    writeFileSync(join(record.home, "config", "charter.json5"), "{ this is not valid");

    const { source, error } = fleet.readCharter(record);
    // A malformed charter must not make the secondmate invisible.
    expect(source).toBe("provision-record");
    expect(error).not.toBeNull();
  });

  it("reports an unstarted secondmate as unreachable rather than healthy", async () => {
    const home = temp("agentos-p7-bearings-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);
    await registry.provision({ name: "infra", domain: "infra" });

    const bearings = await fleet.bearings();
    expect(bearings).toHaveLength(1);
    expect(bearings[0]?.reachable).toBe(false);
    expect(bearings[0]?.reason).toContain("never started");
    // Never invent activity for a daemon that is not running.
    expect(bearings[0]?.active).toBeNull();
    expect(bearings[0]?.brainStatus).toBeNull();
  });
});

describe("secondmate stopAll reaps runtime orphans", () => {
  it("stops a secondmate known only via runtime.json after primary restart", async () => {
    const home = temp("agentos-p7-stopall-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "infra", domain: "infra" });

    // Simulate an orphaned daemon: runtime.json with a live pid, no children entry.
    const sleeper = await import("node:child_process").then((cp) =>
      cp.spawn("sleep", ["30"], { stdio: "ignore" }),
    );
    expect(sleeper.pid).toBeTypeOf("number");
    const runtimeDir = join(home, "runtime", "secondmates", record.name);
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "runtime.json"),
      JSON.stringify({
        name: record.name,
        pid: sleeper.pid,
        port: record.port,
        tokenPath: join(runtimeDir, "daemon.token"),
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );

    // Fresh registry instance = empty children map (primary restart).
    const afterRestart = new SecondmateRegistry(home);
    expect(afterRestart.readRuntime("infra")?.pid).toBe(sleeper.pid);
    await afterRestart.stopAll();

    expect(afterRestart.readRuntime("infra")).toBeNull();
    // Process should be gone (or unsignallable).
    let alive = true;
    try {
      process.kill(sleeper.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("stop waits until the target pid is reaped before clearing runtime", async () => {
    const home = temp("agentos-p7-stop-reap-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "infra", domain: "infra" });
    const sleeper = await import("node:child_process").then((cp) =>
      cp.spawn("sleep", ["30"], { stdio: "ignore" }),
    );
    expect(sleeper.pid).toBeTypeOf("number");
    const runtimeDir = join(home, "runtime", "secondmates", record.name);
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "runtime.json"),
      JSON.stringify({
        name: record.name,
        pid: sleeper.pid,
        port: record.port,
        tokenPath: join(runtimeDir, "daemon.token"),
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );

    const result = await registry.stop("infra");
    expect(result.stopped).toBe(true);
    expect(registry.readRuntime("infra")).toBeNull();
    let alive = true;
    try {
      process.kill(sleeper.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("stop leaves a live process alone when runtime names a dead pid", async () => {
    const home = temp("agentos-p7-stop-identity-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "infra", domain: "infra" });
    const live = await import("node:child_process").then((cp) =>
      cp.spawn("sleep", ["30"], { stdio: "ignore" }),
    );
    expect(live.pid).toBeTypeOf("number");
    const runtimeDir = join(home, "runtime", "secondmates", record.name);
    mkdirSync(runtimeDir, { recursive: true });
    // Stale bookkeeping: dead pid in runtime.json while an unrelated process lives.
    writeFileSync(
      join(runtimeDir, "runtime.json"),
      JSON.stringify({
        name: record.name,
        pid: 1_000_000 + (process.pid % 100_000),
        port: record.port,
        tokenPath: join(runtimeDir, "daemon.token"),
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );

    const result = await registry.stop("infra");
    expect(result.stopped).toBe(false);
    expect(registry.readRuntime("infra")).toBeNull();
    let liveAlive = true;
    try {
      process.kill(live.pid!, 0);
    } catch {
      liveAlive = false;
    }
    expect(liveAlive).toBe(true);
    try {
      process.kill(live.pid!, "SIGKILL");
    } catch {
      // ignore
    }
  });

  it("concurrent stop calls serialize without orphaning a live pid", async () => {
    const home = temp("agentos-p7-stop-start-race-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "infra", domain: "infra" });
    const sleeper = await import("node:child_process").then((cp) =>
      cp.spawn("sleep", ["60"], { stdio: "ignore" }),
    );
    expect(sleeper.pid).toBeTypeOf("number");
    const runtimeDir = join(home, "runtime", "secondmates", record.name);
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      join(runtimeDir, "runtime.json"),
      JSON.stringify({
        name: record.name,
        pid: sleeper.pid,
        port: record.port,
        tokenPath: join(runtimeDir, "daemon.token"),
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );

    // Concurrent stop (runtime orphan) + stop again: both share the registry
    // mutation chain; after they settle, runtime matches reality (no live untracked pid).
    const [a, b] = await Promise.all([
      registry.stop("infra"),
      registry.stop("infra"),
    ]);
    expect(a.stopped || b.stopped).toBe(true);
    expect(registry.readRuntime("infra")).toBeNull();
    let alive = true;
    try {
      process.kill(sleeper.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("start failure reaps the child before clearing runtime bookkeeping", async () => {
    const home = temp("agentos-p7-start-reap-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "infra", domain: "infra" });

    // Spawn a long-lived process that never becomes ready (no token/status).
    await expect(
      registry.start(record.name, {
        agentosdBin: join(home, "missing-agentosd-bin.js"),
        sharedPiHome: join(home, "pi"),
        readyTimeoutMs: 200,
      }),
    ).rejects.toThrow(/SECONDMATE_START_FAILED|failed to spawn|did not become ready|exited before ready|ENOENT|Cannot find module|secondmate/i);

    // Either spawn failed before tracking, or bookkeeping was cleared only after reap.
    const runtime = registry.readRuntime(record.name);
    if (runtime !== null) {
      // Still tracked only if process is actually alive (unreaped after hard kill window).
      let alive = true;
      try {
        process.kill(runtime.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(true);
    }
  });

  it("start ready-timeout reaps a live child before dropping runtime.json", async () => {
    const home = temp("agentos-p7-start-timeout-reap-");
    const registry = new SecondmateRegistry(home);
    const record = await registry.provision({ name: "infra", domain: "infra" });

    // Stays alive but never writes a daemon token / never serves /v1/status.
    const hangBin = join(home, "hang-agentosd.mjs");
    const pidFile = join(home, "hang.pid");
    writeFileSync(
      hangBin,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 60_000);\n` +
        `process.on("SIGTERM", () => process.exit(0));\n`,
      { mode: 0o700 },
    );

    await expect(
      registry.start(record.name, {
        agentosdBin: hangBin,
        sharedPiHome: join(home, "pi"),
        readyTimeoutMs: 400,
      }),
    ).rejects.toThrow(/did not become ready/);

    // Confirmed reaped → bookkeeping cleared (invariant: no erased record for a live pid).
    expect(registry.readRuntime(record.name)).toBeNull();
    expect(existsSync(pidFile)).toBe(true);
    const hangPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(hangPid) && hangPid > 0).toBe(true);
    let alive = true;
    try {
      process.kill(hangPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("concurrent provision serializes port allocation", async () => {
    const home = temp("agentos-p7-prov-race-");
    const registry = new SecondmateRegistry(home, { primaryPort: 4700 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        registry.provision({ name: `sm${i}`, domain: `d${i}` }),
      ),
    );
    const ports = results.map((r) => r.port);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports.every((p) => p !== 4700)).toBe(true);
    expect(registry.list()).toHaveLength(8);
  });
});

describe("secondmate admission capacity", () => {
  it("refuses create_task on a home whose charter is at maxConcurrentTasks", async () => {
    const home = temp("agentos-p7-cap-");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "charter.json5"),
      JSON.stringify({
        name: "infra",
        domains: ["infra"],
        brainModel: null,
        maxConcurrentTasks: 1,
        acceptsRouting: true,
      }),
      { mode: 0o600 },
    );
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    // Re-write charter after installDefaults may not touch it; ensure present.
    writeFileSync(
      join(home, "config", "charter.json5"),
      JSON.stringify({
        name: "infra",
        domains: ["infra"],
        brainModel: null,
        maxConcurrentTasks: 1,
        acceptsRouting: true,
      }),
      { mode: 0o600 },
    );
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await service.start();
    const project = service.projects.register({
      name: "cap",
      path: home,
      mode: "local-only",
      trusted: true,
    });
    const first = service.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "one",
        intent: "first",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(first.ok).toBe(true);
    const second = service.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "two",
        intent: "should refuse",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(second.ok).toBe(false);
    expect(second.error?.message ?? "").toMatch(/capacity|concurrent/i);
  });

  it("concurrent create_task calls respect maxConcurrentTasks (exclusive admission)", async () => {
    const home = temp("agentos-p7-cap-race-");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      join(home, "config", "charter.json5"),
      JSON.stringify({
        name: "infra",
        domains: ["infra"],
        brainModel: null,
        maxConcurrentTasks: 2,
        acceptsRouting: true,
      }),
      { mode: 0o600 },
    );
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    writeFileSync(
      join(home, "config", "charter.json5"),
      JSON.stringify({
        name: "infra",
        domains: ["infra"],
        brainModel: null,
        maxConcurrentTasks: 2,
        acceptsRouting: true,
      }),
      { mode: 0o600 },
    );
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await service.start();
    const project = service.projects.register({
      name: "cap-race",
      path: home,
      mode: "local-only",
      trusted: true,
    });
    const make = (title: string) =>
      service.tools.invoke("create_task", {
        spec: {
          shape: "SHIP",
          title,
          intent: title,
          projectId: project.id,
          mode: "local-only",
          yolo: true,
        },
      });
    // Concurrent scheduling via microtasks; exclusive admission must cap at 2.
    const results = await Promise.all([
      Promise.resolve().then(() => make("a")),
      Promise.resolve().then(() => make("b")),
      Promise.resolve().then(() => make("c")),
      Promise.resolve().then(() => make("d")),
    ]);
    const ok = results.filter((r) => r.ok).length;
    const refused = results.filter((r) => !r.ok).length;
    expect(ok).toBe(2);
    expect(refused).toBe(2);
  });
});

describe("secondmate provision constraints", () => {
  it("refuses a port already recorded for another secondmate or the primary", async () => {
    const home = temp("agentos-p7-port-");
    const registry = new SecondmateRegistry(home, { primaryPort: 4700 });
    const first = await registry.provision({ name: "infra", domain: "infra", port: 4710 });
    expect(first.port).toBe(4710);
    await expect(
      registry.provision({ name: "docs", domain: "docs", port: 4710 }),
    ).rejects.toThrow(/already used by infra/);
    await expect(
      registry.provision({ name: "clash", domain: "x", port: 4700 }),
    ).rejects.toThrow(/collides with the primary/);
  });

  it("production daemon refuses secondmate on its bound port without AGENTOS_PORT", async () => {
    const prev = process.env.AGENTOS_PORT;
    delete process.env.AGENTOS_PORT;
    const home = temp("agentos-p7-bound-port-");
    let daemon: RunningDaemon | undefined;
    try {
      daemon = await startDaemon({ home, port: 0 });
      expect(process.env.AGENTOS_PORT).toBeUndefined();
      expect(daemon.port).toBeGreaterThan(0);

      const res = await fetch(`http://127.0.0.1:${daemon.port}/v1/secondmates`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "clash",
          domain: "x",
          port: daemon.port,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message ?? JSON.stringify(body)).toMatch(/collides with the primary/i);
    } finally {
      await daemon?.close();
      if (prev !== undefined) process.env.AGENTOS_PORT = prev;
      else delete process.env.AGENTOS_PORT;
    }
  });

  it("persists maxConcurrentTasks on the provision record for charter fallback", async () => {
    const home = temp("agentos-p7-cap-record-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);
    const record = await registry.provision({
      name: "infra",
      domain: "infra",
      maxConcurrentTasks: 7,
    });
    expect(record.maxConcurrentTasks).toBe(7);
    expect(registry.get("infra")?.maxConcurrentTasks).toBe(7);

    writeFileSync(join(record.home, "config", "charter.json5"), "{ this is not valid");
    const { charter, source } = fleet.readCharter(record);
    expect(source).toBe("provision-record");
    expect(charter.maxConcurrentTasks).toBe(7);
    expect(charter.acceptsRouting).toBe(true);
  });

  it("rejects out-of-range maxConcurrentTasks at provision (schema boundary)", async () => {
    const home = temp("agentos-p7-cap-schema-");
    const registry = new SecondmateRegistry(home);
    await expect(
      registry.provision({ name: "zero", domain: "x", maxConcurrentTasks: 0 }),
    ).rejects.toThrow();
    await expect(
      registry.provision({ name: "high", domain: "x", maxConcurrentTasks: 99 }),
    ).rejects.toThrow();
    expect(existsSync(join(home, "secondmates", "zero"))).toBe(false);
    expect(existsSync(join(home, "secondmates", "high"))).toBe(false);
  });

  it("fails closed on capacity when the provision record has no durable cap", async () => {
    const home = temp("agentos-p7-cap-missing-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);
    const record = await registry.provision({ name: "infra", domain: "infra" });
    // Simulate a pre-cap provision record without maxConcurrentTasks.
    writeFileSync(
      join(record.home, "charter.json"),
      JSON.stringify({
        name: record.name,
        home: record.home,
        port: record.port,
        domain: record.domain,
        brainModel: null,
        createdAt: record.createdAt,
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(record.home, "config", "charter.json5"), "{ broken");
    const reloaded = registry.get("infra");
    expect(reloaded).not.toBeNull();
    const { charter, source } = fleet.readCharter(reloaded!);
    expect(source).toBe("provision-record");
    expect(charter.acceptsRouting).toBe(false);
    expect(Number.isInteger(charter.maxConcurrentTasks)).toBe(true);
  });
});

describe("handover crash recovery and post-accept finalization", () => {
  it("reconcileAcceptedHandovers releases primary after durable remote accept", async () => {
    const home = temp("agentos-p7-handover-reconcile-");
    mkdirSync(join(home, "config"), { recursive: true });
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await service.start();
    const project = service.projects.register({
      name: "h",
      path: home,
      mode: "local-only",
      trusted: true,
    });
    const created = service.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "handover incomplete",
        intent: "crash after remote accept",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(created.ok).toBe(true);
    const taskId = (created.data as { id: string }).id;
    expect((created.data as { phase: string }).phase).not.toBe("CANCELLED");

    // Simulate kill-9 after remote accept was durable, before primary CANCELLED.
    const remoteTaskId = "01ARZ3NDEKTSV4RRFFQ69G5FHA";
    const handoverDir = join(home, "runs", taskId);
    mkdirSync(handoverDir, { recursive: true });
    writeFileSync(
      join(handoverDir, "handover.json"),
      `${JSON.stringify({
        taskId,
        secondmateName: "infra",
        domain: "infra",
        status: "accepted",
        remoteTaskId,
        updatedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    const finished = service.tools.reconcileAcceptedHandovers();
    expect(finished).toContain(taskId);
    const after = service.tools.invoke("read_task", { taskId });
    expect(after.ok).toBe(true);
    expect((after.data as { phase: string }).phase).toBe("CANCELLED");
  });

  it("route_to_secondmate reports accepted when primary is already terminal after accept", async () => {
    const home = temp("agentos-p7-handover-terminal-");
    mkdirSync(join(home, "config"), { recursive: true });
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await service.start();
    await service.provisionSecondmate({ name: "infra", domain: "infra" });
    const project = service.projects.register({
      name: "h2",
      path: home,
      mode: "local-only",
      trusted: true,
    });
    const created = service.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "already terminal",
        intent: "accept then terminal",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(created.ok).toBe(true);
    const taskId = (created.data as { id: string }).id;
    const remoteTaskId = "01ARZ3NDEKTSV4RRFFQ69G5FHB";
    mkdirSync(join(home, "runs", taskId), { recursive: true });
    writeFileSync(
      join(home, "runs", taskId, "handover.json"),
      `${JSON.stringify({
        taskId,
        secondmateName: "infra",
        domain: "infra",
        status: "accepted",
        remoteTaskId,
        updatedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    // Primary already terminal (e.g. concurrent cancel) after remote accepted.
    const cancelled = service.tools.invoke("cancel_task", {
      taskId,
      reason: "concurrent cancel during handover",
    });
    expect(cancelled.ok).toBe(true);
    expect((cancelled.data as { phase: string }).phase).toBe("CANCELLED");

    const routed = await service.tools.invokeAsync("route_to_secondmate", {
      name: "infra",
      taskId,
      domain: "infra",
    });
    expect(routed.ok).toBe(true);
    expect(routed.data).toMatchObject({
      accepted: true,
      remoteTaskId,
      taskId,
      name: "infra",
    });
  });

  it("boot rehydrate finishes durable accepted handovers without re-POSTing", async () => {
    const home = temp("agentos-p7-handover-boot-");
    mkdirSync(join(home, "config"), { recursive: true });
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    const first = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await first.start();
    const project = first.projects.register({
      name: "boot",
      path: home,
      mode: "local-only",
      trusted: true,
    });
    const created = first.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "boot reconcile",
        intent: "kill-9 window",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(created.ok).toBe(true);
    const taskId = (created.data as { id: string }).id;
    const remoteTaskId = "01ARZ3NDEKTSV4RRFFQ69G5FHC";
    mkdirSync(join(home, "runs", taskId), { recursive: true });
    writeFileSync(
      join(home, "runs", taskId, "handover.json"),
      `${JSON.stringify({
        taskId,
        secondmateName: "infra",
        domain: "infra",
        status: "accepted",
        remoteTaskId,
        updatedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    // Fresh process memory (daemon restart) — rehydrate must CANCELLED the primary.
    const restarted = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await restarted.start();
    const after = restarted.tools.invoke("read_task", { taskId });
    expect(after.ok).toBe(true);
    expect((after.data as { phase: string }).phase).toBe("CANCELLED");
  });

  it("keeps pending handover on ambiguous POST failure; clears on definite refusal", async () => {
    const home = temp("agentos-p7-handover-pending-");
    mkdirSync(join(home, "config"), { recursive: true });
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await service.start();
    await service.provisionSecondmate({ name: "infra", domain: "infra" });
    const project = service.projects.register({
      name: "ambig",
      path: home,
      mode: "local-only",
      trusted: true,
    });
    const created = service.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "ambiguous fail",
        intent: "keep pending",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(created.ok).toBe(true);
    const taskId = (created.data as { id: string }).id;
    const handoverPath = join(home, "runs", taskId, "handover.json");

    const original = service.secondmateFleet.handoverTask.bind(service.secondmateFleet);
    service.secondmateFleet.handoverTask = async () => {
      throw new SecondmateHandoverError("simulated timeout after possible accept", undefined, false);
    };
    const ambiguous = await service.tools.invokeAsync("route_to_secondmate", {
      name: "infra",
      taskId,
      domain: "infra",
    });
    expect(ambiguous.ok).toBe(false);
    expect(existsSync(handoverPath)).toBe(true);
    const pending = JSON.parse(readFileSync(handoverPath, "utf8")) as {
      status: string;
      remoteTaskId: string | null;
    };
    expect(pending.status).toBe("pending");
    expect(pending.remoteTaskId).toBeNull();
    const afterAmbig = service.tools.invoke("read_task", { taskId });
    expect((afterAmbig.data as { phase: string }).phase).not.toBe("CANCELLED");

    // Capacity during redrive must NOT erase pending (remote may already own it).
    service.secondmateFleet.handoverTask = async () => {
      throw new SecondmateCapacityError("secondmate infra is at capacity (1/1 concurrent tasks)");
    };
    const capacityRedrive = await service.tools.invokeAsync("route_to_secondmate", {
      name: "infra",
      taskId,
      domain: "infra",
    });
    expect(capacityRedrive.ok).toBe(false);
    expect(existsSync(handoverPath)).toBe(true);

    // Clean 4xx on redrive is definite — clear pending.
    service.secondmateFleet.handoverTask = async () => {
      throw new SecondmateHandoverError("refused (HTTP 400)", { status: 400 }, true);
    };
    const refused = await service.tools.invokeAsync("route_to_secondmate", {
      name: "infra",
      taskId,
      domain: "infra",
    });
    expect(refused.ok).toBe(false);
    expect(existsSync(handoverPath)).toBe(false);

    // Fresh route capacity (no prior pending) clears the newly written pending.
    const created2 = service.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "fresh capacity",
        intent: "clear on definite capacity",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(created2.ok).toBe(true);
    const taskId2 = (created2.data as { id: string }).id;
    const handoverPath2 = join(home, "runs", taskId2, "handover.json");
    service.secondmateFleet.handoverTask = async () => {
      throw new SecondmateCapacityError("secondmate infra is at capacity (1/1 concurrent tasks)");
    };
    const capacityFresh = await service.tools.invokeAsync("route_to_secondmate", {
      name: "infra",
      taskId: taskId2,
      domain: "infra",
    });
    expect(capacityFresh.ok).toBe(false);
    expect(existsSync(handoverPath2)).toBe(false);

    service.secondmateFleet.handoverTask = original;
  });

  it("refuses retarget while pending handover claims the task", async () => {
    const home = temp("agentos-p7-handover-retarget-");
    mkdirSync(join(home, "config"), { recursive: true });
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await service.start();
    await service.provisionSecondmate({ name: "infra", domain: "infra" });
    await service.provisionSecondmate({ name: "docs", domain: "docs" });
    const project = service.projects.register({
      name: "retarget",
      path: home,
      mode: "local-only",
      trusted: true,
    });
    const created = service.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "pending retarget",
        intent: "must not retarget",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(created.ok).toBe(true);
    const taskId = (created.data as { id: string }).id;
    const handoverPath = join(home, "runs", taskId, "handover.json");

    const original = service.secondmateFleet.handoverTask.bind(service.secondmateFleet);
    service.secondmateFleet.handoverTask = async () => {
      throw new SecondmateHandoverError("simulated timeout after possible accept", undefined, false);
    };
    const ambiguous = await service.tools.invokeAsync("route_to_secondmate", {
      name: "infra",
      taskId,
      domain: "infra",
    });
    expect(ambiguous.ok).toBe(false);
    expect(existsSync(handoverPath)).toBe(true);
    const pendingBefore = JSON.parse(readFileSync(handoverPath, "utf8")) as {
      secondmateName: string;
      status: string;
    };
    expect(pendingBefore.secondmateName).toBe("infra");
    expect(pendingBefore.status).toBe("pending");

    let retargetCalled = false;
    service.secondmateFleet.handoverTask = async () => {
      retargetCalled = true;
      return { remoteTaskId: "01ARZ3NDEKTSV4RRFFQ69G5FHC" };
    };
    const retarget = await service.tools.invokeAsync("route_to_secondmate", {
      name: "docs",
      taskId,
      domain: "docs",
    });
    expect(retarget.ok).toBe(false);
    expect(retarget.error?.code).toBe("CONFLICT");
    expect(String(retarget.error?.message ?? "")).toContain("infra");
    expect(retargetCalled).toBe(false);
    const pendingAfter = JSON.parse(readFileSync(handoverPath, "utf8")) as {
      secondmateName: string;
      status: string;
    };
    expect(pendingAfter.secondmateName).toBe("infra");
    expect(pendingAfter.status).toBe("pending");

    service.secondmateFleet.handoverTask = original;
  });

  it("reconcile tick re-drives pending handovers (not boot-only)", async () => {
    const home = temp("agentos-p7-handover-tick-");
    mkdirSync(join(home, "config"), { recursive: true });
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: true,
      fakePi: true,
    });
    await service.start();
    await service.provisionSecondmate({ name: "infra", domain: "infra" });
    const project = service.projects.register({
      name: "tick",
      path: home,
      mode: "local-only",
      trusted: true,
    });
    const created = service.tools.invoke("create_task", {
      spec: {
        shape: "SHIP",
        title: "pending redrive",
        intent: "tick redrive",
        projectId: project.id,
        mode: "local-only",
        yolo: true,
      },
    });
    expect(created.ok).toBe(true);
    const taskId = (created.data as { id: string }).id;
    const remoteTaskId = "01ARZ3NDEKTSV4RRFFQ69G5FHD";
    mkdirSync(join(home, "runs", taskId), { recursive: true });
    writeFileSync(
      join(home, "runs", taskId, "handover.json"),
      `${JSON.stringify({
        taskId,
        secondmateName: "infra",
        domain: "infra",
        status: "pending",
        remoteTaskId: null,
        updatedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    let posts = 0;
    service.secondmateFleet.handoverTask = async () => {
      posts += 1;
      return { remoteTaskId };
    };

    // Public reconcile (same path as the heartbeat tick) must re-drive pending.
    service.reconcile();
    // Fire-and-forget on the tick — wait for the async redrive.
    for (let i = 0; i < 40; i++) {
      const phase = (service.tools.invoke("read_task", { taskId }).data as { phase: string })
        .phase;
      if (phase === "CANCELLED") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(posts).toBeGreaterThanOrEqual(1);
    const after = service.tools.invoke("read_task", { taskId });
    expect((after.data as { phase: string }).phase).toBe("CANCELLED");
    const rec = JSON.parse(
      readFileSync(join(home, "runs", taskId, "handover.json"), "utf8"),
    ) as { status: string; remoteTaskId: string };
    expect(rec.status).toBe("accepted");
    expect(rec.remoteTaskId).toBe(remoteTaskId);
  });
});

describe("secondmate api-key grants (non-copy)", () => {
  it("resolves grants from AGENTOS_SECRETS_HOME without writing under the secondmate home", async () => {
    const { writeApiKeyFile, resolveProviderKeyGrant, ConnectionRegistry } = await import(
      "../src/pi/connections.js"
    );
    const primary = temp("agentos-p7-secrets-primary-");
    const smHome = temp("agentos-p7-secrets-sm-");
    writeApiKeyFile(primary, "openai", "sk-primary-only");
    process.env.AGENTOS_SECRETS_HOME = primary;
    try {
      const registry = new ConnectionRegistry(smHome);
      registry.createConnection({
        provider: "openai",
        kind: "pi-api-key",
        billingMode: null,
      });
      const grant = resolveProviderKeyGrant(smHome, "openai/gpt-4.1", registry);
      expect(grant).toEqual({ name: "OPENAI_API_KEY", value: "sk-primary-only" });
      expect(existsSync(join(smHome, "secrets"))).toBe(false);
      expect(existsSync(join(primary, "secrets", "openai.key"))).toBe(true);
    } finally {
      delete process.env.AGENTOS_SECRETS_HOME;
    }
  });
});

