import { describe, expect, it } from "vitest";
import { enforceFusionContract } from "../src/contract.js";
import { interpolateTemplate, TemplateInterpolationError } from "../src/templates.js";
import { parseAttributedSpans } from "../src/attribution.js";

describe("fusion contract", () => {
  it("accepts a complete fusion artifact", () => {
    const md = `
[ARCHITECT]
Plan A
[BUILDER]
Plan B
[FUSION]
Merged plan

## Consensus & Divergence
- Agree on X
- Diverge on Y

## Decision ledger
- Chose A for X
`;
    const result = enforceFusionContract(md);
    expect(result.ok).toBe(true);
  });

  it("rejects missing sections", () => {
    const result = enforceFusionContract("just prose");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("template interpolation", () => {
  it("fills variables", () => {
    expect(interpolateTemplate("Hello {{NAME}}", { NAME: "Captain" })).toBe("Hello Captain");
  });

  it("throws on undefined vars", () => {
    expect(() => interpolateTemplate("{{MISSING}}", {})).toThrow(TemplateInterpolationError);
  });
});

describe("attribution spans", () => {
  it("parses tagged sections", () => {
    const spans = parseAttributedSpans("[A]\nfoo\n[B]\nbar");
    expect(spans).toHaveLength(2);
    expect(spans[0]?.tag).toBe("A");
    expect(spans[0]?.body).toBe("foo");
  });
});
