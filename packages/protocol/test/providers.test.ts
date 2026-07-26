import { describe, expect, it } from "vitest";
import {
  agentRoleSchema,
  authStorePresenceSchema,
  claudeBillingModeSchema,
  familiesConflict,
  familyOfModelRef,
  modelFamilySchema,
  piProviderIdSchema,
  providerConnectionSchema,
  type ModelFamily,
  type PiProviderId,
  type ProviderConnection,
} from "../src/providers.js";

/**
 * `src/providers.ts` — origin→family classification and the cross-family cast
 * check that the whole fusion independence guarantee rests on.
 *
 * Every assertion here is written so that it can fail: either it pins a
 * behaviour that a plausible refactor would change, or it encodes an invariant
 * that a plausible bug would break.
 */

/** One canonical model ref per *real* (non-`other`) family. */
const FAMILY_EXEMPLAR: Readonly<Record<Exclude<ModelFamily, "other">, string>> = {
  anthropic: "anthropic/claude-opus-4-5",
  openai: "openai/gpt-5",
  xai: "xai/grok-4",
  google: "google/gemini-2.5-pro",
  moonshot: "moonshot/kimi-k2",
  mistral: "mistral/mistral-large-latest",
  deepseek: "deepseek/deepseek-v3",
  groq: "groq/llama-3.3-70b-versatile",
};

const REAL_FAMILIES = Object.keys(FAMILY_EXEMPLAR) as ReadonlyArray<
  Exclude<ModelFamily, "other">
>;

describe("familiesConflict — fail-closed on unrecognised origins", () => {
  /**
   * REGRESSION GUARD. This is the test that fails against the old behaviour.
   *
   * Before the fix, `"other"` was treated as a family of its own: an Anthropic
   * model reached through an origin the table does not recognise resolved to
   * `"other"`, compared unequal to a real `anthropic/*` validator, and the cast
   * was accepted — both seats secretly Anthropic, with no event to show for it.
   * `familiesConflict` returned `false` for every pair below. It must now
   * return `true`, because an unknown origin cannot be *proved* different.
   */
  it("reports a conflict when an unrecognised origin is paired with a known family", () => {
    expect(familiesConflict("mystery-vendor/model-x", "anthropic/claude-opus-4-5")).toBe(true);
    // Argument order must not matter — a one-sided check would pass the line
    // above and still leak here.
    expect(familiesConflict("anthropic/claude-opus-4-5", "mystery-vendor/model-x")).toBe(true);
  });

  /**
   * The concrete real-world instance of the bug above: `amazon-bedrock` is a
   * declared Pi provider id (see `piProviderIdSchema`) that the origin table
   * does not classify, and Bedrock's flagship offering *is* Anthropic. Under
   * the old fail-open rule this exact pair was accepted as cross-family.
   */
  it("refuses a Bedrock-hosted Anthropic model against an Anthropic validator", () => {
    expect(
      familiesConflict("amazon-bedrock/anthropic.claude-3-5-sonnet", "anthropic/claude-opus-4-5"),
    ).toBe(true);
  });

  it("treats two unrecognised origins as conflicting — they may be one vendor under two aliases", () => {
    expect(familiesConflict("mystery-a/model", "mystery-b/model")).toBe(true);
    expect(familiesConflict("mystery-a/model", "mystery-a/model")).toBe(true);
    expect(familiesConflict("", "")).toBe(true);
  });

  it("fails closed on an unrecognised origin for EVERY known family, not just anthropic", () => {
    for (const family of REAL_FAMILIES) {
      expect(familiesConflict("mystery-vendor/model-x", FAMILY_EXEMPLAR[family])).toBe(true);
    }
  });
});

