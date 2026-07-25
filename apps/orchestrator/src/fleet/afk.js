import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const STATE_FILE = "afk.json";
export class AfkService {
    home;
    sink = () => undefined;
    statePath;
    constructor(home) {
        this.home = home;
        mkdirSync(home, { recursive: true, mode: 0o700 });
        this.statePath = join(home, STATE_FILE);
    }
    onEvent(sink) {
        this.sink = sink;
    }
    state() {
        if (!existsSync(this.statePath)) {
            return { armed: false, until: null, faq: [], answered: 0, escalated: 0 };
        }
        try {
            return JSON.parse(readFileSync(this.statePath, "utf8"));
        }
        catch {
            return { armed: false, until: null, faq: [], answered: 0, escalated: 0 };
        }
    }
    save(state) {
        writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    }
    /** Arm AFK, optionally until a deadline. FAQ entries are the whole mandate. */
    arm(input) {
        const previous = this.state();
        const next = {
            armed: true,
            until: input.untilIso ?? null,
            faq: input.faq ?? previous.faq,
            answered: previous.answered,
            escalated: previous.escalated,
        };
        this.save(next);
        this.sink({
            type: "afk.changed",
            payload: { armed: true, until: next.until, faqEntries: next.faq.length },
        });
        return next;
    }
    disarm() {
        const previous = this.state();
        const next = { ...previous, armed: false, until: null };
        this.save(next);
        this.sink({
            type: "afk.changed",
            payload: { armed: false, until: null, faqEntries: next.faq.length },
        });
        return next;
    }
    /** True only while armed AND before the deadline — an expired posture is off. */
    isActive(now = Date.now()) {
        const state = this.state();
        if (!state.armed)
            return false;
        if (state.until === null)
            return true;
        const until = Date.parse(state.until);
        return Number.isFinite(until) ? now < until : true;
    }
    /**
     * Try to answer a crewmate question from the recorded FAQ.
     * Returns null when nothing matches — the caller must then escalate and wait,
     * which is the correct behaviour for anything the Captain has not pre-decided.
     */
    tryAnswer(question) {
        if (!this.isActive())
            return null;
        const state = this.state();
        const haystack = question.toLowerCase();
        for (const entry of state.faq) {
            if (entry.match.length === 0)
                continue;
            const matches = entry.match.every((needle) => haystack.includes(needle.toLowerCase()));
            if (matches) {
                this.save({ ...state, answered: state.answered + 1 });
                this.sink({
                    type: "afk.auto_answered",
                    payload: {
                        question: question.slice(0, 500),
                        rationale: entry.rationale,
                        matched: entry.match,
                    },
                });
                return { answer: entry.answer, rationale: entry.rationale };
            }
        }
        this.save({ ...state, escalated: state.escalated + 1 });
        return null;
    }
}
