import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_PINNED_VERSION } from "@agent-os/protocol";
import { ConfigService } from "../src/config/service.js";
import { EXPECTED_EXTENSION_DIST, resolveExtensionPath, SHIPPED_DEFAULTS_DIR } from "../src/daemon.js";
import { FleetService } from "../src/fleet/service.js";
import { envPrefixedCommand } from "../src/fleet/tmux.js";
import {
  resolveProviderKeyGrant,
  writeApiKeyFile,
  ConnectionRegistry,
} from "../src/pi/connections.js";
import { buildPiSpawnSpec, type PiDetection } from "../src/pi/manager.js";
import { scrubEnv } from "../src/security/env-scrub.js";

/**
 * The harness contract: what actually reaches a spawned Pi, who may drive the
 * tool surface, and that a SCOUT's read-only promise is audited rather than
 * trusted. These assert real behaviour of the spawn/bridge path — the only
 * simulation is "don't launch a paid model".
 */

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = temp("agentos-harness-repo-");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git("config", "user.email", "harness@agent-os.test");
  git("config", "user.name", "Harness");
  writeFileSync(join(dir, "README.md"), "# harness fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

function fleet(options: { fakePi?: boolean } = {}): FleetService {
  const home = temp("agentos-harness-home-");
  mkdirSync(join(home, "config"), { recursive: true });
  const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
  config.installDefaults();
  const service = new FleetService({
    home,
    config,
    fakeTmux: true,
    fakeBrain: true,
    ...(options.fakePi === true ? { fakePi: true } : {}),
  });
  // Orchestration tools are blocked while the Brain is down; these cases are
  // about the harness, not about BRAIN_DOWN.
  service.start();
  return service;
}

/** Register a project, create a task, and resolve a single-role cast for it. */
function seedTask(
  service: FleetService,
  options: { name: string; shape: "SHIP" | "SCOUT"; role: "builder" | "scout"; model?: string },
): { taskId: string; model: string } {
  const model = options.model ?? "openai/gpt-4.1";
  const project = service.projects.register({
    name: options.name,
    path: gitRepo(),
    mode: "local-only",
    trusted: true,
  });
  const spec =
    options.shape === "SHIP"
      ? {
          shape: "SHIP" as const,
          title: "t",
          intent: "i",
          projectId: project.id,
          mode: "local-only" as const,
          yolo: true,
        }
      : {
          shape: "SCOUT" as const,
          title: "look",
          intent: "read only",
          projectId: project.id,
          mode: "local-only" as const,
        };
  const created = service.tools.invoke("create_task", { spec });
  expect(created.ok).toBe(true);
  const taskId = (created.data as { id: string }).id;
  const cast = service.tools.invoke("resolve_cast", {
    taskId,
    roles: [{ role: options.role, model, thinking: "low", cleanRoom: true }],
    familyCheckOverride: false,
  });
  expect(cast.ok).toBe(true);
  return { taskId, model };
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

describe("spawn env delivery", () => {
  it("starts from an empty environment and passes only the scrubbed pairs", () => {
    const scrubbed = scrubEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/captain",
        OPENAI_API_KEY: "sk-should-not-survive",
        ANTHROPIC_API_KEY: "sk-should-not-survive-either",
        SOME_UNRELATED_SECRET: "nope",
      },
      {
        grantProviderKey: { name: "OPENAI_API_KEY", value: "sk-granted" },
        extraAllow: { AGENTOS_SOCKET: "/tmp/s.sock", AGENTOS_ROLE: "builder" },
      },
    );
    const command = envPrefixedCommand(["/usr/local/bin/pi", "--mode", "json"], scrubbed.env);

    expect(command.startsWith("env -i ")).toBe(true);
    expect(command).toContain("AGENTOS_SOCKET=/tmp/s.sock");
    expect(command).toContain("AGENTOS_ROLE=builder");
    expect(command).toContain("OPENAI_API_KEY=sk-granted");
    expect(command).not.toContain("SOME_UNRELATED_SECRET");
    expect(command).not.toContain("sk-should-not-survive");
  });

  it("quotes values so a hostile path cannot break out of the command line", () => {
    const command = envPrefixedCommand(["pi"], { EVIL: "a'; rm -rf /; echo '" });
    expect(command).toContain(`EVIL='a'\\''; rm -rf /; echo '\\'''`);
  });

  it("api-key cast grant injects exactly one matching provider key; oauth cast grants none", () => {
    const home = temp("agentos-grant-");
    writeApiKeyFile(home, "openai", "sk-openai-cast-secret");
    const registry = new ConnectionRegistry(home);
    registry.createConnection({
      provider: "openai",
      kind: "pi-api-key",
      billingMode: null,
    });

    const apiGrant = resolveProviderKeyGrant(home, "openai/gpt-4.1", registry);
    expect(apiGrant).toEqual({
      name: "OPENAI_API_KEY",
      value: "sk-openai-cast-secret",
    });

    const detection: PiDetection = {
      binary: "/usr/local/bin/pi",
      version: PI_PINNED_VERSION,
      pinnedVersion: PI_PINNED_VERSION,
      versionMatchesPin: true,
      managedHome: join(home, "pi"),
      configDirEnv: "PI_CONFIG_DIR",
      isolationMode: "managed",
    };
    const apiSpec = buildPiSpawnSpec({
      agentosHome: home,
      detection,
      args: ["--mode", "json"],
      cwd: home,
      sessionId: "01JSESSGRANT000000000000001",
      role: "builder",
      socketPath: join(home, "s.sock"),
      extensionPath: join(home, "ext.js"),
      grantProviderKey: apiGrant,
    });
    expect(apiSpec.env.OPENAI_API_KEY).toBe("sk-openai-cast-secret");
    expect(apiSpec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(
      Object.keys(apiSpec.env).filter((k) => k.endsWith("_API_KEY") || k === "AWS_ACCESS_KEY_ID"),
    ).toEqual(["OPENAI_API_KEY"]);
    // Durable spawn manifest records key names only (values stay in runtime env).
    expect(apiSpec.envKeys).toContain("OPENAI_API_KEY");
    expect(apiSpec.envKeys).not.toContain("sk-openai-cast-secret");

    const oauthHome = temp("agentos-oauth-grant-");
    const oauthRegistry = new ConnectionRegistry(oauthHome);
    oauthRegistry.createConnection({
      provider: "openai",
      kind: "pi-oauth",
      billingMode: null,
    });
    const oauthGrant = resolveProviderKeyGrant(oauthHome, "openai/gpt-4.1", oauthRegistry);
    expect(oauthGrant).toBeNull();
    const oauthSpec = buildPiSpawnSpec({
      agentosHome: oauthHome,
      detection: { ...detection, managedHome: join(oauthHome, "pi") },
      args: ["--mode", "json"],
      cwd: oauthHome,
      sessionId: "01JSESSGRANT000000000000002",
      role: "builder",
      socketPath: join(oauthHome, "s.sock"),
      extensionPath: join(oauthHome, "ext.js"),
      grantProviderKey: oauthGrant,
    });
    expect(oauthSpec.env.OPENAI_API_KEY).toBeUndefined();
    expect(
      Object.keys(oauthSpec.env).filter((k) => k.endsWith("_API_KEY") || k === "AWS_ACCESS_KEY_ID"),
    ).toEqual([]);
  });
});

describe("missing Pi is an error, not a stub", () => {
  it("spawn_crewmate returns PI_UNAVAILABLE when Pi is not installed", () => {
    const service = fleet();
    const { taskId } = seedTask(service, { name: "harness", shape: "SHIP", role: "builder" });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(false);
    expect(spawned.error?.code).toBe("PI_UNAVAILABLE");
  });

  it("PI_UNAVAILABLE releases the worktree lease so the pool is not exhausted", () => {
    const service = fleet();
    const { taskId } = seedTask(service, { name: "pool-leak", shape: "SHIP", role: "builder" });

    for (let i = 0; i < 3; i++) {
      const spawned = service.tools.invoke("spawn_crewmate", {
        taskId,
        role: "builder",
        model: "openai/gpt-4.1",
        thinking: "low",
        vars: {},
      });
      expect(spawned.ok).toBe(false);
      expect(spawned.error?.code).toBe("PI_UNAVAILABLE");
    }

    const leased = service.worktrees.list().filter((l) => l.state === "leased");
    expect(leased).toHaveLength(0);
  });
});

describe("worktree idle reuse moves HEAD to the new branch", () => {
  it("after deliver + re-lease, git HEAD matches the new lease branch", () => {
    const service = fleet({ fakePi: true });
    const repo = gitRepo();
    const project = service.projects.register({
      name: "reuse",
      path: repo,
      mode: "local-only",
      trusted: true,
    });

    const create = (title: string): string => {
      const created = service.tools.invoke("create_task", {
        spec: {
          shape: "SHIP" as const,
          title,
          intent: "i",
          projectId: project.id,
          mode: "local-only" as const,
          yolo: true,
        },
      });
      expect(created.ok).toBe(true);
      const taskId = (created.data as { id: string }).id;
      const cast = service.tools.invoke("resolve_cast", {
        taskId,
        roles: [
          {
            role: "builder",
            model: "openai/gpt-4.1",
            thinking: "low",
            cleanRoom: true,
          },
        ],
        familyCheckOverride: false,
      });
      expect(cast.ok).toBe(true);
      return taskId;
    };

    const task1 = create("first");
    const spawn1 = service.tools.invoke("spawn_crewmate", {
      taskId: task1,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawn1.ok).toBe(true);
    const path = (spawn1.data as { session: { worktreePath: string } }).session.worktreePath;
    const branch1 = (spawn1.data as { task: { branch: string } }).task.branch;
    expect(
      execFileSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(branch1);

    writeFileSync(join(path, "change.txt"), "first task\n");
    execFileSync("git", ["-C", path, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", path, "commit", "-qm", "first task"], { stdio: "ignore" });

    const deliver = service.tools.invoke("deliver_task", { taskId: task1 });
    expect(deliver.ok).toBe(true);
    expect(service.worktrees.list().find((l) => l.path === path)?.state).toBe("idle");

    const task2 = create("second");
    const spawn2 = service.tools.invoke("spawn_crewmate", {
      taskId: task2,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawn2.ok).toBe(true);
    const path2 = (spawn2.data as { session: { worktreePath: string } }).session.worktreePath;
    const branch2 = (spawn2.data as { task: { branch: string } }).task.branch;
    expect(path2).toBe(path);
    expect(branch2).not.toBe(branch1);
    expect(
      execFileSync("git", ["-C", path2, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(branch2);
  });
});

describe("tool bridge authorization", () => {
  it("refuses orchestration tools from a session that is not the Brain", () => {
    const service = fleet({ fakePi: true });
    service.tools.setBrainSessionId("01JBR4N0000000000000000000");

    const refused = service.tools.invokeFromSession(
      "01JCREW0000000000000000000",
      "deliver_task",
      { taskId: "01JTASK0000000000000000000" },
    );
    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBe("UNAUTHORIZED_TOOL");

    const stow = service.tools.invokeFromSession(
      "01JCREW0000000000000000000",
      "stow_knowledge",
      {
        projectId: "01JPROJ0000000000000000000",
        notes: "crew must not write notes",
      },
    );
    expect(stow.ok).toBe(false);
    expect(stow.error?.code).toBe("UNAUTHORIZED_TOOL");

    // Read-only self-service is allowed — it fails on NOT_FOUND, not on authz.
    const allowed = service.tools.invokeFromSession(
      "01JCREW0000000000000000000",
      "read_task",
      { taskId: "01JTASK0000000000000000000" },
    );
    expect(allowed.error?.code).toBe("NOT_FOUND");

    const unknown = service.tools.invokeFromSession(
      "01JBR4N0000000000000000000",
      "definitely_not_a_tool",
      {},
    );
    expect(unknown.error?.code).toBe("VALIDATION_ERROR");
  });
});

describe("SCOUT read-only enforcement", () => {
  it("audits the worktree with git and quarantines a scout that wrote", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "scouted", shape: "SCOUT", role: "scout" });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "scout",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const session = (spawned.data as { session: { sessionId: string; worktreePath: string } }).session;

    // A clean scout passes the audit.
    expect(service.tools.auditScoutSession(session.sessionId).clean).toBe(true);

    // A scout that wrote is caught by the real git status, not by trust.
    writeFileSync(join(session.worktreePath, "sneaky.txt"), "I wrote this\n");
    const violation = service.tools.auditScoutSession(session.sessionId);
    expect(violation.clean).toBe(false);
    expect(violation.changedPaths.join(" ")).toContain("sneaky.txt");

    const lease = service.worktrees.list().find((l) => l.path === session.worktreePath);
    expect(lease?.state).toBe("quarantined");
  });

  it("fails closed when git status cannot verify the worktree", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "scout-audit-fail", shape: "SCOUT", role: "scout" });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "scout",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const session = (spawned.data as { session: { sessionId: string; worktreePath: string } }).session;

    // Destroy the git metadata so status cannot run — policy must not report clean.
    rmSync(join(session.worktreePath, ".git"), { recursive: true, force: true });
    const failed = service.tools.auditScoutSession(session.sessionId);
    expect(failed.clean).toBe(false);
    expect(failed.changedPaths.join(" ")).toMatch(/audit could not be performed/i);

    const lease = service.worktrees.list().find((l) => l.path === session.worktreePath);
    expect(lease?.state).toBe("quarantined");
  });
});

describe("worktree lease reclaim on stop/respawn", () => {
  it("stop/respawn cycles never exceed poolSize leased trees", () => {
    const service = fleet({ fakePi: true });
    const { taskId, model } = seedTask(service, {
      name: "respawn-pool",
      shape: "SHIP",
      role: "builder",
    });

    // Shipped default is 4; cycles beyond that must not exhaust the pool.
    const poolSize = 4;
    let sessionId: string | undefined;

    for (let i = 0; i < poolSize + 2; i++) {
      if (sessionId !== undefined) {
        const stopped = service.tools.invoke("stop_crewmate", {
          sessionId,
          reason: `cycle-${i}`,
        });
        expect(stopped.ok).toBe(true);
      }

      const spawn =
        sessionId === undefined
          ? service.tools.invoke("spawn_crewmate", {
              taskId,
              role: "builder",
              model,
              thinking: "low",
              vars: {},
            })
          : service.tools.invoke("respawn_crewmate", {
              sessionId,
              reason: `cycle-${i}`,
            });
      expect(spawn.ok).toBe(true);
      sessionId = (spawn.data as { session: { sessionId: string } }).session.sessionId;

      const leased = service.worktrees.list().filter((l) => l.state === "leased");
      expect(leased.length).toBeLessThanOrEqual(poolSize);
      expect(leased.length).toBe(1);
    }
  });

  it("respawns after dirty stop that quarantined the task branch", () => {
    const service = fleet({ fakePi: true });
    const { taskId, model } = seedTask(service, {
      name: "dirty-respawn",
      shape: "SHIP",
      role: "builder",
    });

    const first = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model,
      thinking: "low",
      vars: {},
    });
    expect(first.ok).toBe(true);
    const session = (
      first.data as { session: { sessionId: string; worktreePath: string } }
    ).session;

    // Dirty the tree so stop → release quarantines while still holding the task branch.
    writeFileSync(join(session.worktreePath, "wip.txt"), "uncommitted builder work\n");
    const stopped = service.tools.invoke("stop_crewmate", {
      sessionId: session.sessionId,
      reason: "session lost dirty",
    });
    expect(stopped.ok).toBe(true);
    const quarantined = service.worktrees
      .list()
      .filter((l) => l.state === "quarantined" && l.path === session.worktreePath);
    expect(quarantined).toHaveLength(1);

    const respawn = service.tools.invoke("respawn_crewmate", {
      sessionId: session.sessionId,
      reason: "recover after quarantine",
    });
    expect(respawn.ok).toBe(true);
    const next = (
      respawn.data as { session: { worktreePath: string; sessionId: string } }
    ).session;
    expect(next.worktreePath).not.toBe(session.worktreePath);
    expect(
      execFileSync("git", ["-C", next.worktreePath, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("true");
    // Prior uncommitted work must still be intact under quarantine.
    expect(readFileSync(join(session.worktreePath, "wip.txt"), "utf8")).toContain(
      "uncommitted builder work",
    );
  });
});

describe("deliver_task dirty worktree fail-closed", () => {
  it("quarantines and preserves uncommitted files instead of resetting", () => {
    const service = fleet({ fakePi: true });
    const { taskId, model } = seedTask(service, {
      name: "dirty-deliver",
      shape: "SHIP",
      role: "builder",
    });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model,
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const path = (spawned.data as { session: { worktreePath: string } }).session.worktreePath;

    writeFileSync(join(path, "builder-wip.txt"), "must not be discarded\n");

    const deliver = service.tools.invoke("deliver_task", { taskId });
    expect(deliver.ok).toBe(false);
    expect(deliver.error?.code).toBe("CONFLICT");

    const lease = service.worktrees.list().find((l) => l.path === path);
    expect(lease?.state).toBe("quarantined");
    expect(readFileSync(join(path, "builder-wip.txt"), "utf8")).toContain(
      "must not be discarded",
    );

    const task = service.tools.invoke("read_task", { taskId });
    expect(task.ok).toBe(true);
    expect((task.data as { phase: string }).phase).not.toBe("DONE");
  });

  it("refuses a second deliver_task after dirty quarantine (never reaches DONE)", () => {
    const service = fleet({ fakePi: true });
    const { taskId, model } = seedTask(service, {
      name: "dirty-deliver-retry",
      shape: "SHIP",
      role: "builder",
    });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model,
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const path = (spawned.data as { session: { worktreePath: string } }).session.worktreePath;
    writeFileSync(join(path, "builder-wip.txt"), "still uncommitted\n");

    const first = service.tools.invoke("deliver_task", { taskId });
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("CONFLICT");

    const second = service.tools.invoke("deliver_task", { taskId });
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe("CONFLICT");

    const task = service.tools.invoke("read_task", { taskId });
    expect(task.ok).toBe(true);
    const snap = task.data as {
      phase: string;
      deliveryBlocked: { leaseId: string; reason: string } | null;
    };
    expect(snap.phase).not.toBe("DONE");
    expect(snap.phase).toBe("DELIVERING");
    expect(snap.deliveryBlocked).not.toBeNull();
    expect(snap.deliveryBlocked?.reason).toContain("uncommitted");

    // delivery.json must not exist for a refused delivery
    const marker = `${sep}worktrees${sep}`;
    const homeIdx = path.indexOf(marker);
    expect(homeIdx).toBeGreaterThan(0);
    const home = path.slice(0, homeIdx);
    expect(() => readFileSync(join(home, "runs", taskId, "delivery.json"), "utf8")).toThrow();
  });
});

describe("delivery invariant choke points", () => {
  it("stamps deliveryBlocked when stop_crewmate quarantines a dirty tree", () => {
    const service = fleet({ fakePi: true });
    const { taskId, model } = seedTask(service, {
      name: "dirty-stop-block",
      shape: "SHIP",
      role: "builder",
    });

    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model,
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const session = (spawned.data as { session: { sessionId: string; worktreePath: string } })
      .session;
    writeFileSync(join(session.worktreePath, "wip.txt"), "uncommitted after stop\n");

    const stopped = service.tools.invoke("stop_crewmate", {
      sessionId: session.sessionId,
      reason: "captain stop",
    });
    expect(stopped.ok).toBe(true);

    const lease = service.worktrees.list().find((l) => l.path === session.worktreePath);
    expect(lease?.state).toBe("quarantined");

    const task = service.tools.invoke("read_task", { taskId });
    expect(task.ok).toBe(true);
    const snap = task.data as {
      phase: string;
      deliveryBlocked: { leaseId: string; reason: string } | null;
    };
    expect(snap.phase).not.toBe("DONE");
    expect(snap.deliveryBlocked).not.toBeNull();

    const deliver = service.tools.invoke("deliver_task", { taskId });
    expect(deliver.ok).toBe(false);
    expect(deliver.error?.code).toBe("CONFLICT");
    expect((service.tools.invoke("read_task", { taskId }).data as { phase: string }).phase).not.toBe(
      "DONE",
    );
  });

  it("refuses advance_phase to DONE in favour of deliver_task", () => {
    const service = fleet({ fakePi: true });
    const { taskId, model } = seedTask(service, {
      name: "advance-done-block",
      shape: "SHIP",
      role: "builder",
    });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model,
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);

    const toDelivering = service.tools.invoke("advance_phase", {
      taskId,
      to: "DELIVERING",
      reason: "brain shortcut",
    });
    expect(toDelivering.ok).toBe(true);

    const toDone = service.tools.invoke("advance_phase", {
      taskId,
      to: "DONE",
      reason: "skip deliver_task",
    });
    expect(toDone.ok).toBe(false);
    expect(toDone.error?.code).toBe("ILLEGAL_TRANSITION");
    expect(toDone.error?.message).toContain("deliver_task");
    expect((service.tools.invoke("read_task", { taskId }).data as { phase: string }).phase).toBe(
      "DELIVERING",
    );
  });

  it("refuses advance_phase to DONE while a dirty tree is outstanding", () => {
    const service = fleet({ fakePi: true });
    const { taskId, model } = seedTask(service, {
      name: "advance-dirty-done",
      shape: "SHIP",
      role: "builder",
    });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model,
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const session = (spawned.data as { session: { sessionId: string; worktreePath: string } })
      .session;
    writeFileSync(join(session.worktreePath, "wip.txt"), "still dirty\n");

    const stopped = service.tools.invoke("stop_crewmate", {
      sessionId: session.sessionId,
      reason: "lost",
    });
    expect(stopped.ok).toBe(true);

    const toDelivering = service.tools.invoke("advance_phase", {
      taskId,
      to: "DELIVERING",
      reason: "try deliver via phase",
    });
    // BUILDING → DELIVERING is legal on the state machine; DONE is not via advance_phase.
    if (toDelivering.ok) {
      const toDone = service.tools.invoke("advance_phase", {
        taskId,
        to: "DONE",
        reason: "bypass dirty",
      });
      expect(toDone.ok).toBe(false);
      expect(toDone.error?.code).toBe("ILLEGAL_TRANSITION");
    } else {
      // SESSION_LOST path after stop may already have moved phase — still refuse DONE.
      const toDone = service.tools.invoke("advance_phase", {
        taskId,
        to: "DONE",
        reason: "bypass dirty",
      });
      expect(toDone.ok).toBe(false);
      expect(toDone.error?.code).toBe("ILLEGAL_TRANSITION");
    }

    const deliver = service.tools.invoke("deliver_task", { taskId });
    expect(deliver.ok).toBe(false);
    expect(deliver.error?.code).toMatch(/CONFLICT|ILLEGAL_TRANSITION/);
    expect((service.tools.invoke("read_task", { taskId }).data as { phase: string }).phase).not.toBe(
      "DONE",
    );
  });

  it("refuses advance_phase to CANCELLED in favour of cancel_task", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, {
      name: "advance-cancel-block",
      shape: "SHIP",
      role: "builder",
    });
    const cancelled = service.tools.invoke("advance_phase", {
      taskId,
      to: "CANCELLED",
      reason: "skip cancel_task",
    });
    expect(cancelled.ok).toBe(false);
    expect(cancelled.error?.code).toBe("ILLEGAL_TRANSITION");
    expect(cancelled.error?.message).toContain("cancel_task");
  });
});

describe("resolveExtensionPath fail-closed", () => {
  it("returns undefined when no built extension dist exists on the candidate paths", () => {
    // When the monorepo dist is present this still documents the contract: the
    // function never invents a non-existent path. A missing first candidate is
    // covered by the existsSync gate; if neither candidate exists, result is undefined.
    const resolved = resolveExtensionPath();
    if (resolved !== undefined) {
      expect(existsSync(resolved)).toBe(true);
    } else {
      expect(existsSync(EXPECTED_EXTENSION_DIST)).toBe(false);
    }
  });
});

describe("brain pane death reconcile", () => {
  it("respawns the Brain when its tmux window is gone", () => {
    const service = fleet({ fakePi: true });
    const before = service.brain.getSnapshot();
    expect(before.status).toBe("running");
    expect(before.tmuxWindow).not.toBeNull();
    const priorSession = before.sessionId;
    const window = before.tmuxWindow!;
    service.tmux.killWindow(window);
    expect(service.tmux.hasWindow(window)).toBe(false);

    service.reconcile();

    const after = service.brain.getSnapshot();
    expect(after.status).toBe("running");
    expect(after.sessionId).not.toBe(priorSession);
    expect(after.lastReconcileAt).not.toBeNull();
    expect(after.tmuxWindow).not.toBeNull();
    expect(service.tmux.hasWindow(after.tmuxWindow!)).toBe(true);
  });
});

describe("send_to_crew delivery", () => {
  it("throws CONFLICT when both inject and send-keys fail", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "dead-channels", shape: "SHIP", role: "builder" });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(spawned.ok).toBe(true);
    const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;

    // No session sockets in the harness; force tmux fallback dead too.
    const original = service.tmux.sendKeys.bind(service.tmux);
    service.tmux.sendKeys = (): void => {
      throw new Error("tmux channel dead");
    };
    try {
      const result = service.tools.invoke("send_to_crew", {
        sessionId,
        message: "gate FAIL: verbatim lines must not report success undelivered",
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CONFLICT");
    } finally {
      service.tmux.sendKeys = original;
    }
  });
});

