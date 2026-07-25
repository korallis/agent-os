import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export class SecondmateRegistry {
    root;
    sink = () => undefined;
    constructor(agentosHome) {
        this.root = join(agentosHome, "secondmates");
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }
    onEvent(sink) {
        this.sink = sink;
    }
    list() {
        if (!existsSync(this.root))
            return [];
        const out = [];
        for (const entry of readdirSync(this.root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const metaPath = join(this.root, entry.name, "charter.json");
            if (!existsSync(metaPath))
                continue;
            try {
                out.push(JSON.parse(readFileSync(metaPath, "utf8")));
            }
            catch {
                // skip
            }
        }
        return out;
    }
    /**
     * Provision an isolated secondmate home. Refuses if name exists.
     * Does NOT copy auth material (fs scan gate).
     */
    provision(input) {
        const safe = input.name.replace(/[^a-z0-9_-]/gi, "").toLowerCase();
        if (safe.length === 0) {
            throw new Error("invalid secondmate name");
        }
        const home = join(this.root, safe);
        if (existsSync(home)) {
            throw new Error(`secondmate already exists: ${safe}`);
        }
        const existing = this.list();
        const port = input.port ?? 4710 + existing.length;
        mkdirSync(home, { recursive: true, mode: 0o700 });
        mkdirSync(join(home, "config"), { recursive: true, mode: 0o700 });
        mkdirSync(join(home, "runs"), { recursive: true, mode: 0o700 });
        // Explicitly no auth/ or secrets/ directories — broker grants only.
        const record = {
            name: safe,
            home,
            port,
            domain: input.domain,
            brainModel: input.brainModel ?? null,
            createdAt: new Date().toISOString(),
        };
        writeFileSync(join(home, "charter.json"), `${JSON.stringify(record, null, 2)}\n`, {
            mode: 0o600,
        });
        // Event reserved for Phase 7 full protocol; use captain.escalation as notice for now.
        this.sink({
            type: "captain.escalation",
            payload: {
                taskId: null,
                summary: `secondmate provisioned: ${safe} on :${port}`,
                severity: "info",
            },
        });
        return record;
    }
    /** Fs-scan: no auth.json / credentials under secondmate homes. */
    auditNoAuthMaterial() {
        const offenders = [];
        for (const sm of this.list()) {
            const banned = [
                join(sm.home, "auth.json"),
                join(sm.home, "pi", "agent", "auth.json"),
                join(sm.home, "secrets"),
                join(sm.home, "daemon.token"),
            ];
            for (const path of banned) {
                if (existsSync(path))
                    offenders.push(path);
            }
        }
        return { ok: offenders.length === 0, offenders };
    }
}
