import { LEGAL_TASK_TRANSITIONS, TERMINAL_TASK_PHASES, } from "@agent-os/protocol";
/**
 * Typed task state machine (master plan §5.3).
 * The substrate validates transitions; the Brain only chooses among legal ones.
 */
export class IllegalTransitionError extends Error {
    from;
    to;
    taskId;
    code = "ILLEGAL_TRANSITION";
    constructor(from, to, taskId) {
        super(`illegal transition ${from} → ${to} for task ${taskId}`);
        this.from = from;
        this.to = to;
        this.taskId = taskId;
        this.name = "IllegalTransitionError";
    }
}
export function isTerminalPhase(phase) {
    return TERMINAL_TASK_PHASES.includes(phase);
}
export function canTransition(from, to, options = {}) {
    if (from === to)
        return true;
    const allowed = LEGAL_TASK_TRANSITIONS[from];
    if (allowed.includes(to))
        return true;
    // Policy-off only: restore the historic skip-to-BUILDING edges so builders
    // can still start without a RED proof when redBaselineGateRequired is false.
    if (options.redBaselineRequired === false &&
        to === "BUILDING" &&
        (from === "DISPATCH_RESOLVED" || from === "PLAN_FUSED")) {
        return true;
    }
    return false;
}
/** Throws IllegalTransitionError when the move is not legal. */
export function assertTransition(taskId, from, to, options = {}) {
    if (!canTransition(from, to, options)) {
        throw new IllegalTransitionError(from, to, taskId);
    }
}
/**
 * Phases in which `run_gate` is legal.
 * Baseline may re-run from BUILDING/VALIDATING so a mid-build gate revision can
 * re-prove RED; candidate still requires a current proof for this source hash.
 */
export function canRunGate(phase, target) {
    if (target === "baseline") {
        return (phase === "GATE_AUTHORING" ||
            phase === "GATE_RED_VERIFIED" ||
            phase === "PLAN_FUSED" ||
            phase === "BUILDING" ||
            phase === "VALIDATING");
    }
    return phase === "VALIDATING" || phase === "BUILDING" || phase === "GATE_RED_VERIFIED";
}
/**
 * Phases where a builder crewmate may be spawned.
 * When red-baseline policy is on, only GATE_RED_VERIFIED plus the rebuild/retry
 * loop (BUILDING, WAITING_WORKTREE). When off, also DISPATCH_RESOLVED / PLAN_FUSED.
 */
export function canSpawnBuilder(phase, options = {}) {
    const rebuildLoop = phase === "GATE_RED_VERIFIED" ||
        phase === "BUILDING" ||
        phase === "WAITING_WORKTREE";
    if (options.redBaselineRequired === true) {
        return rebuildLoop;
    }
    return rebuildLoop || phase === "DISPATCH_RESOLVED" || phase === "PLAN_FUSED";
}
/** Phases where a scout may be spawned (requires a resolved cast). */
export function canSpawnScout(phase) {
    return phase === "DISPATCH_RESOLVED" || phase === "BUILDING";
}
