import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BRAIN_TOOL_NAMES,
  advancePhaseInputSchema,
  answerCrewmateInputSchema,
  authorGateInputSchema,
  brainToolNameSchema,
  cancelTaskInputSchema,
  castRoleAssignmentSchema,
  createTaskResultSchema,
  deliverTaskInputSchema,
  dispatchFusionInputSchema,
  escalateToCaptainInputSchema,
  notifyCaptainInputSchema,
  readFleetStateInputSchema,
  readTaskInputSchema,
  resolveCastInputSchema,
  resolveDeliveryBlockInputSchema,
  spawnCrewmateInputSchema,
  stopCrewmateInputSchema,
  stowKnowledgeInputSchema,
  toolErrorSchema,
  toolInvocationSchema,
  toolResultSchema,
  updateTaskInputSchema,
} from "../src/tools.js";
import {
  afkFaqEntrySchema,
  afkRequestSchema,
  brainSnapshotSchema,
  fleetStateSnapshotSchema,
  fleetSummarySchema,
  projectRecordSchema,
  taskListItemSchema,
  wakeDigestSchema,
  worktreeLeaseSchema,
} from "../src/fleet.js";
import { roleCastSchema, type TaskSnapshot } from "../src/tasks.js";

// ── helpers ────────────────────────────────────────────────────────────────

const ULID_TASK = "01JAV9Z0T0K3S4V5W6X7Y8Z9AB";
const ULID_SESSION = "01JAV9Z0T0K3S4V5W6X7Y8Z9AC";
const ULID_PROJECT = "01JAV9Z0T0K3S4V5W6X7Y8Z9AD";
const TS = "2026-07-24T10:00:00.000Z";

/**
 * Values a ULID field must refuse. Each is a real shape someone reaches for:
 * a UUID from another system, a truncated/overlong id, an id typed with the
 * Crockford-ambiguous letters, and a non-string.
 */
const NON_ULIDS: readonly unknown[] = [
  "550e8400-e29b-41d4-a716-446655440000",
  "01JAV9Z0T0K3S4V5W6X7Y8Z9A", // 25 chars
  "01JAV9Z0T0K3S4V5W6X7Y8Z9ABC", // 27 chars
  "01JAV9Z0T0K3S4V5W6X7Y8Z9IL", // I and L are not Crockford base32
  "01JAV9Z0T0K3S4V5W6X7Y8Z9OU", // O and U are not Crockford base32
  "",
  "  01JAV9Z0T0K3S4V5W6X7Y8Z9AB  ",
  42,
  null,
  undefined,
];

type Issues = z.ZodError["issues"];

/** Asserts the parse failed and hands back its issues. */
function failure<T>(result: { success: boolean; error?: z.ZodError<T> }): Issues {
  if (!result.error) {
    throw new Error("expected the schema to reject this value, but it parsed");
  }
  return result.error.issues as Issues;
}

/** Returns a copy of `source` with `key` removed — used to prove that a
 *  `.nullable()` field is not silently `.optional()`. */
function omit(source: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source };
  delete copy[key];
  return copy;
}

function codes(issues: Issues): string[] {
  return issues.map((issue) => issue.code);
}

function paths(issues: Issues): string[] {
  return issues.map((issue) => issue.path.join("."));
}

/** A server-derived cast: family is present because the substrate stamped it. */
const serverCast = {
  role: "builder",
  model: "anthropic/claude-opus-4",
  thinking: "high",
  family: "anthropic",
  cleanRoom: true,
} as const;

/** The same cast as a client may express it: no family field at all. */
const clientCast = {
  role: "builder",
  model: "anthropic/claude-opus-4",
  thinking: "high",
  cleanRoom: true,
} as const;

function taskSnapshotFixture(): TaskSnapshot {
  return {
    id: ULID_TASK,
    shape: "SHIP",
    title: "ship it",
    intent: "make the thing",
    projectId: ULID_PROJECT,
    mode: "pipeline",
    yolo: false,
    phase: "BUILDING",
    failureCause: null,
    cast: [serverCast],
    sessions: [],
    validationAttempt: 0,
    maxValidations: 3,
    branch: null,
    worktreePath: null,
    needsCaptainSummary: null,
    deliveryBlocked: null,
    redProof: null,
    lastFailLedger: null,
    wedgeRespawnsByRole: {},
    wedgePendingCaptainNotifies: [],
    wedgeLadderCompletedSessionIds: [],
    pendingQuestions: [],
    idempotencyKey: null,
    createdAt: TS,
    updatedAt: TS,
    configSnapshotHash: null,
    policyOverrides: [],
  };
}

