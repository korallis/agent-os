import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAttributedSpans } from "@agent-os/fusion-core";
/**
 * Durable fusion run artifacts (master plan §6.3, §7.4).
 *
 * Layout: `<home>/runs/<taskId>/fusion/<runId>/`
 *   run.json            — the FusionRun record (casts, hashes, telemetry)
 *   instruction.md      — the rendered instruction every side received
 *   side-<i>-<model>.md — each side's artifact (index + model, never role alone)
 *   fused.md            — the fused artifact (kind=fusion)
 *
 * Files are the truth; the REST surface is a reader of them.
 */
export class FusionRunStore {
    home;
    constructor(home) {
        this.home = home;
    }
    dir(taskId, runId) {
        return join(this.home, "runs", taskId, "fusion", runId);
    }
    create(run) {
        const dir = this.dir(run.taskId, run.runId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.save(run);
        return dir;
    }
    save(run) {
        const dir = this.dir(run.taskId, run.runId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    }
    get(taskId, runId) {
        const path = join(this.dir(taskId, runId), "run.json");
        if (!existsSync(path))
            return null;
        try {
            return JSON.parse(readFileSync(path, "utf8"));
        }
        catch {
            return null;
        }
    }
    writeInstruction(taskId, runId, content) {
        const path = join(this.dir(taskId, runId), "instruction.md");
        writeFileSync(path, content, { mode: 0o600 });
        return path;
    }
    /**
     * Persist one side's answer. Filename includes side index and model so a
     * dual-planner /opinion (two roles named "planner") never collides.
     */
    writeSideArtifact(taskId, runId, sideIndex, model, content) {
        const dir = this.dir(taskId, runId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `side-${sideIndex}-${sanitize(model)}.md`);
        writeFileSync(path, content, { mode: 0o600 });
        return path;
    }
    writeFused(taskId, runId, content) {
        const path = join(this.dir(taskId, runId), "fused.md");
        writeFileSync(path, content, { mode: 0o600 });
        return path;
    }
    /**
     * Record per-side telemetry as `ext.usage` frames arrive for its session.
     * Prefer `sideIndex` from the ownership map so early frames still land before
     * (or without) a durable sessionId on the row.
     */
    recordSideUsage(taskId, runId, sessionId, usage, sideIndex) {
        const run = this.get(taskId, runId);
        if (run === null)
            return;
        const sides = run.sides.map((side, i) => {
            const matches = sideIndex !== undefined ? i === sideIndex : side.sessionId === sessionId;
            if (!matches)
                return side;
            return {
                ...side,
                sessionId: side.sessionId ?? sessionId,
                inputTokens: sum(side.inputTokens, usage.inputTokens),
                outputTokens: sum(side.outputTokens, usage.outputTokens),
                costUsd: sum(side.costUsd, usage.costUsd),
            };
        });
        this.save({ ...run, sides });
    }
    listForTask(taskId) {
        const root = join(this.home, "runs", taskId, "fusion");
        if (!existsSync(root))
            return [];
        const out = [];
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const run = this.get(taskId, entry.name);
            if (run !== null)
                out.push(run);
        }
        return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    detail(taskId, runId) {
        const run = this.get(taskId, runId);
        if (run === null)
            return null;
        const dir = this.dir(taskId, runId);
        const read = (name) => {
            const path = join(dir, name);
            return existsSync(path) ? readFileSync(path, "utf8") : null;
        };
        const fused = read("fused.md");
        const sideArtifacts = run.sides
            .map((side) => {
            const content = side.artifactPath !== null && existsSync(side.artifactPath)
                ? readFileSync(side.artifactPath, "utf8")
                : null;
            return content === null
                ? null
                : { role: side.role, model: side.model, content };
        })
            .filter((s) => s !== null);
        return {
            run,
            instruction: read("instruction.md"),
            fused,
            spans: fused === null
                ? []
                : parseAttributedSpans(fused).map((s) => ({ tag: s.tag, body: s.body })),
            sideArtifacts,
        };
    }
}
function sanitize(part) {
    return part.replace(/[^A-Za-z0-9._-]/g, "_");
}
function sum(a, b) {
    if (a === null && b === null)
        return null;
    return (a ?? 0) + (b ?? 0);
}
/** Basename helper for tests / callers that only have a path. */
export function sideArtifactBasename(sideIndex, model) {
    return `side-${sideIndex}-${sanitize(model)}.md`;
}
