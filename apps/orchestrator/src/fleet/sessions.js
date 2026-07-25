import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, } from "node:fs";
import { join } from "node:path";
/**
 * Per-model persistent session keys (master plan §6.3).
 *
 * A session directory is keyed by {project, role, provider/model}. Changing any
 * component yields a different key and therefore a different directory — one
 * model's transcript is never replayed as another model's context, which is the
 * whole point of running a cross-family cast.
 */
export class SessionKeyStore {
    root;
    constructor(home) {
        this.root = join(home, "sessions");
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
    }
    static computeKey(input) {
        return createHash("sha256")
            .update(`${input.projectId}|${input.role}|${input.model}`)
            .digest("hex")
            .slice(0, 32);
    }
    /**
     * Return (creating if needed) the session directory for this key. Existing
     * directories are reused so a restart resumes the same transcript; a changed
     * model produces a different key and thus a fresh directory.
     */
    ensure(input) {
        const key = SessionKeyStore.computeKey(input);
        const dir = join(this.root, key);
        const metaPath = join(dir, "session.json");
        if (existsSync(metaPath)) {
            try {
                return JSON.parse(readFileSync(metaPath, "utf8"));
            }
            catch {
                // fall through and rewrite corrupt metadata
            }
        }
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const record = {
            key,
            projectId: input.projectId,
            role: input.role,
            model: input.model,
            dir,
            createdAt: new Date().toISOString(),
        };
        writeFileSync(metaPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        return record;
    }
    /**
     * True when the durable key directory already exists. missingRoles treats dir
     * presence as "role present", so callers that create a key before a successful
     * spawn must remove a newly created dir on failure.
     */
    has(input) {
        return existsSync(join(this.root, SessionKeyStore.computeKey(input)));
    }
    /**
     * Delete a session key directory. Used when spawn fails after ensure so an
     * empty orphan cannot make missingRoles believe the role is present.
     */
    remove(input) {
        const dir = join(this.root, SessionKeyStore.computeKey(input));
        if (!existsSync(dir))
            return;
        rmSync(dir, { recursive: true, force: true });
    }
    get(key) {
        const metaPath = join(this.root, key, "session.json");
        if (!existsSync(metaPath))
            return null;
        try {
            return JSON.parse(readFileSync(metaPath, "utf8"));
        }
        catch {
            return null;
        }
    }
    list() {
        if (!existsSync(this.root))
            return [];
        const out = [];
        for (const entry of readdirSync(this.root, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const record = this.get(entry.name);
            if (record !== null)
                out.push(record);
        }
        return out.sort((a, b) => a.key.localeCompare(b.key));
    }
    /**
     * Roles from `expected` that have no session directory yet — i.e. exactly the
     * roles a restart must respawn, leaving surviving ones untouched.
     */
    missingRoles(projectId, expected) {
        return expected.filter(({ role, model }) => !existsSync(join(this.root, SessionKeyStore.computeKey({ projectId, role, model }))));
    }
}