function brainSnapshotFixture(): Record<string, unknown> {
  return {
    status: "running",
    sessionId: ULID_SESSION,
    model: "anthropic/claude-opus-4",
    thinking: "high",
    family: "anthropic",
    provider: "anthropic",
    tmuxWindow: "brain",
    wakeQueueDepth: 0,
    lastReconcileAt: TS,
    handoffFrom: null,
    handoffReason: null,
  };
}

// ── the tool catalog is a closed set ───────────────────────────────────────

describe("brain tool catalog", () => {
  it("refuses tool names that are not in the catalog", () => {
    // If `tool` ever loosened from an enum to z.string(), the Brain could name
    // any substrate entry point it liked and the invocation would validate.
    const notTools = [
      "run_shell",
      "read_secrets",
      "write_file",
      "set_policy",
      "spawn_brain",
      "resolve_family_check",
      "clear_red_proof",
      "",
    ];
    for (const name of notTools) {
      expect(brainToolNameSchema.safeParse(name).success, name).toBe(false);
    }
  });

  it("refuses casing and whitespace variants of a real tool name", () => {
    expect(brainToolNameSchema.safeParse("create_task").success).toBe(true);
    for (const variant of ["createTask", "Create_Task", "CREATE_TASK", " create_task", "create_task "]) {
      expect(brainToolNameSchema.safeParse(variant).success, variant).toBe(false);
    }
  });

  it("lists every tool exactly once in lower snake_case", () => {
    expect(new Set(BRAIN_TOOL_NAMES).size).toBe(BRAIN_TOOL_NAMES.length);
    for (const name of BRAIN_TOOL_NAMES) {
      expect(name, name).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });
});

// ── the privilege boundary: family is never client-supplied on a cast ──────

describe("castRoleAssignment — family is derived, never asserted", () => {
  it("rejects a client-supplied family as an unrecognized key", () => {
    // A cast carrying its own `family` would let the Brain declare the
    // cross-family independence that resolve_cast is supposed to verify.
    const issues = failure(castRoleAssignmentSchema.safeParse({ ...clientCast, family: "anthropic" }));
    expect(codes(issues)).toContain("unrecognized_keys");
    expect(JSON.stringify(issues)).toContain("family");
  });

  it("rejects a family smuggled under a near-miss key too", () => {
    for (const key of ["Family", "family_", "modelFamily", "familyCheckOverride"]) {
      const result = castRoleAssignmentSchema.safeParse({ ...clientCast, [key]: "anthropic" });
      expect(result.success, key).toBe(false);
    }
  });

  it("produces a parsed cast with no family key at all", () => {
    const parsed = castRoleAssignmentSchema.parse(clientCast);
    expect("family" in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(["cleanRoom", "model", "role", "thinking"]);
  });

  it("holds the cast/roleCast asymmetry in both directions", () => {
    // Client input (cast tool): family forbidden. Server record (roleCast, as
    // used by dispatch_fusion and author_gate): family required. Any drift
    // that made these two schemas agree would break the derivation boundary.
    expect(castRoleAssignmentSchema.safeParse(clientCast).success).toBe(true);
    expect(castRoleAssignmentSchema.safeParse(serverCast).success).toBe(false);
    expect(roleCastSchema.safeParse(serverCast).success).toBe(true);
    expect(roleCastSchema.safeParse(clientCast).success).toBe(false);
  });

  it("defaults thinking to medium and cleanRoom to true", () => {
    // cleanRoom defaulting to false would silently drop clean-room isolation
    // for every cast that omits it.
    const parsed = castRoleAssignmentSchema.parse({
      role: "validator",
      model: "openai/gpt-5",
    });
    expect(parsed.thinking).toBe("medium");
    expect(parsed.cleanRoom).toBe(true);
  });

  it("rejects an unqualified model ref", () => {
    // family is derived from the `provider/` origin, so an unqualified ref
    // would resolve to "other" and poison the cross-family check.
    for (const model of ["gpt-5", "anthropic/", "/claude-opus-4", "anthropic /claude", "an", ""]) {
      const result = castRoleAssignmentSchema.safeParse({ role: "builder", model });
      expect(result.success, model).toBe(false);
    }
    expect(castRoleAssignmentSchema.safeParse({ role: "builder", model: "openrouter/anthropic/claude" }).success).toBe(
      true,
    );
  });

  it("rejects roles outside the agent role enum", () => {
    for (const role of ["captain", "admin", "root", "Builder", ""]) {
      expect(castRoleAssignmentSchema.safeParse({ role, model: "openai/gpt-5" }).success, role).toBe(false);
    }
  });
});

describe("resolve_cast", () => {
  it("rejects a family smuggled inside the roles array", () => {
    const issues = failure(
      resolveCastInputSchema.safeParse({
        taskId: ULID_TASK,
        roles: [clientCast, { ...clientCast, family: "openai" }],
      }),
    );
    expect(codes(issues)).toContain("unrecognized_keys");
    expect(paths(issues)).toContain("roles.1");
  });

  it("rejects an empty roles array", () => {
    // An empty cast would resolve dispatch with nobody assigned.
    const issues = failure(resolveCastInputSchema.safeParse({ taskId: ULID_TASK, roles: [] }));
    expect(codes(issues)).toContain("too_small");
  });

  it("defaults familyCheckOverride to false and refuses truthy non-booleans", () => {
    // The override is Captain-only evidence; it must never arrive implicitly
    // or via a coerced "true"/1.
    const parsed = resolveCastInputSchema.parse({ taskId: ULID_TASK, roles: [clientCast] });
    expect(parsed.familyCheckOverride).toBe(false);
    for (const value of ["true", 1, "yes", {}]) {
      const result = resolveCastInputSchema.safeParse({
        taskId: ULID_TASK,
        roles: [clientCast],
        familyCheckOverride: value,
      });
      expect(result.success, String(value)).toBe(false);
    }
  });

  it("rejects unknown top-level keys", () => {
    const issues = failure(
      resolveCastInputSchema.safeParse({ taskId: ULID_TASK, roles: [clientCast], family: "anthropic" }),
    );
    expect(codes(issues)).toContain("unrecognized_keys");
  });
});

describe("dispatch_fusion and author_gate — the family-carrying side", () => {
  it("requires family on every fusion cast", () => {
    const issues = failure(
      dispatchFusionInputSchema.safeParse({
        taskId: ULID_TASK,
        kind: "opinion",
        casts: [clientCast],
      }),
    );
    expect(paths(issues)).toContain("casts.0.family");
  });

  it("accepts server casts and leaves spawnSides absent when omitted", () => {
    // spawnSides must stay tri-state: omitted means "default by kind"
    // (opinion / plan-fusion spawn clean-room sides). A `.default(false)`
    // here would silently turn those spawns off.
    const parsed = dispatchFusionInputSchema.parse({
      taskId: ULID_TASK,
      kind: "opinion",
      casts: [serverCast],
    });
    expect(parsed.spawnSides).toBeUndefined();
    expect("spawnSides" in parsed).toBe(false);
    expect(parsed.vars).toEqual({});
    expect(dispatchFusionInputSchema.parse({ ...parsed, spawnSides: false }).spawnSides).toBe(false);
  });

  it("rejects unknown fusion kinds and an empty cast list", () => {
    for (const kind of ["review", "plan_fusion", "Fusion", ""]) {
      const result = dispatchFusionInputSchema.safeParse({ taskId: ULID_TASK, kind, casts: [serverCast] });
      expect(result.success, kind).toBe(false);
    }
    expect(
      dispatchFusionInputSchema.safeParse({ taskId: ULID_TASK, kind: "fusion", casts: [] }).success,
    ).toBe(false);
  });

  it("requires a single family-stamped validator cast on author_gate", () => {
    expect(
      authorGateInputSchema.safeParse({ taskId: ULID_TASK, validatorCast: serverCast }).success,
    ).toBe(true);
    expect(
      authorGateInputSchema.safeParse({ taskId: ULID_TASK, validatorCast: clientCast }).success,
    ).toBe(false);
    // One validator, not a list — a list would make "which family validated"
    // ambiguous.
    expect(
      authorGateInputSchema.safeParse({ taskId: ULID_TASK, validatorCast: [serverCast] }).success,
    ).toBe(false);
  });

  it("rejects an empty gate source string", () => {
    expect(
      authorGateInputSchema.safeParse({ taskId: ULID_TASK, validatorCast: serverCast, gateSource: "" }).success,
    ).toBe(false);
  });
});

describe("spawn_crewmate", () => {
  it("never accepts a client-supplied family", () => {
    const issues = failure(
      spawnCrewmateInputSchema.safeParse({
        taskId: ULID_TASK,
        role: "builder",
        model: "anthropic/claude-opus-4",
        family: "anthropic",
      }),
    );
    expect(codes(issues)).toContain("unrecognized_keys");
  });

  it("defaults the safety-relevant flags to their safe values", () => {
    // redBaselineOverride defaulting to true would bypass
    // red-baseline-before-builder on every spawn that omits it.
    const parsed = spawnCrewmateInputSchema.parse({
      taskId: ULID_TASK,
      role: "builder",
      model: "anthropic/claude-opus-4",
    });
    expect(parsed.redBaselineOverride).toBe(false);
    expect(parsed.cleanRoom).toBe(true);
    expect(parsed.thinking).toBe("medium");
    expect(parsed.vars).toEqual({});
  });

  it("rejects a non-boolean redBaselineOverride", () => {
    for (const value of ["true", 1, "1"]) {
      const result = spawnCrewmateInputSchema.safeParse({
        taskId: ULID_TASK,
        role: "builder",
        model: "anthropic/claude-opus-4",
        redBaselineOverride: value,
      });
      expect(result.success, String(value)).toBe(false);
    }
  });

  it("rejects empty string refs and non-string template vars", () => {
    const base = { taskId: ULID_TASK, role: "builder", model: "anthropic/claude-opus-4" };
    expect(spawnCrewmateInputSchema.safeParse({ ...base, prompt: "" }).success).toBe(false);
    expect(spawnCrewmateInputSchema.safeParse({ ...base, promptTemplateRef: "" }).success).toBe(false);
    expect(spawnCrewmateInputSchema.safeParse({ ...base, idempotencyKey: "" }).success).toBe(false);
    expect(spawnCrewmateInputSchema.safeParse({ ...base, vars: { n: 3 } }).success).toBe(false);
  });
});

describe("ULID discipline on task- and session-scoped tools", () => {
  const taskScoped = {
    read_task: readTaskInputSchema,
    deliver_task: deliverTaskInputSchema,
  } as const;

  it("rejects non-ULID task ids", () => {
    for (const [name, schema] of Object.entries(taskScoped)) {
      for (const bad of NON_ULIDS) {
        expect(schema.safeParse({ taskId: bad }).success, `${name}:${String(bad)}`).toBe(false);
      }
      expect(schema.safeParse({ taskId: ULID_TASK }).success, name).toBe(true);
    }
  });

  it("rejects non-ULID ids on tools that also require a reason", () => {
    const withReason = {
      cancel_task: cancelTaskInputSchema,
      resolve_delivery_block: resolveDeliveryBlockInputSchema,
    } as const;
    for (const [name, schema] of Object.entries(withReason)) {
      expect(schema.safeParse({ taskId: "not-a-ulid", reason: "because" }).success, name).toBe(false);
      expect(schema.safeParse({ taskId: ULID_TASK, reason: "" }).success, name).toBe(false);
      expect(schema.safeParse({ taskId: ULID_TASK }).success, name).toBe(false);
      expect(schema.safeParse({ taskId: ULID_TASK, reason: "because" }).success, name).toBe(true);
    }
  });

  it("rejects non-ULID session and question ids", () => {
    expect(stopCrewmateInputSchema.safeParse({ sessionId: "sess-1", reason: "stop" }).success).toBe(false);
    expect(stopCrewmateInputSchema.safeParse({ sessionId: ULID_SESSION, reason: "stop" }).success).toBe(true);
    expect(answerCrewmateInputSchema.safeParse({ questionId: "q-1", answer: "yes" }).success).toBe(false);
    expect(answerCrewmateInputSchema.safeParse({ questionId: ULID_SESSION, answer: "" }).success).toBe(false);
    expect(answerCrewmateInputSchema.safeParse({ questionId: ULID_SESSION, answer: "yes" }).success).toBe(true);
  });

  it("validates escalate_to_captain's taskId when present, but allows omission", () => {
    // `optional()` must not become "unvalidated".
    expect(escalateToCaptainInputSchema.safeParse({ summary: "help", taskId: "nope" }).success).toBe(false);
    expect(escalateToCaptainInputSchema.safeParse({ summary: "help", taskId: null }).success).toBe(false);
    expect(escalateToCaptainInputSchema.safeParse({ summary: "help" }).success).toBe(true);
  });

  it("requires a non-empty destination phase on advance_phase", () => {
    expect(advancePhaseInputSchema.safeParse({ taskId: ULID_TASK, to: "" }).success).toBe(false);
    expect(advancePhaseInputSchema.safeParse({ taskId: ULID_TASK }).success).toBe(false);
    expect(advancePhaseInputSchema.safeParse({ taskId: "x", to: "BUILDING" }).success).toBe(false);
    expect(advancePhaseInputSchema.safeParse({ taskId: ULID_TASK, to: "BUILDING" }).success).toBe(true);
  });
});

describe("update_task", () => {
  it("rejects an empty patch", () => {
    // An empty patch is a no-op that still burns a transition and an event;
    // the refine is the only thing stopping it.
    const issues = failure(updateTaskInputSchema.safeParse({ taskId: ULID_TASK, patch: {} }));
    expect(issues.length).toBeGreaterThan(0);
    expect(updateTaskInputSchema.safeParse({ taskId: ULID_TASK }).success).toBe(false);
  });

  it("rejects fields the Brain may not patch", () => {
    // Phase, cast, and yolo are substrate-owned; patching them here would let
    // the Brain move its own state machine without a transition check.
    for (const patch of [
      { phase: "DONE" },
      { yolo: true },
      { cast: [serverCast] },
      { projectId: ULID_PROJECT },
      { redProof: null },
    ]) {
      const result = updateTaskInputSchema.safeParse({ taskId: ULID_TASK, patch });
      expect(result.success, Object.keys(patch)[0]).toBe(false);
    }
  });

  it("accepts a single-field patch of the fields it owns", () => {
    expect(updateTaskInputSchema.safeParse({ taskId: ULID_TASK, patch: { title: "new" } }).success).toBe(true);
    expect(updateTaskInputSchema.safeParse({ taskId: ULID_TASK, patch: { mode: "direct-pr" } }).success).toBe(true);
    expect(updateTaskInputSchema.safeParse({ taskId: ULID_TASK, patch: { title: "" } }).success).toBe(false);
    expect(updateTaskInputSchema.safeParse({ taskId: ULID_TASK, patch: { mode: "yolo" } }).success).toBe(false);
  });
});

describe("stow_knowledge path containment", () => {
  const base = { projectId: ULID_PROJECT, notes: "some notes" };

  it("refuses to write outside docs/notes/", () => {
    const escapes = [
      "docs/notes/../../etc/passwd",
      "docs/notes/../secrets.md",
      "../docs/notes/x.md",
      "/etc/passwd",
      "docs/notes",
      "docs/notes/",
      "notes/x.md",
      "docs/notesx/y.md",
      "~/docs/notes/x.md",
      "docs/notes/a b.md",
      "docs/notes/x\\..\\y.md",
    ];
    for (const relativePath of escapes) {
      expect(stowKnowledgeInputSchema.safeParse({ ...base, relativePath }).success, relativePath).toBe(false);
    }
  });

  it("refuses empty and dot path segments", () => {
    for (const relativePath of ["docs/notes/a//b.md", "docs/notes/./b.md", "docs/notes/a/../b.md"]) {
      expect(stowKnowledgeInputSchema.safeParse({ ...base, relativePath }).success, relativePath).toBe(false);
    }
  });

  it("accepts nested paths under docs/notes/ and an omitted path", () => {
    expect(stowKnowledgeInputSchema.safeParse({ ...base, relativePath: "docs/notes/a/b-c_1.md" }).success).toBe(true);
    expect(stowKnowledgeInputSchema.safeParse(base).success).toBe(true);
    expect(stowKnowledgeInputSchema.safeParse({ ...base, notes: "" }).success).toBe(false);
  });
});

describe("captain-facing severity defaults", () => {
  it("escalate defaults to warn while notify defaults to info", () => {
    // These must not converge: an escalation silently defaulting to "info"
    // would drop out of the Captain's attention path.
    expect(escalateToCaptainInputSchema.parse({ summary: "wedged" }).severity).toBe("warn");
    expect(notifyCaptainInputSchema.parse({ summary: "fyi" }).severity).toBe("info");
  });

  it("rejects severities outside the enum and empty summaries", () => {
    for (const severity of ["fatal", "error", "INFO", ""]) {
      expect(escalateToCaptainInputSchema.safeParse({ summary: "x", severity }).success, severity).toBe(false);
      expect(notifyCaptainInputSchema.safeParse({ summary: "x", severity }).success, severity).toBe(false);
    }
    expect(notifyCaptainInputSchema.safeParse({ summary: "" }).success).toBe(false);
  });
});

describe("tool results and errors", () => {
  const result = toolResultSchema(z.strictObject({ id: z.ulid() }));

  it("will not let a failure masquerade as a success", () => {
    expect(result.safeParse({ ok: true, error: { code: "INTERNAL", message: "boom" } }).success).toBe(false);
    expect(
      result.safeParse({ ok: true, data: { id: ULID_TASK }, error: { code: "INTERNAL", message: "boom" } }).success,
    ).toBe(false);
    expect(result.safeParse({ ok: false, data: { id: ULID_TASK } }).success).toBe(false);
    expect(result.safeParse({ ok: false }).success).toBe(false);
  });

  it("requires a literal boolean discriminant", () => {
    for (const ok of ["true", 1, null, undefined]) {
      expect(result.safeParse({ ok, data: { id: ULID_TASK } }).success, String(ok)).toBe(false);
    }
    expect(result.safeParse({ ok: true, data: { id: ULID_TASK } }).success).toBe(true);
    expect(result.safeParse({ ok: false, error: { code: "NOT_FOUND", message: "gone" } }).success).toBe(true);
  });

  it("validates the payload rather than passing it through", () => {
    expect(result.safeParse({ ok: true, data: {} }).success).toBe(false);
    expect(result.safeParse({ ok: true, data: { id: "nope" } }).success).toBe(false);
    expect(createTaskResultSchema.safeParse({ ok: true, data: {} }).success).toBe(false);
    expect(createTaskResultSchema.safeParse({ ok: true, data: taskSnapshotFixture() }).success).toBe(true);
  });

  it("keeps the error code set closed and the error object strict", () => {
    for (const code of ["OOPS", "internal", "TIMEOUT", ""]) {
      expect(toolErrorSchema.safeParse({ code, message: "x" }).success, code).toBe(false);
    }
    expect(toolErrorSchema.safeParse({ code: "POLICY_VIOLATION", message: "x", retryable: true }).success).toBe(false);
    expect(toolErrorSchema.safeParse({ code: "POLICY_VIOLATION" }).success).toBe(false);
    expect(
      toolErrorSchema.safeParse({ code: "POLICY_VIOLATION", message: "x", details: { policyId: "p" } }).success,
    ).toBe(true);
  });
});

describe("toolInvocation audit record", () => {
  const invocation = {
    invocationId: ULID_SESSION,
    tool: "spawn_crewmate",
    taskId: ULID_TASK,
    ok: true,
    errorCode: null,
    durationMs: 12,
    ts: TS,
  };

  it("accepts a well-formed record", () => {
    expect(toolInvocationSchema.safeParse(invocation).success).toBe(true);
  });

  it("rejects tools outside the catalog", () => {
    expect(toolInvocationSchema.safeParse({ ...invocation, tool: "run_shell" }).success).toBe(false);
  });

  it("requires nullable audit fields to be stated, not omitted", () => {
    // `.nullable()` is not `.optional()`: a record that simply drops taskId or
    // errorCode must not validate, or absent evidence reads as null evidence.
    expect(toolInvocationSchema.safeParse(omit(invocation, "taskId")).success).toBe(false);
    expect(toolInvocationSchema.safeParse(omit(invocation, "errorCode")).success).toBe(false);
  });

  it("rejects impossible durations and malformed timestamps", () => {
    for (const durationMs of [-1, 1.5, Number.NaN, "12"]) {
      expect(toolInvocationSchema.safeParse({ ...invocation, durationMs }).success, String(durationMs)).toBe(false);
    }
    for (const ts of ["2026-07-24", "not-a-date", 1_753_000_000_000]) {
      expect(toolInvocationSchema.safeParse({ ...invocation, ts }).success, String(ts)).toBe(false);
    }
  });

  it("rejects unknown audit keys", () => {
    expect(toolInvocationSchema.safeParse({ ...invocation, actor: "brain" }).success).toBe(false);
  });
});

describe("read_fleet_state", () => {
  it("takes no arguments at all", () => {
    // A filter argument here would let the Brain narrow its own view of the
    // fleet; the tool is deliberately argument-free.
    expect(readFleetStateInputSchema.safeParse({}).success).toBe(true);
    expect(readFleetStateInputSchema.safeParse({ taskId: ULID_TASK }).success).toBe(false);
    expect(readFleetStateInputSchema.safeParse({ includeSessions: false }).success).toBe(false);
  });
});

// ── fleet.ts ───────────────────────────────────────────────────────────────

describe("afk FAQ — the pre-decided answer set", () => {
  const entry = { match: ["deploy"], answer: "yes, deploy", rationale: "pre-decided" };

  it("rejects an entry with no matchers", () => {
    // "ALL matchers must match" is vacuously true over an empty array, so an
    // empty `match` would answer every question the crew ever asks.
    expect(afkFaqEntrySchema.safeParse({ ...entry, match: [] }).success).toBe(false);
  });

  it("rejects an empty-string matcher", () => {
    // "" is a substring of every question — same auto-answer-everything hole,
    // one level down.
    expect(afkFaqEntrySchema.safeParse({ ...entry, match: [""] }).success).toBe(false);
    expect(afkFaqEntrySchema.safeParse({ ...entry, match: ["deploy", ""] }).success).toBe(false);
  });

  it("requires both an answer and a rationale", () => {
    expect(afkFaqEntrySchema.safeParse({ match: ["deploy"], answer: "yes" }).success).toBe(false);
    expect(afkFaqEntrySchema.safeParse({ ...entry, answer: "" }).success).toBe(false);
    expect(afkFaqEntrySchema.safeParse({ ...entry, rationale: "" }).success).toBe(false);
    expect(afkFaqEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("keeps the afk request strict about how the posture is armed", () => {
    expect(afkRequestSchema.safeParse({ armed: true }).success).toBe(true);
    expect(afkRequestSchema.safeParse({ armed: true, until: null }).success).toBe(true);
    expect(afkRequestSchema.safeParse({}).success).toBe(false);
    expect(afkRequestSchema.safeParse({ armed: "true" }).success).toBe(false);
    expect(afkRequestSchema.safeParse({ armed: true, until: "tomorrow" }).success).toBe(false);
    // A second FAQ channel would bypass "faq replaces the recorded entries".
    expect(afkRequestSchema.safeParse({ armed: true, faqAppend: [entry] }).success).toBe(false);
    expect(afkRequestSchema.safeParse({ armed: true, faq: [{ ...entry, match: [] }] }).success).toBe(false);
  });
});

describe("brain snapshot", () => {
  it("accepts a complete snapshot", () => {
    expect(brainSnapshotSchema.safeParse(brainSnapshotFixture()).success).toBe(true);
  });

  it("requires every nullable field to be present", () => {
    for (const key of Object.keys(brainSnapshotFixture())) {
      expect(brainSnapshotSchema.safeParse(omit(brainSnapshotFixture(), key)).success, `omitted ${key}`).toBe(false);
    }
  });

  it("rejects unknown statuses and an impossible wake queue depth", () => {
    for (const status of ["stopped", "idle", "Running"]) {
      expect(brainSnapshotSchema.safeParse({ ...brainSnapshotFixture(), status }).success, status).toBe(false);
    }
    for (const wakeQueueDepth of [-1, 2.5, "0"]) {
      expect(
        brainSnapshotSchema.safeParse({ ...brainSnapshotFixture(), wakeQueueDepth }).success,
        String(wakeQueueDepth),
      ).toBe(false);
    }
  });

  it("rejects a provider outside the Pi provider set", () => {
    expect(brainSnapshotSchema.safeParse({ ...brainSnapshotFixture(), provider: "ollama" }).success).toBe(false);
    expect(brainSnapshotSchema.safeParse({ ...brainSnapshotFixture(), family: "llama" }).success).toBe(false);
  });
});

describe("worktree leases and wake digests", () => {
  const lease = {
    id: ULID_SESSION,
    projectId: ULID_PROJECT,
    path: "/tmp/wt",
    state: "leased",
    taskId: ULID_TASK,
    sessionId: ULID_SESSION,
    branch: "feat/x",
    leasedAt: TS,
    lastSha: "abc",
  };

  it("keeps the lease state set closed", () => {
    expect(worktreeLeaseSchema.safeParse(lease).success).toBe(true);
    for (const state of ["dirty", "free", "Idle", "released"]) {
      expect(worktreeLeaseSchema.safeParse({ ...lease, state }).success, state).toBe(false);
    }
  });

  it("requires ULID or explicit null for the task and session links", () => {
    expect(worktreeLeaseSchema.safeParse({ ...lease, taskId: null, sessionId: null }).success).toBe(true);
    expect(worktreeLeaseSchema.safeParse({ ...lease, taskId: "task-1" }).success).toBe(false);
    expect(worktreeLeaseSchema.safeParse(omit(lease, "sessionId")).success).toBe(false);
  });

  it("allows quarantineReason but nothing else", () => {
    expect(worktreeLeaseSchema.safeParse({ ...lease, state: "quarantined", quarantineReason: "dirty" }).success).toBe(
      true,
    );
    expect(worktreeLeaseSchema.safeParse({ ...lease, dirtyPaths: ["a"] }).success).toBe(false);
  });

  it("keeps the wake class set closed", () => {
    const digest = {
      id: ULID_SESSION,
      class: "GATE_FAILED",
      taskId: ULID_TASK,
      sessionId: null,
      summary: "gate failed",
      absorbed: false,
      deliveredToBrain: false,
      createdAt: TS,
    };
    expect(wakeDigestSchema.safeParse(digest).success).toBe(true);
    for (const wakeClass of ["IDLE", "gate_failed", "ERROR", ""]) {
      expect(wakeDigestSchema.safeParse({ ...digest, class: wakeClass }).success, wakeClass).toBe(false);
    }
    expect(wakeDigestSchema.safeParse(omit(digest, "absorbed")).success).toBe(false);
  });
});

describe("fleet state snapshot", () => {
  function snapshot(): Record<string, unknown> {
    return {
      brain: brainSnapshotFixture(),
      tasks: [taskSnapshotFixture()],
      sessions: [],
      worktrees: [],
      wakeQueue: [],
      projects: [],
      brainDown: false,
      generatedAt: TS,
    };
  }

  it("accepts a complete snapshot and rejects unknown top-level keys", () => {
    expect(fleetStateSnapshotSchema.safeParse(snapshot()).success).toBe(true);
    expect(fleetStateSnapshotSchema.safeParse({ ...snapshot(), secrets: {} }).success).toBe(false);
  });

  it("requires every collection to be stated", () => {
    for (const key of ["tasks", "sessions", "worktrees", "wakeQueue", "projects", "brain", "brainDown"]) {
      expect(fleetStateSnapshotSchema.safeParse(omit(snapshot(), key)).success, `omitted ${key}`).toBe(false);
    }
  });

  it("validates nested members rather than trusting the array", () => {
    const issues = failure(
      fleetStateSnapshotSchema.safeParse({
        ...snapshot(),
        sessions: [
          {
            sessionId: ULID_SESSION,
            taskId: ULID_TASK,
            role: "builder",
            model: "anthropic/claude-opus-4",
            thinking: "high",
            // family omitted — the substrate always derives and stamps it.
            tmuxWindow: "w1",
            status: "running",
            worktreePath: null,
            startedAt: TS,
          },
        ],
      }),
    );
    expect(paths(issues)).toContain("sessions.0.family");
  });
});

describe("fleet summary counters", () => {
  const summary = {
    active: 1,
    queued: 0,
    needsCaptain: 0,
    doneToday: 4,
    failed: 0,
    brain: brainSnapshotFixture(),
    brainDown: false,
  };

  it("accepts non-negative integer counters", () => {
    expect(fleetSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("rejects negative, fractional, and stringly-typed counters", () => {
    for (const key of ["active", "queued", "needsCaptain", "doneToday", "failed"]) {
      for (const value of [-1, 1.5, "2", null]) {
        expect(fleetSummarySchema.safeParse({ ...summary, [key]: value }).success, `${key}=${String(value)}`).toBe(
          false,
        );
      }
    }
  });
});

describe("console projections", () => {
  it("requires ULIDs for the task and project ids on a list row", () => {
    const row = {
      id: ULID_TASK,
      shape: "SHIP",
      title: "t",
      phase: "BUILDING",
      projectId: ULID_PROJECT,
      projectName: null,
      mode: "pipeline",
      model: null,
      agent: null,
      updatedAt: TS,
      createdAt: TS,
    };
    expect(taskListItemSchema.safeParse(row).success).toBe(true);
    expect(taskListItemSchema.safeParse({ ...row, id: "task-1" }).success).toBe(false);
    expect(taskListItemSchema.safeParse({ ...row, projectId: "proj-1" }).success).toBe(false);
    expect(taskListItemSchema.safeParse({ ...row, phase: "IN_PROGRESS" }).success).toBe(false);
    expect(taskListItemSchema.safeParse({ ...row, shape: "ship" }).success).toBe(false);
    expect(taskListItemSchema.safeParse(omit(row, "projectName")).success).toBe(false);
  });

  it("keeps the project record strict about trust fields", () => {
    const project = {
      id: ULID_PROJECT,
      name: "agent-os",
      path: "/repo",
      mode: "pipeline",
      trusted: true,
      trustHash: "sha256:abc",
      yolo: false,
      createdAt: TS,
      updatedAt: TS,
    };
    expect(projectRecordSchema.safeParse(project).success).toBe(true);
    // A trusted project must carry an explicit hash slot; omission must not
    // read as "trusted, hash unknown".
    expect(projectRecordSchema.safeParse(omit(project, "trustHash")).success).toBe(false);
    expect(projectRecordSchema.safeParse({ ...project, trusted: "yes" }).success).toBe(false);
    expect(projectRecordSchema.safeParse({ ...project, secrets: { token: "t" } }).success).toBe(false);
    expect(projectRecordSchema.safeParse({ ...project, mode: "yolo" }).success).toBe(false);
  });
});
