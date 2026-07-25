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

export function canTransition(from: TaskPhase, to: TaskPhase): boolean {
  if (from === to) return true;
  const allowed = LEGAL_TASK_TRANSITIONS[from];
  return allowed.includes(to);
}

/** Throws IllegalTransitionError when the move is not legal. */
export function assertTransition(taskId: string, from: TaskPhase, to: TaskPhase): void {
  if (!canTransition(from, to)) {
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

/** Phases where a builder crewmate may be spawned. */
export function canSpawnBuilder(phase: TaskPhase): boolean {
  return (
    phase === "DISPATCH_RESOLVED" ||
    phase === "GATE_RED_VERIFIED" ||
    phase === "PLAN_FUSED" ||
    phase === "BUILDING" ||
    phase === "WAITING_WORKTREE"
  );
}

/** Phases where a scout may be spawned (requires a resolved cast). */
export function canSpawnScout(phase: TaskPhase): boolean {
  return phase === "DISPATCH_RESOLVED" || phase === "BUILDING";
}