describe("worktree verified-reset fail-closed", () => {
  it("quarantines when git status cannot prove the tree clean", async () => {
    const { WorktreePool } = await import("../src/fleet/worktree-pool.js");
    const home = temp("agentos-wt-fail-");
    const pool = new WorktreePool(home, {
      poolSize: 4,
      reclaimPolicy: "verified-reset",
    });
    const projectId = "01JPROJ0000000000000000001";
    const taskId = "01JTASK0000000000000000001";
    const sessionId = "01JSESS0000000000000000001";
    const prev = process.env.AGENTOS_FAKE_GIT;
    process.env.AGENTOS_FAKE_GIT = "1";
    let lease;
    try {
      lease = pool.lease({
        projectId,
        repoPath: home,
        taskId,
        sessionId,
        branch: "ao/test",
      });
    } finally {
      if (prev === undefined) delete process.env.AGENTOS_FAKE_GIT;
      else process.env.AGENTOS_FAKE_GIT = prev;
    }
    // Marker directory has no real git — status fails, so release must quarantine.
    const released = pool.release(lease.id, {});
    expect(released.state).toBe("quarantined");
    expect(released.quarantineReason ?? "").toMatch(/git status|not a git|exit/i);
  });
});

describe("crewmate questions", () => {
  it("routes an answer back to the session that asked", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "asker", shape: "SHIP", role: "builder" });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;

    const questionId = "01JQ5T0000000000000000000A";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Which migration should I target?",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listQuestions()).toHaveLength(1);

    // Fake tmux accepts send-keys, so the fallback channel delivers.
    const answered = service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "Target 0007_add_index.",
    });
    expect(answered.ok).toBe(true);
    expect(service.tools.listQuestions()).toHaveLength(0);

    const unknown = service.tools.invoke("answer_crewmate", {
      questionId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      answer: "hello",
    });
    expect(unknown.error?.code).toBe("NOT_FOUND");
  });

  it("keeps a pending question retryable when delivery fails", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "retry-ask", shape: "SHIP", role: "builder" });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;

    const questionId = "01JQ5T0000000000000000000B";
    service.handleExtensionFrame({
      type: "ext.question",
      sessionId,
      questionId,
      question: "Need a decision before continuing.",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listQuestions()).toHaveLength(1);

    const original = service.tmux.sendKeys.bind(service.tmux);
    service.tmux.sendKeys = (): void => {
      throw new Error("tmux channel dead");
    };
    try {
      const failed = service.tools.invoke("answer_crewmate", {
        questionId,
        answer: "Ship the migration as-is.",
      });
      expect(failed.ok).toBe(false);
      expect(failed.error?.code).toBe("CONFLICT");
      expect(service.tools.listQuestions()).toHaveLength(1);
      expect(service.tools.listQuestions()[0]?.questionId).toBe(questionId);
    } finally {
      service.tmux.sendKeys = original;
    }

    const retried = service.tools.invoke("answer_crewmate", {
      questionId,
      answer: "Ship the migration as-is.",
    });
    expect(retried.ok).toBe(true);
    expect(service.tools.listQuestions()).toHaveLength(0);
  });
});

