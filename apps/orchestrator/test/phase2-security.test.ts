import { describe, expect, it } from "vitest";
import {
  assertNoAmbientAnthropicKey,
  EnvHygieneError,
  scrubEnv,
} from "../src/security/env-scrub.js";
import {
  containsSecretMaterial,
  scanForSecrets,
  SECRET_CANARY,
  scrubSecrets,
} from "../src/security/secret-canary.js";
import { assertTokenUrlAllowed, isProbeUrlAllowed } from "../src/quota-probes/allowlist.js";
import { formatResetsIn, isLimitReached } from "../src/quota-probes/probes.js";
import { familyOfModelRef, familiesConflict } from "@agent-os/protocol";
import {
  assertCrossFamilyCast,
  CrossFamilyViolationError,
  isClaudeAgentSdkModel,
} from "@agentos/claude-agent-sdk-pi";
import type { QuotaSample } from "@agent-os/protocol";

describe("env hygiene (§4.8)", () => {
  it("allows at most one provider key", () => {
    const result = scrubEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp",
        ANTHROPIC_API_KEY: "sk-ant-should-strip",
        OPENAI_API_KEY: "sk-openai-should-strip",
        RANDOM: "drop-me",
      },
      {
        grantProviderKey: { name: "OPENAI_API_KEY", value: "sk-openai-granted" },
      },
    );
    expect(result.env.OPENAI_API_KEY).toBe("sk-openai-granted");
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.RANDOM).toBeUndefined();
    expect(result.providerKeysPresent).toEqual(["OPENAI_API_KEY"]);
  });

  it("strips ambient session-dir vars unless granted via extraAllow", () => {
    const ambient = "/tmp/ambient-session-dir-CANARY";
    const seat = "/tmp/seat-session-dir-explicit";
    const stripped = scrubEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp",
        AGENTOS_SESSION_DIR: ambient,
        PI_CODING_AGENT_SESSION_DIR: ambient,
      },
      {},
    );
    expect(stripped.env.AGENTOS_SESSION_DIR).toBeUndefined();
    expect(stripped.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();

    const granted = scrubEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp",
        AGENTOS_SESSION_DIR: ambient,
        PI_CODING_AGENT_SESSION_DIR: ambient,
      },
      {
        extraAllow: {
          AGENTOS_SESSION_DIR: seat,
          PI_CODING_AGENT_SESSION_DIR: seat,
        },
      },
    );
    expect(granted.env.AGENTOS_SESSION_DIR).toBe(seat);
    expect(granted.env.PI_CODING_AGENT_SESSION_DIR).toBe(seat);
    expect(granted.env.AGENTOS_SESSION_DIR).not.toBe(ambient);
  });

  it("flags ambient ANTHROPIC_API_KEY for subscription-sdk path", () => {
    expect(() =>
      assertNoAmbientAnthropicKey({ ANTHROPIC_API_KEY: "sk-ant-ambient" }),
    ).toThrow(EnvHygieneError);
    expect(() => assertNoAmbientAnthropicKey({})).not.toThrow();
  });
});

describe("secret canary", () => {
  it("detects and scrubs canary + token shapes", () => {
    expect(containsSecretMaterial(SECRET_CANARY)).toBe(true);
    expect(containsSecretMaterial("Bearer abcdefghijklmnopqrstuvwxyz012345")).toBe(true);
    expect(scrubSecrets(`token ${SECRET_CANARY}`)).toContain("[REDACTED]");
    expect(scanForSecrets({ event: { note: SECRET_CANARY } })).toContain("event.note");
  });
});

describe("probe allowlist boundary", () => {
  it("allows only baked-in URLs", () => {
    expect(isProbeUrlAllowed("https://api.anthropic.com/api/oauth/usage")).toBe(true);
    expect(isProbeUrlAllowed("https://evil.example/steal")).toBe(false);
    expect(() => assertTokenUrlAllowed("https://evil.example/steal")).toThrow(/PROBE_URL_DENIED/);
  });

  it("fuzzes random URLs as denied", () => {
    const hosts = ["evil.com", "localhost", "api.anthropic.com.evil", "openrouter.ai.evil"];
    for (const host of hosts) {
      expect(isProbeUrlAllowed(`https://${host}/api/oauth/usage`)).toBe(false);
    }
  });
});

describe("family classification [R6]", () => {
  it("classifies claude-agent-sdk/* as anthropic", () => {
    expect(familyOfModelRef("claude-agent-sdk/claude-opus-4-5")).toBe("anthropic");
    expect(isClaudeAgentSdkModel("claude-agent-sdk/claude-opus-4-5")).toBe(true);
    expect(familiesConflict("claude-agent-sdk/claude-opus-4-5", "anthropic/claude-fable-5")).toBe(
      true,
    );
    expect(() =>
      assertCrossFamilyCast("claude-agent-sdk/claude-opus-4-5", "anthropic/claude-sonnet-4-5"),
    ).toThrow(CrossFamilyViolationError);
    expect(() =>
      assertCrossFamilyCast("claude-agent-sdk/claude-opus-4-5", "openai/gpt-5.6-codex"),
    ).not.toThrow();
  });
});

describe("quota limit + fake clock", () => {
  it("formats RESETS IN countdown across window boundaries", () => {
    const now = new Date("2026-07-24T10:00:00.000Z");
    const resetsAt = "2026-07-29T13:00:00.000Z"; // 5d 3h later
    expect(formatResetsIn(resetsAt, now)).toBe("RESETS IN 5D/3H");
  });

  it("LIMIT REACHED sample is detected for cast exclusion", () => {
    const sample: QuotaSample = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      provider: "openai",
      sampledAt: new Date().toISOString(),
      metrics: [
        {
          kind: "plan-window-pct",
          value: 100,
          unit: "percent",
          tier: "live",
          source: "OAUTH · SYNCED",
          syncedAt: new Date().toISOString(),
          reason: "window exhausted",
          resetsAt: null,
          limitReached: true,
        },
      ],
    };
    expect(isLimitReached(sample)).toEqual({
      reached: true,
      reason: "window exhausted",
    });
  });
});
