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
});
