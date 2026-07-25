import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrossProcessAuthBroker } from "../src/pi/cross-process-broker.js";
import { PiAuthBroker } from "../src/pi/auth-broker.js";
import { SecondmateRegistry } from "../src/fleet/secondmates.js";
import { SecondmateFleet } from "../src/fleet/secondmate-fleet.js";
import { FleetService } from "../src/fleet/service.js";
import { ConfigService } from "../src/config/service.js";
import { SHIPPED_DEFAULTS_DIR } from "../src/daemon.js";

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
});

describe("secondmate homes", () => {
  it("provisions an isolated home carrying no auth material", () => {
    const home = temp("agentos-p7-home-");
    const registry = new SecondmateRegistry(home);
    const record = registry.provision({ name: "infra", domain: "infra" });

    expect(record.home).toContain("secondmates");
    expect(existsSync(join(record.home, "config"))).toBe(true);
    // The whole point: a secondmate never holds credentials of its own.
    expect(existsSync(join(record.home, "auth.json"))).toBe(false);
    expect(existsSync(join(record.home, "secrets"))).toBe(false);
    expect(registry.auditNoAuthMaterial().ok).toBe(true);
  });

  it("refuses a duplicate name rather than clobbering an existing home", () => {
    const home = temp("agentos-p7-dupe-");
    const registry = new SecondmateRegistry(home);
    registry.provision({ name: "docs", domain: "docs" });
    expect(() => registry.provision({ name: "docs", domain: "docs" })).toThrow(/already exists/);
  });

  it("fails the audit when auth material appears under a secondmate home", () => {
    const home = temp("agentos-p7-audit-");
    const registry = new SecondmateRegistry(home);
    const record = registry.provision({ name: "leaky", domain: "x" });
    writeFileSync(join(record.home, "daemon.token"), "should-not-be-here\n");

    const audit = registry.auditNoAuthMaterial();
    expect(audit.ok).toBe(false);
    expect(audit.offenders.join(" ")).toContain("daemon.token");
  });

  it("keeps runtime tokens outside the audited secondmate home", () => {
    const home = temp("agentos-p7-token-out-");
    const registry = new SecondmateRegistry(home);
    const record = registry.provision({ name: "infra", domain: "infra" });
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
  it("routes by domain and honours a charter that declines routing", () => {
    const home = temp("agentos-p7-route-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);

    const infra = registry.provision({ name: "infra", domain: "infra" });
    registry.provision({ name: "docs", domain: "docs" });

    expect(fleet.routeFor("infra")?.name).toBe("infra");
    expect(fleet.routeFor("docs")?.name).toBe("docs");
    // No destination is invented for an unknown domain.
    expect(fleet.routeFor("kernel")).toBeNull();

    fleet.writeCharter(infra, {
      name: "infra",
      domains: ["infra"],
      brainModel: "anthropic/claude-fable-5",
      maxConcurrentTasks: 2,
      acceptsRouting: false,
    });
    expect(fleet.routeFor("infra")).toBeNull();
  });

  it("reads a charter edit back — the charter is config, not code", () => {
    const home = temp("agentos-p7-charter-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);
    const record = registry.provision({ name: "infra", domain: "infra" });

    fleet.writeCharter(record, {
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

  it("falls back to the provision record when a charter is malformed", () => {
    const home = temp("agentos-p7-bad-charter-");
    const registry = new SecondmateRegistry(home);
    const fleet = new SecondmateFleet(registry);
    const record = registry.provision({ name: "infra", domain: "infra" });
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
    registry.provision({ name: "infra", domain: "infra" });

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
    const record = registry.provision({ name: "infra", domain: "infra" });

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
});

