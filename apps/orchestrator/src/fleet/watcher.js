import { monotonicFactory } from "ulid";
const nextUlid = monotonicFactory();
/**
 * Zero-token wake classification (master plan §5.6).
 * Absorbs benign wakes per supervision.absorb; queues actionable digests for the Brain.
 * Classification never calls an LLM.
 */
export class WakeWatcher {
    sink = () => undefined;
    deliver = () => undefined;
    config;
    queue = [];
    history = [];
    brainDown = false;
    constructor(config) {
        this.config = config;
    }
    onEvent(sink) {
        this.sink = sink;
    }
    onDeliver(deliver) {
        this.deliver = deliver;
    }
    updateConfig(config) {
        this.config = config;
    }
    setBrainDown(down) {
        this.brainDown = down;
    }
    getQueue() {
        return [...this.queue];
    }
    getHistory(limit = 100) {
        return this.history.slice(-limit);
    }
    queueDepth() {
        return this.queue.length;
    }
    /**
     * Classify and either absorb or queue/deliver a wake.
     * Returns the digest (whether absorbed or not).
     */
    classify(input) {
        const absorbed = this.shouldAbsorb(input.class, input.contextUsedPct);
        const digest = {
            id: nextUlid(),
            class: input.class,
            taskId: input.taskId ?? null,
            sessionId: input.sessionId ?? null,
            summary: input.summary,
            detail: input.detail,
            absorbed,
            deliveredToBrain: false,
            createdAt: new Date().toISOString(),
        };
        if (absorbed) {
            this.history.push(digest);
            this.sink({
                type: "wake.classified",
                payload: {
                    wakeId: digest.id,
                    class: digest.class,
                    taskId: digest.taskId,
                    sessionId: digest.sessionId,
                    absorbed: true,
                    deliveredToBrain: false,
                    summary: digest.summary,
                },
            });
            return digest;
        }
        if (this.brainDown) {
            this.queue.push(digest);
            this.history.push(digest);
            this.sink({
                type: "wake.classified",
                payload: {
                    wakeId: digest.id,
                    class: digest.class,
                    taskId: digest.taskId,
                    sessionId: digest.sessionId,
                    absorbed: false,
                    deliveredToBrain: false,
                    summary: digest.summary,
                },
            });
            return digest;
        }
        digest.deliveredToBrain = true;
        this.history.push(digest);
        this.sink({
            type: "wake.classified",
            payload: {
                wakeId: digest.id,
                class: digest.class,
                taskId: digest.taskId,
                sessionId: digest.sessionId,
                absorbed: false,
                deliveredToBrain: true,
                summary: digest.summary,
            },
        });
        this.deliver(digest);
        return digest;
    }
    /** Drain queued wakes after Brain recovery. */
    drainQueue() {
        const pending = this.queue.splice(0, this.queue.length);
        for (const digest of pending) {
            const delivered = { ...digest, deliveredToBrain: true };
            this.deliver(delivered);
        }
        return pending;
    }
    shouldAbsorb(wakeClass, contextUsedPct) {
        const absorb = this.config.absorb;
        if (wakeClass === "PROGRESS" && absorb.includes("PROGRESS"))
            return true;
        if (wakeClass === "TURN_SETTLED" && absorb.includes("TURN_SETTLED_MID_STAGE"))
            return true;
        if (wakeClass === "STALE" && absorb.includes("STALE"))
            return true;
        if (wakeClass === "CONTEXT_PRESSURE" &&
            absorb.includes("CONTEXT_PRESSURE_LT_70") &&
            (contextUsedPct === undefined || contextUsedPct < 70)) {
            return true;
        }
        return false;
    }
}
