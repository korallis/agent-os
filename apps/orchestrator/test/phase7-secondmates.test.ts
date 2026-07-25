import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrossProcessAuthBroker } from "../src/pi/cross-process-broker.js";
import { PiAuthBroker } from "../src/pi/auth-broker.js";
import { SecondmateRegistry } from "../src/fleet/secondmates.js";
import { SecondmateFleet } from "../src/fleet/secondmate-fleet.js";

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
  it("withSpawnGrantSync acquires the cross-process lock", () => {
    const dir = temp("agentos-p7-choke-");
    const piHome = join(dir, "pi");
    mkdirSync(join(piHome, "agent"), { recursive: true });
    const broker = PiAuthBroker.forManagedHome(piHome);
    const peer = new CrossProcessAuthBroker(join(piHome, "agent"));

    let ran = false;
    broker.withSpawnGrantSync(() => {
      ran = true;
      // While held, a peer process cannot acquire.
      expect(peer.tryAcquire("peer")).toBe(false);
    });
    expect(ran).toBe(true);
    expect(peer.tryAcquire("peer")).toBe(true);
    peer.release();
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

