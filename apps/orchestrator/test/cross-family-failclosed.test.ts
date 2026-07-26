import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../src/config/service.js";
import { SHIPPED_DEFAULTS_DIR } from "../src/daemon.js";
import { FleetService } from "../src/fleet/service.js";

/**
 * Production-path fail-closed coverage for unknown-origin cross-family casts.
 *
 * Library-only tests of `familiesConflict` can stay green while resolve_cast and
 * spawn_crewmate still compare family labels with `===` / Set.has — the hole
 * this suite pins. Cases (a)/(b) must refuse amazon-bedrock paired with
 * anthropic; (c) keeps genuine two-family casts open; (d) keeps the override.
 */

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function gitRepo(): string {
  const dir = temp("agentos-xffc-repo-");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  };
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  git("config", "user.email", "xffc@agent-os.test");
  git("config", "user.name", "XFFC");
  writeFileSync(join(dir, "README.md"), "# xffc fixture\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
  return dir;
}

async function fleet(): Promise<FleetService> {
  const home = temp("agentos-xffc-home-");
  mkdirSync(join(home, "config"), { recursive: true });
  const config = new ConfigService(SHIPPED_DEFAULTS_DIR, join(home, "config"));
  config.installDefaults();
  config.writeGlobal("policies", "{ redBaselineGateRequired: false }\n");
  const service = new FleetService({
    home,
    config,
    fakeTmux: true,
    fakeBrain: true,
    fakePi: true,
  });
  await service.start();
  return service;
}

function createTask(service: FleetService): string {
  const project = service.projects.register({
    name: "xffc",
    path: gitRepo(),
    mode: "local-only",
    trusted: true,
  });
  const created = service.tools.invoke("create_task", {
    spec: {
      shape: "SHIP",
      title: "cross-family fail-closed",
      intent: "prove production path refuses unknown origin",
      projectId: project.id,
      mode: "local-only",
      yolo: true,
    },
  });
  expect(created.ok).toBe(true);
  return (created.data as { id: string }).id;
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

describe("resolve_cast production fail-closed (unknown origin)", () => {
  it("(a) refuses amazon-bedrock builder with anthropic validator", async () => {
    const service = await fleet();
    const taskId = createTask(service);

    const result = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        {
          role: "builder",
          model: "amazon-bedrock/anthropic.claude-3-5-sonnet",
          thinking: "medium",
          cleanRoom: true,
        },
        {
          role: "validator",
          model: "anthropic/claude-sonnet-4-5",
          thinking: "medium",
          cleanRoom: true,
        },
      ],
      familyCheckOverride: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("POLICY_VIOLATION");
  });

  it("(a) refuses anthropic builder with amazon-bedrock validator", async () => {
    const service = await fleet();
    const taskId = createTask(service);

    const result = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        {
          role: "builder",
          model: "anthropic/claude-sonnet-4-5",
          thinking: "medium",
          cleanRoom: true,
        },
        {
          role: "validator",
          model: "amazon-bedrock/anthropic.claude-3-5-sonnet",
          thinking: "medium",
          cleanRoom: true,
        },
      ],
      familyCheckOverride: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("POLICY_VIOLATION");
  });

  it("(c) accepts two genuinely different known families", async () => {
    const service = await fleet();
    const taskId = createTask(service);

    const result = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        {
          role: "builder",
          model: "openai/gpt-4.1",
          thinking: "medium",
          cleanRoom: true,
        },
        {
          role: "validator",
          model: "anthropic/claude-sonnet-4-5",
          thinking: "medium",
          cleanRoom: true,
        },
      ],
      familyCheckOverride: false,
    });

    expect(result.ok).toBe(true);
  });

  it("(d) familyCheckOverride permits unknown-origin cast", async () => {
    const service = await fleet();
    const taskId = createTask(service);

    const result = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        {
          role: "builder",
          model: "amazon-bedrock/anthropic.claude-3-5-sonnet",
          thinking: "medium",
          cleanRoom: true,
        },
        {
          role: "validator",
          model: "anthropic/claude-sonnet-4-5",
          thinking: "medium",
          cleanRoom: true,
        },
      ],
      familyCheckOverride: true,
    });

    expect(result.ok).toBe(true);
  });
});

describe("spawn_crewmate production fail-closed (unknown origin)", () => {
  it("(b) refuses bedrock validator when builder cast is anthropic", async () => {
    const service = await fleet();
    const taskId = createTask(service);

    // Seed only the builder on the cast — bypass resolve_cast pair check so the
    // spawn re-check is the enforcement point under test.
    const seeded = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        {
          role: "builder",
          model: "anthropic/claude-sonnet-4-5",
          thinking: "medium",
          cleanRoom: true,
        },
      ],
      familyCheckOverride: false,
    });
    expect(seeded.ok).toBe(true);

    const spawn = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "validator",
      model: "amazon-bedrock/anthropic.claude-3-5-sonnet",
      thinking: "medium",
      cleanRoom: true,
      vars: {},
    });

    expect(spawn.ok).toBe(false);
    expect(spawn.error?.code).toBe("POLICY_VIOLATION");
  });

  it("(b) refuses bedrock builder when validator cast is anthropic", async () => {
    const service = await fleet();
    const taskId = createTask(service);

    const seeded = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        {
          role: "validator",
          model: "anthropic/claude-sonnet-4-5",
          thinking: "medium",
          cleanRoom: true,
        },
      ],
      familyCheckOverride: false,
    });
    expect(seeded.ok).toBe(true);

    const spawn = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "builder",
      model: "amazon-bedrock/anthropic.claude-3-5-sonnet",
      thinking: "medium",
      cleanRoom: true,
      vars: {},
      redBaselineOverride: true,
    });

    expect(spawn.ok).toBe(false);
    expect(spawn.error?.code).toBe("POLICY_VIOLATION");
  });

  it("(c) accepts spawn of a different known family opposite seat", async () => {
    const service = await fleet();
    const taskId = createTask(service);

    const seeded = service.tools.invoke("resolve_cast", {
      taskId,
      roles: [
        {
          role: "builder",
          model: "openai/gpt-4.1",
          thinking: "medium",
          cleanRoom: true,
        },
      ],
      familyCheckOverride: false,
    });
    expect(seeded.ok).toBe(true);

    const spawn = service.tools.invoke("spawn_crewmate", {
      taskId,
      role: "validator",
      model: "anthropic/claude-sonnet-4-5",
      thinking: "medium",
      cleanRoom: true,
      vars: {},
    });

    expect(spawn.ok).toBe(true);
  });
});