describe("familiesConflict — known families", () => {
  /**
   * The over-correction guard. Failing closed on unknowns must not degrade into
   * refusing every cast; that would be just as broken, only louder. Two
   * *provably* different families must still be allowed.
   */
  it("does not conflict across any two genuinely different known families", () => {
    for (const a of REAL_FAMILIES) {
      for (const b of REAL_FAMILIES) {
        if (a === b) continue;
        expect(
          familiesConflict(FAMILY_EXEMPLAR[a], FAMILY_EXEMPLAR[b]),
          `${a} vs ${b} must be allowed`,
        ).toBe(false);
      }
    }
  });

  it("conflicts when both seats resolve to the same known family", () => {
    for (const family of REAL_FAMILIES) {
      expect(familiesConflict(FAMILY_EXEMPLAR[family], FAMILY_EXEMPLAR[family])).toBe(true);
    }
  });

  /**
   * Symmetry over the *known* families alone is implied by the two tests above
   * and cannot fail on its own, so the matrix here deliberately mixes in the
   * cases where the two sides are NOT interchangeable in the implementation:
   * unknown origins, aliases, aggregators and degenerate refs. Narrow the
   * fail-closed guard to one side (`if (fa === "other") return true`) and this
   * goes red on every pair that has an unknown on exactly one side.
   */
  const SYMMETRY_REFS: readonly string[] = [
    ...REAL_FAMILIES.map((family) => FAMILY_EXEMPLAR[family]),
    "claude-agent-sdk/claude-opus-4-5",
    "github-copilot/gpt-5",
    "openrouter/anthropic/claude-sonnet-4",
    "vercel-ai-gateway/openai/gpt-5",
    "mystery-vendor/model-x",
    "amazon-bedrock/anthropic.claude-3-5-sonnet",
    "openrouter/zai/glm-4.6",
    "",
  ];

  it("is symmetric, including when exactly one side is an unknown origin", () => {
    for (const a of SYMMETRY_REFS) {
      for (const b of SYMMETRY_REFS) {
        const forward = familiesConflict(a, b);
        const backward = familiesConflict(b, a);
        expect(forward, `"${a}" / "${b}" must agree with the reverse order`).toBe(backward);
      }
    }
  });

  /**
   * Alias laundering: the same vendor addressed through a different origin must
   * not buy an "independent" validator seat.
   *
   * The `toBe(true)` half of this is nearly unfalsifiable on its own — `true` is
   * also what the fail-closed default returns, so deleting the whole
   * `claude-agent-sdk` arm keeps it green. The `toBe(false)` half is the one
   * that bites: it can only hold if the alias resolved to its *real* family
   * rather than falling through to `other`. Both halves together pin the arm.
   */
  it("blocks same-vendor pairs that are disguised by an alias origin", () => {
    const ALIASES: ReadonlyArray<readonly [alias: string, sameVendor: string, otherVendor: string]> =
      [
        ["claude-agent-sdk/claude-opus-4-5", "anthropic/claude-opus-4-5", "openai/gpt-5"],
        ["github-copilot/gpt-5", "openai/gpt-5", "anthropic/claude-opus-4-5"],
        ["chatgpt/gpt-5", "openai/gpt-5", "anthropic/claude-opus-4-5"],
        ["grok/grok-4", "xai/grok-4", "openai/gpt-5"],
        ["kimi-coding/kimi-k2", "moonshot/kimi-k2", "anthropic/claude-opus-4-5"],
        ["moonshotai/kimi-k2", "moonshot/kimi-k2", "anthropic/claude-opus-4-5"],
        ["kimi/kimi-k2", "moonshot/kimi-k2", "anthropic/claude-opus-4-5"],
        ["google-vertex/gemini-2.5-pro", "google/gemini-2.5-pro", "openai/gpt-5"],
        [
          "google-gemini-cli/gemini-2.5-pro",
          "google-vertex/gemini-2.5-pro",
          "anthropic/claude-opus-4-5",
        ],
      ];
    for (const [alias, sameVendor, otherVendor] of ALIASES) {
      expect(familiesConflict(alias, sameVendor), `${alias} must conflict with ${sameVendor}`).toBe(
        true,
      );
      expect(
        familiesConflict(alias, otherVendor),
        `${alias} must resolve to a real family, not "other", so ${otherVendor} is allowed`,
      ).toBe(false);
    }
  });

  /**
   * Aggregator laundering: routing through OpenRouter or the Vercel gateway must
   * not launder family. Same structure as the alias test — the `false` leg is
   * what proves the peel actually ran instead of failing through to `other`.
   */
  it("blocks same-vendor pairs that are disguised by an aggregator prefix", () => {
    const ROUTED: ReadonlyArray<readonly [routed: string, sameVendor: string, otherVendor: string]> =
      [
        [
          "openrouter/anthropic/claude-sonnet-4",
          "anthropic/claude-opus-4-5",
          "openai/gpt-5",
        ],
        ["openrouter/x-ai/grok-4", "xai/grok-3", "anthropic/claude-opus-4-5"],
        ["openrouter/moonshotai/kimi-k2", "kimi-coding/kimi-k2", "openai/gpt-5"],
        ["openrouter/mistralai/mistral-large-latest", "mistral/mistral-large-latest", "openai/gpt-5"],
        [
          "vercel-ai-gateway/anthropic/claude-sonnet-4",
          "claude-agent-sdk/claude-opus-4-5",
          "openai/gpt-5",
        ],
      ];
    for (const [routed, sameVendor, otherVendor] of ROUTED) {
      expect(familiesConflict(routed, sameVendor), `${routed} must conflict with ${sameVendor}`).toBe(
        true,
      );
      expect(
        familiesConflict(routed, otherVendor),
        `${routed} must peel to a real family, not "other", so ${otherVendor} is allowed`,
      ).toBe(false);
    }
  });
});

