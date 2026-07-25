import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AfkState, OrchestratorEvent } from "@agent-os/protocol";

/**
 * `/afk` — autonomy posture (master plan §11 Phase 8).
 *
 * While the Captain is away, routine questions from crewmates should not stall
 * the fleet for hours. AFK lets the Brain answer questions it can answer from
 * recorded FAQ entries, and ONLY those.
 *
 * The deliberate boundary: AFK never invents an answer. A question that does
 * not match a recorded FAQ still escalates and still waits. Auto-answering
 * something the Captain never actually decided would be worse than the delay —
 * the crewmate would proceed on a fabricated instruction and the Captain would
 * discover it later in the diff.
 */

export interface AfkFaqEntry {
  /** Case-insensitive substrings; ALL must appear for the entry to match. */
  match: string[];
  answer: string;
  /** Why the Captain pre-authorised this answer — carried into the audit. */
  rationale: string;
}

export type AfkEventSink = (event: OrchestratorEvent) => void;

const STATE_FILE = "afk.json";

export class AfkService {
  private sink: AfkEventSink = () => undefined;
  private readonly statePath: string;

  constructor(private readonly home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.statePath = join(home, STATE_FILE);
  }

  onEvent(sink: AfkEventSink): void {
    this.sink = sink;
  }

  state(): AfkState {
    if (!existsSync(this.statePath)) {
      return { armed: false, until: null, faq: [], answered: 0, escalated: 0 };
    }
    try {
      return JSON.parse(readFileSync(this.statePath, "utf8")) as AfkState;
    } catch {
      return { armed: false, until: null, faq: [], answered: 0, escalated: 0 };
    }
  }

  private save(state: AfkState): void {
    writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  /** Arm AFK, optionally until a deadline. FAQ entries are the whole mandate. */
  arm(input: { untilIso?: string | null; faq?: AfkFaqEntry[] }): AfkState {
    const previous = this.state();
    const next: AfkState = {
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

  disarm(): AfkState {
    const previous = this.state();
    const next: AfkState = { ...previous, armed: false, until: null };
    this.save(next);
    this.sink({
      type: "afk.changed",
      payload: { armed: false, until: null, faqEntries: next.faq.length },
    });
    return next;
  }

  /** True only while armed AND before the deadline — an expired posture is off. */
  isActive(now = Date.now()): boolean {
    const state = this.state();
    if (!state.armed) return false;
    if (state.until === null) return true;
    const until = Date.parse(state.until);
    return Number.isFinite(until) ? now < until : true;
  }

  /**
   * Try to answer a crewmate question from the recorded FAQ.
   * Returns null when nothing matches — the caller must then escalate and wait,
   * which is the correct behaviour for anything the Captain has not pre-decided.
   */
  tryAnswer(question: string): { answer: string; rationale: string } | null {
    if (!this.isActive()) return null;
    const state = this.state();
    const haystack = question.toLowerCase();
    for (const entry of state.faq) {
      if (entry.match.length === 0) continue;
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
