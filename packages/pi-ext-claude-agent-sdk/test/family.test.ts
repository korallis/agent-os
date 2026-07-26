import { describe, expect, it } from "vitest";
import {
  assertCrossFamilyCast,
  CLAUDE_AGENT_SDK_MODELS,
  CrossFamilyViolationError,
  familyOfClaudeAgentSdkModel,
  listClaudeAgentSdkCatalog,
} from "../src/index.js";

describe("claude-agent-sdk family classification", () => {
  it("exposes catalog models", () => {
    expect(listClaudeAgentSdkCatalog().length).toBeGreaterThan(0);
    expect(CLAUDE_AGENT_SDK_MODELS[0]).toMatch(/^claude-agent-sdk\//);
  });

  it("classifies as anthropic and rejects same-family cast", () => {
    expect(familyOfClaudeAgentSdkModel("claude-agent-sdk/claude-opus-4-5")).toBe("anthropic");
    expect(() =>
      assertCrossFamilyCast("claude-agent-sdk/claude-opus-4-5", "anthropic/claude-fable-5"),
    ).toThrow(CrossFamilyViolationError);
  });

  it("reports both families when one origin is unrecognised", () => {
    try {
      assertCrossFamilyCast("anthropic/claude-opus-4-5", "amazon-bedrock/anthropic.claude-3-5");
      expect.unreachable("expected CrossFamilyViolationError");
    } catch (err) {
      expect(err).toBeInstanceOf(CrossFamilyViolationError);
      const violation = err as CrossFamilyViolationError;
      expect(violation.builderFamily).toBe("anthropic");
      expect(violation.validatorFamily).toBe("other");
      expect(violation.message).toMatch(/validator origin is unrecognised/);
      expect(violation.message).not.toMatch(/both family anthropic/);
    }
  });

  it("accepts genuinely different known families", () => {
    expect(() =>
      assertCrossFamilyCast("claude-agent-sdk/claude-opus-4-5", "openai/gpt-5"),
    ).not.toThrow();
  });
});