/**
 * The full origin table, pinned. Every arm of the `switch` in
 * `familyOfModelRef` appears here; deleting or reordering a `case` fails this.
 */
const ORIGIN_TABLE: ReadonlyArray<readonly [string, ModelFamily]> = [
  // anthropic arm — including the claude-agent-sdk alias (§4.10 R6.1).
  ["anthropic/claude-opus-4-5", "anthropic"],
  ["claude-agent-sdk/claude-opus-4-5", "anthropic"],
  // openai arm — including github-copilot and chatgpt aliases.
  ["openai/gpt-5", "openai"],
  ["github-copilot/gpt-5", "openai"],
  ["chatgpt/gpt-5", "openai"],
  // xai arm — including the grok alias.
  ["xai/grok-4", "xai"],
  ["grok/grok-4", "xai"],
  // google arm — three origins collapse to one family.
  ["google/gemini-2.5-pro", "google"],
  ["google-gemini-cli/gemini-2.5-pro", "google"],
  ["google-vertex/gemini-2.5-pro", "google"],
  // moonshot arm — including kimi-coding, moonshotai, and kimi aliases.
  ["moonshot/kimi-k2", "moonshot"],
  ["moonshotai/kimi-k2", "moonshot"],
  ["kimi-coding/kimi-k2", "moonshot"],
  ["kimi/kimi-k2", "moonshot"],
  // single-origin arms.
  ["mistral/mistral-large-latest", "mistral"],
  ["deepseek/deepseek-v3", "deepseek"],
  ["groq/llama-3.3-70b-versatile", "groq"],
  // default arm.
  ["totally-unknown/model", "other"],
];

/** OpenRouter sub-peeling: the aggregator is not a family, so peel one segment. */
const OPENROUTER_TABLE: ReadonlyArray<readonly [string, ModelFamily]> = [
  ["openrouter/anthropic/claude-sonnet-4", "anthropic"],
  ["openrouter/openai/gpt-5", "openai"],
  // Both xAI slugs — OpenRouter publishes `x-ai/`, the alias `xai/` is accepted too.
  ["openrouter/x-ai/grok-4", "xai"],
  ["openrouter/xai/grok-4", "xai"],
  ["openrouter/google/gemini-2.5-pro", "google"],
  // Both Moonshot slugs.
  ["openrouter/moonshotai/kimi-k2", "moonshot"],
  ["openrouter/moonshot/kimi-k2", "moonshot"],
  // Both Mistral slugs.
  ["openrouter/mistralai/mistral-large-latest", "mistral"],
  ["openrouter/mistral/mistral-large-latest", "mistral"],
  ["openrouter/deepseek/deepseek-v3", "deepseek"],
  // Not peeled by this branch — falls through to `other`, i.e. fails closed.
  ["openrouter/groq/llama-3.3-70b-versatile", "other"],
  ["openrouter/zai/glm-4.6", "other"],
];

