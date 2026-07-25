import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SHIPPED_PROMPTS_DIR } from "../src/daemon.js";
import { PromptService, PromptResolutionError } from "../src/prompts/service.js";
import { SessionKeyStore } from "../src/fleet/sessions.js";
import { FusionRunStore } from "../src/fleet/fusion-runs.js";

/**
 * Phase 4 units: layered prompt packs, per-model session keys, and the fusion
 * run store that carries the clean-room proof.
 */

const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function prompts(): { service: PromptService; globalDir: string } {
  const home = temp("agentos-p4-prompts-");
  const globalDir = join(home, "prompts");
  mkdirSync(globalDir, { recursive: true });
  const service = new PromptService(SHIPPED_PROMPTS_DIR, globalDir);
  service.installDefaults();
  return { service, globalDir };
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

describe("prompt packs", () => {
  it("installs shipped templates into the editable global layer", () => {
    const { service, globalDir } = prompts();
    const info = service.resolve("fusion/fusion.md");
    expect(info.layer).toBe("global");
    expect(info.customized).toBe(false);
    expect(readFileSync(join(globalDir, "fusion", "fusion.md"), "utf8")).toContain("[ARCHITECT]");
  });

  it("renders {{VAR}} and refuses an undefined variable rather than half-rendering", () => {
    const { service } = prompts();
    const rendered = service.render("fusion/opinion.md", {
      QUESTION: "Ship it?",
      CONTEXT: "Small diff.",
    });
    expect(rendered.rendered).toContain("Ship it?");
    expect(rendered.renderedHash).toHaveLength(64);

    expect(() => service.render("fusion/opinion.md", { QUESTION: "only one" })).toThrow(
      /CONTEXT/,
    );
  });

  it("lets a project layer override global", () => {
    const { service } = prompts();
    const projectDir = temp("agentos-p4-project-");
    mkdirSync(join(projectDir, "fusion"), { recursive: true });
    writeFileSync(join(projectDir, "fusion", "opinion.md"), "project {{QUESTION}}\n");

    const info = service.resolve("fusion/opinion.md", projectDir);
    expect(info.layer).toBe("project");
    expect(service.render("fusion/opinion.md", { QUESTION: "x" }, projectDir).rendered).toBe(
      "project x\n",
    );
  });

  it("detects customization and serves three-way diff data", () => {
    const { service, globalDir } = prompts();
    expect(service.resolve("fusion/fusion.md").customized).toBe(false);

    const path = join(globalDir, "fusion", "fusion.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n\nMY EDIT\n`);

    expect(service.resolve("fusion/fusion.md").customized).toBe(true);
    const diff = service.threeWayDiff("fusion/fusion.md");
    expect(diff.customized).toBe(true);
    expect(diff.shippedAtInstall).toHaveLength(64);
    expect(diff.yours).toContain("MY EDIT");
  });

  it("rejects traversal and non-markdown refs", () => {
    const { service } = prompts();
    for (const ref of ["../../etc/passwd.md", "fusion/../../x.md", "fusion/notes.txt", ""]) {
      expect(() => service.resolve(ref)).toThrow(PromptResolutionError);
    }
  });
});

describe("session keys", () => {
  it("gives a different directory per model so transcripts never cross families", () => {
    const store = new SessionKeyStore(temp("agentos-p4-sessions-"));
    const anthropic = store.ensure({
      projectId: "P",
      role: "planner",
      model: "anthropic/claude-fable-5",
    });
    const openai = store.ensure({
      projectId: "P",
      role: "planner",
      model: "openai/gpt-5.6-sol",
    });
    expect(anthropic.dir).not.toBe(openai.dir);

    // Same triple resumes the same directory rather than forking a new one.
    expect(
      store.ensure({ projectId: "P", role: "planner", model: "anthropic/claude-fable-5" }).dir,
    ).toBe(anthropic.dir);
    expect(store.list()).toHaveLength(2);
  });

  it("reports only the roles a restart must respawn", () => {
    const store = new SessionKeyStore(temp("agentos-p4-missing-"));
    store.ensure({ projectId: "P", role: "planner", model: "anthropic/claude-fable-5" });

    const missing = store.missingRoles("P", [
      { role: "planner", model: "anthropic/claude-fable-5" },
      { role: "planner", model: "openai/gpt-5.6-sol" },
    ]);
    expect(missing).toEqual([{ role: "planner", model: "openai/gpt-5.6-sol" }]);
  });
});

describe("fusion run store", () => {
  it("accumulates per-side telemetry and parses attribution spans", () => {
    const home = temp("agentos-p4-runs-");
    const store = new FusionRunStore(home);
    const run = {
      runId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      taskId: "01JTASK0000000000000000000",
      kind: "opinion" as const,
      templateRef: "fusion/opinion.md",
      templateLayer: "global" as const,
      templateHash: "h",
      renderedHash: "r",
      promptsIdentical: true,
      sides: [
        {
          role: "planner",
          model: "anthropic/claude-fable-5",
          family: "anthropic" as const,
          sessionId: "01JSESSION000000000000000A",
          promptHash: "same",
          artifactPath: null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        },
      ],
      aggregatorFamily: "anthropic" as const,
      contractOk: null,
      createdAt: new Date().toISOString(),
    };
    store.create(run);
    store.recordSideUsage(run.taskId, run.runId, "01JSESSION000000000000000A", {
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.5,
    });
    store.recordSideUsage(run.taskId, run.runId, "01JSESSION000000000000000A", {
      inputTokens: 50,
      outputTokens: 5,
      costUsd: 0.25,
    });

    const after = store.get(run.taskId, run.runId);
    expect(after?.sides[0]?.inputTokens).toBe(150);
    expect(after?.sides[0]?.outputTokens).toBe(25);
    expect(after?.sides[0]?.costUsd).toBeCloseTo(0.75);

    store.writeFused(
      run.taskId,
      run.runId,
      "[ARCHITECT]\nkeep it\n[BUILDER]\nindex it\n[FUSION]\nboth\n",
    );
    const detail = store.detail(run.taskId, run.runId);
    expect(detail?.spans.map((s) => s.tag)).toEqual(["ARCHITECT", "BUILDER", "FUSION"]);
  });
});
