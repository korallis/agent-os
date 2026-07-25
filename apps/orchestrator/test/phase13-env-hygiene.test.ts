import { describe, expect, it } from "vitest";
import { scrubEnv } from "../src/security/env-scrub.js";
import { buildGateEnv } from "../src/fleet/gate-runner.js";

/**
 * SSH agent exposure (external review, verified).
 *
 * `SSH_AUTH_SOCK` used to sit in the base allowlist, so it reached every
 * spawned process — including Brain-authored gate code. That is model-written
 * code running with the Captain's forwarded keys: it could `git push`, `ssh`
 * anywhere those keys are trusted, or sign as them. It is now opt-in, and gate
 * subprocesses never get it.
 */
describe("SSH agent forwarding is opt-in and never reaches gate code", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/Users/captain",
    SSH_AUTH_SOCK: "/private/tmp/ssh-agent.sock",
  } as NodeJS.ProcessEnv;

  it("does not forward the agent socket by default", () => {
    const { env } = scrubEnv(parent);
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    // The rest of the benign environment still comes through.
    expect(env.PATH).toBe("/usr/bin");
  });

  it("forwards it only when explicitly granted", () => {
    const { env } = scrubEnv(parent, { grantSshAgent: true });
    expect(env.SSH_AUTH_SOCK).toBe("/private/tmp/ssh-agent.sock");
  });

  it("NEVER forwards it to gate subprocesses, even when the daemon has one", () => {
    // The load-bearing case: gate code is authored by the Brain, so handing it
    // the Captain's identity is the sharpest edge in the whole substrate.
    for (const target of ["baseline", "candidate"] as const) {
      const env = buildGateEnv(parent, target);
      expect(env.SSH_AUTH_SOCK).toBeUndefined();
    }
  });

  it("grants nothing when the parent has no agent socket", () => {
    const { env } = scrubEnv({ PATH: "/usr/bin" }, { grantSshAgent: true });
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("strips SSH_AUTH_SOCK from extraAllow unless grantSshAgent is true", () => {
    // An invariant with a side door is not an invariant: extraAllow must not
    // re-inject the agent socket behind the opt-in flag.
    const { env: denied } = scrubEnv(
      { PATH: "/usr/bin" },
      {
        extraAllow: { SSH_AUTH_SOCK: "/private/tmp/injected.sock" },
      },
    );
    expect(denied.SSH_AUTH_SOCK).toBeUndefined();

    const { env: granted } = scrubEnv(parent, {
      grantSshAgent: true,
      extraAllow: { SSH_AUTH_SOCK: "/private/tmp/injected.sock" },
    });
    expect(granted.SSH_AUTH_SOCK).toBe("/private/tmp/injected.sock");
  });
});

describe("fusion artifact reads are contained", () => {
  it("refuses an artifactPath that escapes the Agent OS home", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FusionRunStore } = await import("../src/fleet/fusion-runs.js");

    const home = mkdtempSync(join(tmpdir(), "p13-home-"));
    const outside = mkdtempSync(join(tmpdir(), "p13-outside-"));
    const secret = join(outside, "id_rsa");
    writeFileSync(secret, "PRIVATE-KEY-MUST-NOT-BE-SERVED");

    const taskId = "01TASK00000000000000000001";
    const runId = "01RUN000000000000000000001";
    const dir = join(home, "runs", taskId, "fusion", runId);
    mkdirSync(dir, { recursive: true });
    // A crewmate can write under its own run directory, so run.json is
    // attacker-influenced input — not trusted daemon state.
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({
        runId,
        taskId,
        kind: "opinion",
        instruction: "x",
        instructionHash: "h",
        promptsIdentical: true,
        aggregatorFamily: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
        sides: [
          {
            role: "planner",
            model: "openai/gpt-4.1",
            family: "openai",
            thinking: "medium",
            sessionId: null,
            promptHash: "h",
            inputTokens: null,
            outputTokens: null,
            costUsd: null,
            settledAt: null,
            artifactPath: secret,
          },
        ],
      }),
    );

    const store = new FusionRunStore(home);
    const detail = store.detail(taskId, runId);
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain("PRIVATE-KEY-MUST-NOT-BE-SERVED");

    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