describe("familyOfModelRef — origin table", () => {
  it.each(ORIGIN_TABLE)("classifies %s as %s", (ref, expected) => {
    expect(familyOfModelRef(ref)).toBe(expected);
  });

  it.each(OPENROUTER_TABLE)("peels openrouter: %s -> %s", (ref, expected) => {
    expect(familyOfModelRef(ref)).toBe(expected);
  });

  /**
   * The vendor prefix must be matched as a whole *segment*, not a substring.
   * `startsWith("openai/")` is what stops `openrouter/openai-community/gpt2`
   * from being claimed by OpenAI. Drop the trailing slash from any of these
   * checks and this test goes red.
   */
  it("does not let a vendor prefix claim a longer vendor name on openrouter", () => {
    expect(familyOfModelRef("openrouter/openai-community/gpt2")).toBe("other");
    expect(familyOfModelRef("openrouter/anthropic-mirror/claude-clone")).toBe("other");
    expect(familyOfModelRef("openrouter/googler/model")).toBe("other");
  });

  /** An aggregator with no model segment cannot be peeled — must fail closed. */
  it("returns other for a bare or unpeelable aggregator ref", () => {
    expect(familyOfModelRef("openrouter")).toBe("other");
    expect(familyOfModelRef("openrouter/")).toBe("other");
    expect(familyOfModelRef("openrouter/anthropic")).toBe("other");
    expect(familyOfModelRef("vercel-ai-gateway")).toBe("other");
    expect(familyOfModelRef("vercel-ai-gateway/")).toBe("other");
  });

  /** A bare non-aggregator origin is still a classifiable origin. */
  it("classifies a bare origin with no model segment", () => {
    expect(familyOfModelRef("anthropic")).toBe("anthropic");
    expect(familyOfModelRef("anthropic/")).toBe("anthropic");
    expect(familyOfModelRef("claude-agent-sdk")).toBe("anthropic");
  });

  /**
   * Matching is case-sensitive and untrimmed. Pinned as characterisation, not
   * endorsement: a config file carrying `Anthropic/claude-opus-4-5` classifies
   * as `other` and therefore conflicts with everything. That is the safe
   * direction post-fix, but it is a live source of "why is every cast refused".
   */
  it("is case-sensitive and does not trim (characterisation)", () => {
    expect(familyOfModelRef("Anthropic/claude-opus-4-5")).toBe("other");
    expect(familyOfModelRef("ANTHROPIC/claude-opus-4-5")).toBe("other");
    expect(familyOfModelRef(" anthropic/claude-opus-4-5")).toBe("other");
    expect(familyOfModelRef("anthropic /claude-opus-4-5")).toBe("other");
  });

  it("returns other for degenerate refs rather than throwing", () => {
    expect(familyOfModelRef("")).toBe("other");
    expect(familyOfModelRef("/")).toBe("other");
    expect(familyOfModelRef("//")).toBe("other");
    expect(familyOfModelRef("/anthropic/claude-opus-4-5")).toBe("other");
  });

  /**
   * Whatever the table returns must be a member of `modelFamilySchema`. This is
   * the coupling that a future `return "cohere"` (added to the switch, forgotten
   * in the enum) would break — silently producing a `ModelFamily` that no
   * consumer's schema will parse.
   */
  it("only ever returns a value that modelFamilySchema accepts", () => {
    const refs = [
      ...ORIGIN_TABLE.map(([ref]) => ref),
      ...OPENROUTER_TABLE.map(([ref]) => ref),
      "vercel-ai-gateway/anthropic/claude-sonnet-4",
      "vercel-ai-gateway/openai/gpt-5",
      "vercel-ai-gateway/moonshotai/kimi-k2",
      "vercel-ai-gateway/zai/glm-4.6",
      "",
      "/",
    ];
    for (const ref of refs) {
      expect(modelFamilySchema.safeParse(familyOfModelRef(ref)).success, ref).toBe(true);
    }
  });

  /**
   * The same coupling in the other direction. The test above catches a family
   * being *removed* from the enum while the table still returns it; this one
   * catches a family being *added* to the enum with no origin that produces it —
   * a member no connection can ever legitimately carry, which reads as supported
   * and silently isn't.
   */
  it("has an origin that produces every family the enum declares", () => {
    const produced = new Set<ModelFamily>([
      ...ORIGIN_TABLE.map(([ref]) => familyOfModelRef(ref)),
      ...OPENROUTER_TABLE.map(([ref]) => familyOfModelRef(ref)),
    ]);
    expect([...produced].sort()).toStrictEqual([...modelFamilySchema.options].sort());
  });
});

