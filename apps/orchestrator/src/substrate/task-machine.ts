import {
  LEGAL_TASK_TRANSITIONS,
  TERMINAL_TASK_PHASES,
  type TaskPhase,
} from "@agent-os/protocol";

/**
 * Typed task state machine (master plan §5.3).
 * The substrate validates transitions; the Brain only chooses among legal ones.
 */

export class IllegalTransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION" as const;

  constructor(
    readonly from: TaskPhase,
    readonly to: TaskPhase,
    readonly taskId: string,
  ) {
    super(`illegal transition ${from} → ${to} for task ${taskId}`);
    this.name = "IllegalTransitionError";
  }
}

export function isTerminalPhase(phase: TaskPhase): boolean {
  return (TERMINAL_TASK_PHASES as readonly string[]).includes(phase);
}

export type TransitionPolicyOptions = {
  /**
   * When true (default for the strict table), DISPATCH_RESOLVED/PLAN_FUSED may
   * not jump straight to BUILDING. When false, those skip edges are restored
   * for deployments that turn red-baseline off.
   */
  redBaselineRequired?: boolean;
};

export function canTransition(
  from: TaskPhase,
  to: TaskPhase,
  options: TransitionPolicyOptions = {},
): boolean {
  if (from === to) return true;
  const allowed = LEGAL_TASK_TRANSITIONS[from];
  if (allowed.includes(to)) return true;
  // Policy-off only: restore the historic skip-to-BUILDING edges so builders
  // can still start without a RED proof when redBaselineGateRequired is false.
  if (
    options.redBaselineRequired === false &&
    to === "BUILDING" &&
    (from === "DISPATCH_RESOLVED" || from === "PLAN_FUSED")
  ) {
    return true;
  }
  return false;
}

/** Throws IllegalTransitionError when the move is not legal. */
export function assertTransition(
  taskId: string,
  from: TaskPhase,
  to: TaskPhase,
  options: TransitionPolicyOptions = {},
): void {
  if (!canTransition(from, to, options)) {
    throw new IllegalTransitionError(from, to, taskId);
  }
}

/**
 * Phases in which `run_gate` is legal.
 * Baseline RED proof is required before BUILDING when red-baseline policy is on.
 */
export function canRunGate(phase: TaskPhase, target: "baseline" | "candidate"): boolean {
  if (target === "baseline") {
    return phase === "GATE_AUTHORING" || phase === "GATE_RED_VERIFIED" || phase === "PLAN_FUSED";
  }
  return phase === "VALIDATING" || phase === "BUILDING" || phase === "GATE_RED_VERIFIED";
}

/**
 * Phases where a builder crewmate may be spawned.
 * When red-baseline policy is on, only GATE_RED_VERIFIED plus the rebuild/retry
 * loop (BUILDING, WAITING_WORKTREE). When off, also DISPATCH_RESOLVED / PLAN_FUSED.
 */
export function canSpawnBuilder(
  phase: TaskPhase,
  options: { redBaselineRequired?: boolean } = {},
): boolean {
  const rebuildLoop =
    phase === "GATE_RED_VERIFIED" ||
    phase === "BUILDING" ||
    phase === "WAITING_WORKTREE";
  if (options.redBaselineRequired === true) {
    return rebuildLoop;
  }
  return rebuildLoop || phase === "DISPATCH_RESOLVED" || phase === "PLAN_FUSED";
}

/** Phases where a scout may be spawned (requires a resolved cast). */
export function canSpawnScout(phase: TaskPhase): boolean {
  return phase === "DISPATCH_RESOLVED" || phase === "BUILDING";
}