describe("stow_knowledge path jail", () => {
  it("rejects path traversal and keeps notes under docs/notes", () => {
    const service = fleet({ fakePi: true });
    const project = service.projects.register({
      name: "stow-jail",
      path: gitRepo(),
      mode: "local-only",
      trusted: true,
    });

    const traversal = service.tools.invoke("stow_knowledge", {
      projectId: project.id,
      notes: "should never land outside the jail",
      relativePath: "docs/notes/../../secrets.env",
    });
    expect(traversal.ok).toBe(false);
    expect(["VALIDATION_ERROR", "POLICY_VIOLATION"]).toContain(traversal.error?.code);

    const ok = service.tools.invoke("stow_knowledge", {
      projectId: project.id,
      notes: "safe note",
      relativePath: "docs/notes/safe-note.md",
    });
    expect(ok.ok).toBe(true);
    const written = (ok.data as { path: string }).path;
    expect(written.startsWith(join(project.path, "docs", "notes"))).toBe(true);
  });
});

describe("brain spawn failure", () => {
  it("enters BRAIN_DOWN and clears authorized session when Pi spawn fails", () => {
    const home = temp("agentos-brain-spawn-");
    mkdirSync(join(home, "config"), { recursive: true });
    // Extension must exist on disk so spawn reaches tmux (missing dist fails closed earlier).
    const extensionPath = join(home, "extension.js");
    writeFileSync(extensionPath, "export default {};\n");
    const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
    config.installDefaults();

    let closedSessionId: string | null = null;
    const service = new FleetService({
      home,
      config,
      fakeTmux: true,
      fakeBrain: false,
      pi: {
        binary: "/usr/bin/true",
        version: PI_PINNED_VERSION,
        pinnedVersion: PI_PINNED_VERSION,
        versionMatchesPin: true,
        managedHome: join(home, "pi"),
        configDirEnv: "PI_CONFIG_DIR",
        isolationMode: "managed",
      },
      extensionPath,
      sockets: {
        sessionSocketPath: (sessionId) => join(home, "sockets", `${sessionId}.sock`),
        openSession: (sessionId) => join(home, "sockets", `${sessionId}.sock`),
        closeSession: async (sessionId) => {
          closedSessionId = sessionId;
        },
        sendControl: () => false,
      },
    });

    service.tmux.newWindow = (): never => {
      throw new Error("tmux refused window");
    };

    const snap = service.brain.start("api");
    expect(snap.status).toBe("down");
    expect(service.tools.isBrainDown()).toBe(true);
    expect(snap.sessionId).not.toBeNull();
    expect(closedSessionId).toBe(snap.sessionId);

    const forged = service.tools.invokeFromSession(snap.sessionId as string, "spawn_crewmate", {
      taskId: "01JTASK0000000000000000000",
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    expect(forged.ok).toBe(false);
    expect(forged.error?.code).toBe("UNAUTHORIZED_TOOL");
  });
});

describe("extension lifecycle drives session state", () => {
  it("marks a session settled on agent_settled and absorbs PROGRESS", () => {
    const service = fleet({ fakePi: true });
    const { taskId } = seedTask(service, { name: "lifecycle", shape: "SHIP", role: "builder" });
    const spawned = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "openai/gpt-4.1",
      thinking: "low",
      vars: {},
    });
    const sessionId = (spawned.data as { session: { sessionId: string } }).session.sessionId;

    service.handleExtensionFrame({
      type: "ext.lifecycle",
      sessionId,
      phase: "session_start",
      detail: null,
      ts: new Date().toISOString(),
    });
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "running",
    );

    service.handleExtensionFrame({
      type: "ext.lifecycle",
      sessionId,
      phase: "agent_settled",
      detail: "done",
      ts: new Date().toISOString(),
    });
    expect(service.tools.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe(
      "settled",
    );
  });
});