describe("familyOfModelRef — vercel-ai-gateway substring matching", () => {
  /** The happy paths this branch is actually built for. */
  it("classifies the vendors it knows about", () => {
    expect(familyOfModelRef("vercel-ai-gateway/anthropic/claude-sonnet-4")).toBe("anthropic");
    expect(familyOfModelRef("vercel-ai-gateway/openai/gpt-5")).toBe("openai");
    expect(familyOfModelRef("vercel-ai-gateway/moonshotai/kimi-k2")).toBe("moonshot");
  });

  /**
   * CHARACTERISATION — current behaviour, deliberately not "fixed" here.
   *
   * RISK (availability, not safety): unlike the `openrouter` branch, this branch
   * has no arm for xai, google, deepseek, mistral or groq. Every gateway-routed
   * model from those vendors resolves to `other`, and post-fail-closed that
   * means it conflicts with *everything* — including a validator from a
   * genuinely different family. Vercel AI Gateway is effectively unusable for
   * five of the eight supported families. The safe direction, but a real gap.
   */
  it("does not classify xai/google/deepseek/mistral/groq on the gateway (characterisation)", () => {
    expect(familyOfModelRef("vercel-ai-gateway/xai/grok-4")).toBe("other");
    expect(familyOfModelRef("vercel-ai-gateway/google/gemini-2.5-pro")).toBe("other");
    expect(familyOfModelRef("vercel-ai-gateway/deepseek/deepseek-v3")).toBe("other");
    expect(familyOfModelRef("vercel-ai-gateway/mistral/mistral-large-latest")).toBe("other");
    expect(familyOfModelRef("vercel-ai-gateway/groq/llama-3.3-70b-versatile")).toBe("other");

    // The downstream consequence, pinned: a gateway xAI builder cannot be
    // validated even by a Google model, which is provably a different vendor.
    expect(familiesConflict("vercel-ai-gateway/xai/grok-4", "google/gemini-2.5-pro")).toBe(true);
  });

  /**
   * CHARACTERISATION — current behaviour, deliberately not "fixed" here.
   *
   * RISK (misclassification): `rest.includes("gpt")` is an unanchored substring
   * scan over the whole remainder, vendor segment included. `gpt` is a generic
   * architecture name, not an OpenAI trademark, so real non-OpenAI models carry
   * it: EleutherAI's GPT-NeoX and GPT-J, BigCode's gpt_bigcode. All are labelled
   * `openai`.
   */
  it("mislabels non-OpenAI models whose names merely contain 'gpt' (characterisation)", () => {
    expect(familyOfModelRef("vercel-ai-gateway/eleutherai/gpt-neox-20b")).toBe("openai");
    expect(familyOfModelRef("vercel-ai-gateway/eleutherai/gpt-j-6b")).toBe("openai");
    expect(familyOfModelRef("vercel-ai-gateway/bigcode/gpt_bigcode-santacoder")).toBe("openai");
  });

  /**
   * CHARACTERISATION of the one case that is a genuine SAFETY hole, not merely
   * an availability one.
   *
   * RISK (fail-open): the scan ignores the vendor segment entirely and the
   * `anthropic`/`claude` arm runs first, so a model whose *name* mentions Claude
   * is labelled `anthropic` even when its vendor segment says `openai`. Pair it
   * with a real `openai/*` validator and the two families compare unequal:
   * `familiesConflict` returns `false` and the cast is accepted with both seats
   * OpenAI. This is the same class of failure the `"other"` fix closed, still
   * reachable through the gateway branch. A segment-anchored match on the vendor
   * component (as `openrouter` already does) would close it.
   */
  it("lets a name-collision defeat the cross-family check on the gateway (characterisation)", () => {
    const ref = "vercel-ai-gateway/openai/gpt-5-claude-comparison";
    expect(familyOfModelRef(ref)).toBe("anthropic");
    // Two OpenAI seats, reported as non-conflicting. This SHOULD be `true`.
    expect(familiesConflict(ref, "openai/gpt-5")).toBe(false);
  });

  /** Arm ordering is load-bearing: anthropic is tested before openai. */
  it("resolves anthropic before openai when both substrings are present", () => {
    expect(familyOfModelRef("vercel-ai-gateway/openai/claude-vs-gpt-eval")).toBe("anthropic");
    expect(familyOfModelRef("vercel-ai-gateway/anthropic/claude-vs-gpt-eval")).toBe("anthropic");
  });
});

describe("familyOfModelRef — coverage of declared Pi provider ids", () => {
  /**
   * Every id in `piProviderIdSchema` is an origin the product can genuinely
   * produce. This pins which of them the family table classifies and which fall
   * through to `other`. Adding a provider id without deciding its family now
   * fails here instead of silently making every cast from that provider
   * unusable (or, pre-fix, silently unsafe).
   */
  const EXPECTED: Readonly<Record<PiProviderId, ModelFamily>> = {
    anthropic: "anthropic",
    "claude-agent-sdk": "anthropic",
    openai: "openai",
    "github-copilot": "openai",
    xai: "xai",
    google: "google",
    "google-gemini-cli": "google",
    "google-vertex": "google",
    "kimi-coding": "moonshot",
    // Aggregators: unclassifiable without a peelable model segment.
    openrouter: "other",
    "vercel-ai-gateway": "other",
    // Unclassified origins — every cast from these fails closed. `amazon-bedrock`
    // and `azure-openai-responses` are the sharp ones: they resell Anthropic and
    // OpenAI models respectively, which is precisely the fail-open scenario the
    // `"other"` fix closed.
    "amazon-bedrock": "other",
    "azure-openai-responses": "other",
    zai: "other",
    opencode: "other",
    minimax: "other",
    "minimax-cn": "other",
  };

  it("classifies every declared provider id, and nothing is left undecided", () => {
    const declared = piProviderIdSchema.options;
    expect(Object.keys(EXPECTED).sort()).toStrictEqual([...declared].sort());
    for (const id of declared) {
      expect(familyOfModelRef(`${id}/some-model`), id).toBe(EXPECTED[id]);
    }
  });
});

describe("provider schemas — rejection paths", () => {
  const VALID: ProviderConnection = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: "pi-oauth",
    provider: "anthropic",
    label: "Claude Pro/Max",
    family: "anthropic",
    billingSurface: "plan-quota",
    billingMode: "subscription-sdk",
    health: "healthy",
    healthReason: null,
    authStorePresence: null,
    effectiveCredentialPath: "claude-code-oauth",
    personalUseOnly: true,
    supportedRoles: ["builder", "validator"],
    limitReached: false,
    limitReachedReason: null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
  };

  it("accepts the reference connection", () => {
    expect(providerConnectionSchema.safeParse(VALID).success).toBe(true);
  });

  /**
   * `strictObject` is the guard that stops a token, cookie or refresh secret
   * from riding along inside a connection DTO on its way to the console.
   */
  it("rejects an unknown property rather than stripping it", () => {
    const smuggled: Record<string, unknown> = { ...VALID, accessToken: "sk-ant-secret" };
    const result = providerConnectionSchema.safeParse(smuggled);
    expect(result.success).toBe(false);
  });

  it("rejects a missing nullable field — null is required, undefined is not", () => {
    const withoutHealthReason: Record<string, unknown> = { ...VALID };
    delete withoutHealthReason.healthReason;
    expect(providerConnectionSchema.safeParse(withoutHealthReason).success).toBe(false);
  });

  it("rejects an empty label", () => {
    expect(providerConnectionSchema.safeParse({ ...VALID, label: "" }).success).toBe(false);
  });

  it("rejects a non-ULID id and a non-ISO timestamp", () => {
    expect(providerConnectionSchema.safeParse({ ...VALID, id: "not-a-ulid" }).success).toBe(false);
    expect(providerConnectionSchema.safeParse({ ...VALID, createdAt: "2026-07-24" }).success).toBe(
      false,
    );
  });

  /**
   * Every enum-typed field, with no gaps — a field left off this list can be
   * downgraded to a bare `z.string()` without a single test going red.
   * `billingSurface` and `effectiveCredentialPath` are the two that drive
   * quota accounting and the credential-path badge; a free-form string there
   * means an unrecognised surface reaches the console un-noticed.
   */
  it("rejects an unknown enum member on every enum field", () => {
    const BAD_ENUM_VALUES: ReadonlyArray<readonly [field: string, value: unknown]> = [
      ["kind", "pi-basic-auth"],
      ["provider", "ollama"],
      ["family", "cohere"],
      ["billingSurface", "free"],
      ["billingMode", "subscription"],
      ["health", "ok"],
      ["effectiveCredentialPath", "keychain"],
      ["supportedRoles", ["builder", "captain"]],
    ];
    for (const [field, value] of BAD_ENUM_VALUES) {
      const mutated: Record<string, unknown> = { ...VALID, [field]: value };
      expect(providerConnectionSchema.safeParse(mutated).success, `${field}=${String(value)}`).toBe(
        false,
      );
    }
  });

  it("rejects a string where a boolean is required — no coercion", () => {
    expect(providerConnectionSchema.safeParse({ ...VALID, limitReached: "false" }).success).toBe(
      false,
    );
    expect(providerConnectionSchema.safeParse({ ...VALID, personalUseOnly: 1 }).success).toBe(false);
  });

  it("rejects an auth-store presence record that carries anything beyond presence metadata", () => {
    const presence = {
      provider: "anthropic",
      present: true,
      mtime: "2026-07-24T10:00:00.000Z",
      presenceHash: "sha256:abc",
      expiresAt: null,
    };
    expect(authStorePresenceSchema.safeParse(presence).success).toBe(true);
    expect(
      authStorePresenceSchema.safeParse({ ...presence, refreshToken: "secret" }).success,
    ).toBe(false);
    // A hash is required to be present-or-explicitly-null, never absent.
    const withoutHash: Record<string, unknown> = { ...presence };
    delete withoutHash.presenceHash;
    expect(authStorePresenceSchema.safeParse(withoutHash).success).toBe(false);
  });

  it("keeps billingMode nullable so non-Claude connections cannot invent one", () => {
    expect(providerConnectionSchema.safeParse({ ...VALID, billingMode: null }).success).toBe(true);
    expect(claudeBillingModeSchema.safeParse("free-tier").success).toBe(false);
  });

  it("keeps the validator role in the agent-role enum", () => {
    // `resolve_cast` fills a validator seat by name; losing this member from the
    // enum would silently make every validator connection unparseable.
    expect(agentRoleSchema.safeParse("validator").success).toBe(true);
    expect(agentRoleSchema.safeParse("Validator").success).toBe(false);
  });
});
