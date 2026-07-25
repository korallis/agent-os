import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { monotonicFactory } from "ulid";
const nextUlid = monotonicFactory();
/**
 * Pooled git worktrees (master plan §5.4).
 * States: idle / leased / quarantined / reclaiming.
 * verified-reset only after artifacts + final SHA durable; quarantine otherwise.
 */
export class WorktreePool {
    home;
    config;
    leases = new Map();
    sink = () => undefined;
    poolRoot;
    constructor(home, config) {
        this.home = home;
        this.config = config;
        this.poolRoot = join(home, "worktrees");
        mkdirSync(this.poolRoot, { recursive: true, mode: 0o700 });
        this.load();
    }
    onEvent(sink) {
        this.sink = sink;
    }
    updateConfig(config) {
        this.config = config;
    }
    metaPath(projectId) {
        return join(this.poolRoot, projectId, "leases.json");
    }
    load() {
        if (!existsSync(this.poolRoot))
            return;
        for (const entry of readdirSync(this.poolRoot, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const meta = this.metaPath(entry.name);
            if (!existsSync(meta))
                continue;
            try {
                const raw = JSON.parse(readFileSync(meta, "utf8"));
                for (const lease of raw.leases ?? []) {
                    this.leases.set(lease.id, lease);
                }
            }
            catch {
                // ignore corrupt meta
            }
        }
    }
    persistProject(projectId) {
        const dir = join(this.poolRoot, projectId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const leases = [...this.leases.values()].filter((l) => l.projectId === projectId);
        writeFileSync(this.metaPath(projectId), `${JSON.stringify({ leases }, null, 2)}\n`, {
            mode: 0o600,
        });
    }
    list() {
        return [...this.leases.values()];
    }
    listForProject(projectId) {
        return [...this.leases.values()].filter((l) => l.projectId === projectId);
    }
    /**
     * Lease an idle worktree or create one under the project pool.
     * `repoPath` is the captain's source git checkout.
     */
    lease(input) {
        const preferredBranch = input.branch ?? `ao/${input.taskId.slice(0, 10).toLowerCase()}`;
        // Prefer idle reuse, but never re-issue a missing/broken tree — drop and allocate fresh.
        for (;;) {
            const idle = this.listForProject(input.projectId).find((l) => l.state === "idle");
            if (idle === undefined)
                break;
            if (!this.isUsableWorktreePath(idle.path)) {
                this.dropIdleLease(idle, "idle worktree path missing or not a usable git worktree", input.repoPath);
                continue;
            }
            let branch = preferredBranch;
            try {
                branch = this.checkoutBranchForReuse(idle.path, input.repoPath, preferredBranch, input.sessionId);
            }
            catch {
                this.dropIdleLease(idle, "idle worktree checkout failed", input.repoPath);
                continue;
            }
            const leased = {
                ...idle,
                state: "leased",
                taskId: input.taskId,
                sessionId: input.sessionId ?? null,
                branch,
                leasedAt: new Date().toISOString(),
            };
            this.leases.set(leased.id, leased);
            this.persistProject(input.projectId);
            this.sink({
                type: "worktree.leased",
                payload: {
                    leaseId: leased.id,
                    projectId: leased.projectId,
                    taskId: input.taskId,
                    path: leased.path,
                    branch: leased.branch,
                },
            });
            return leased;
        }
        const activeCount = this.listForProject(input.projectId).filter((l) => l.state === "leased" || l.state === "reclaiming").length;
        if (activeCount >= this.config.poolSize) {
            throw new Error(`worktree pool exhausted for project ${input.projectId} (poolSize=${this.config.poolSize})`);
        }
        const id = nextUlid();
        const path = join(this.poolRoot, input.projectId, id);
        mkdirSync(join(this.poolRoot, input.projectId), { recursive: true, mode: 0o700 });
        let branch = preferredBranch;
        if (process.env.AGENTOS_FAKE_GIT === "1" || !existsSync(join(input.repoPath, ".git"))) {
            // Explicit test seam / non-git fixture path: marker directory only.
            mkdirSync(path, { recursive: true, mode: 0o700 });
            writeFileSync(join(path, ".agentos-worktree"), `${input.taskId}\n`, { mode: 0o600 });
        }
        else {
            const resolved = this.resolveBranchForAdd(input.repoPath, preferredBranch, input.sessionId);
            branch = resolved.branch;
            const addArgs = resolved.mode === "create"
                ? ["-C", input.repoPath, "worktree", "add", "-b", branch, path, "HEAD"]
                : ["-C", input.repoPath, "worktree", "add", path, branch];
            const add = spawnSync("git", addArgs, { encoding: "utf8", timeout: 60_000 });
            if (add.status !== 0) {
                const detail = (add.stderr || add.stdout || "worktree add failed").trim();
                throw new Error(`git worktree add failed: ${detail}`);
            }
        }
        const lease = {
            id,
            projectId: input.projectId,
            path,
            state: "leased",
            taskId: input.taskId,
            sessionId: input.sessionId ?? null,
            branch,
            leasedAt: new Date().toISOString(),
            lastSha: null,
        };
        this.leases.set(id, lease);
        this.persistProject(input.projectId);
        this.sink({
            type: "worktree.leased",
            payload: {
                leaseId: lease.id,
                projectId: lease.projectId,
                taskId: input.taskId,
                path: lease.path,
                branch: lease.branch,
            },
        });
        return lease;
    }
    /** True when the path can host a crewmate cwd (real git worktree or FAKE_GIT marker). */
    isUsableWorktreePath(worktreePath) {
        if (!existsSync(worktreePath))
            return false;
        if (process.env.AGENTOS_FAKE_GIT === "1")
            return true;
        if (!existsSync(join(worktreePath, ".git"))) {
            // Marker-only fixture trees from non-git repos are usable as metadata paths.
            return existsSync(join(worktreePath, ".agentos-worktree"));
        }
        const probe = spawnSync("git", ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"], {
            encoding: "utf8",
            timeout: 15_000,
        });
        return probe.status === 0 && probe.stdout.trim() === "true";
    }
    /**
     * Branches currently checked out by any worktree of this repo (including main).
     * `excludePath` skips the worktree being reused so its own branch is not treated as held.
     */
    branchesCheckedOutInWorktrees(repoPath, excludePath) {
        const listed = spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
            encoding: "utf8",
            timeout: 15_000,
        });
        const checkedOut = new Set();
        if (listed.status !== 0)
            return checkedOut;
        const exclude = excludePath !== undefined ? resolve(excludePath) : undefined;
        let currentPath = null;
        for (const line of listed.stdout.split("\n")) {
            if (line.startsWith("worktree ")) {
                currentPath = resolve(line.slice("worktree ".length).trim());
                continue;
            }
            if (line.startsWith("branch refs/heads/")) {
                if (exclude !== undefined && currentPath === exclude)
                    continue;
                checkedOut.add(line.slice("branch refs/heads/".length).trim());
            }
        }
        return checkedOut;
    }
    branchExistsLocally(repoPath, branch) {
        const exists = spawnSync("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { encoding: "utf8", timeout: 15_000 });
        return exists.status === 0;
    }
    /**
     * Pick a branch for worktree add/reuse:
     * - free existing branch → checkout without -b / switch
     * - missing branch → create with -b / switch -c
     * - held by another worktree (including quarantine) → distinct branch
     */
    resolveBranchForAdd(repoPath, preferred, sessionId, excludePath) {
        const checkedOut = this.branchesCheckedOutInWorktrees(repoPath, excludePath);
        const candidates = [
            preferred,
            sessionId !== undefined ? `${preferred}-${sessionId.slice(0, 10).toLowerCase()}` : undefined,
            `${preferred}-${nextUlid().slice(0, 10).toLowerCase()}`,
        ].filter((b) => b !== undefined);
        for (const branch of candidates) {
            if (checkedOut.has(branch))
                continue;
            if (this.branchExistsLocally(repoPath, branch)) {
                return { branch, mode: "checkout" };
            }
            return { branch, mode: "create" };
        }
        throw new Error(`git worktree add failed: no free branch for ${preferred} (all candidates checked out)`);
    }
    /** Drop a broken idle lease so the pool can allocate a replacement. */
    dropIdleLease(lease, reason, repoPath) {
        if (process.env.AGENTOS_FAKE_GIT !== "1" &&
            repoPath !== undefined &&
            existsSync(join(repoPath, ".git"))) {
            spawnSync("git", ["-C", repoPath, "worktree", "remove", "--force", lease.path], {
                encoding: "utf8",
                timeout: 60_000,
            });
            spawnSync("git", ["-C", repoPath, "worktree", "prune"], {
                encoding: "utf8",
                timeout: 30_000,
            });
        }
        if (existsSync(lease.path)) {
            try {
                rmSync(lease.path, { recursive: true, force: true });
            }
            catch {
                // best-effort leftover cleanup
            }
        }
        this.leases.delete(lease.id);
        this.persistProject(lease.projectId);
        this.sink({
            type: "worktree.released",
            payload: {
                leaseId: lease.id,
                projectId: lease.projectId,
                path: lease.path,
                quarantined: true,
                reason,
            },
        });
    }
    /**
     * On idle reuse of a real git worktree, move HEAD to the requested branch so
     * lease.branch matches the tree. Non-git / AGENTOS_FAKE_GIT paths are metadata-only.
     * Returns the branch actually checked out (may be a session-suffixed alternate
     * when the preferred task branch is held elsewhere).
     */
    checkoutBranchForReuse(worktreePath, repoPath, preferredBranch, sessionId) {
        if (process.env.AGENTOS_FAKE_GIT === "1")
            return preferredBranch;
        if (!existsSync(join(worktreePath, ".git")))
            return preferredBranch;
        const resolved = this.resolveBranchForAdd(repoPath, preferredBranch, sessionId, worktreePath);
        const branch = resolved.branch;
        const current = spawnSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
            encoding: "utf8",
            timeout: 15_000,
        });
        if (current.status === 0 && current.stdout.trim() === branch) {
            return branch;
        }
        if (resolved.mode === "checkout") {
            const sw = spawnSync("git", ["-C", worktreePath, "switch", branch], {
                encoding: "utf8",
                timeout: 30_000,
            });
            if (sw.status !== 0) {
                const detail = (sw.stderr || sw.stdout || "git switch failed").trim();
                throw new Error(`git worktree branch switch failed: ${detail}`);
            }
            return branch;
        }
        const base = spawnSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
            encoding: "utf8",
            timeout: 15_000,
        });
        if (base.status !== 0) {
            const detail = (base.stderr || base.stdout || "rev-parse failed").trim();
            throw new Error(`git worktree branch create failed: cannot resolve project HEAD: ${detail}`);
        }
        const startPoint = base.stdout.trim();
        const create = spawnSync("git", ["-C", worktreePath, "switch", "-c", branch, startPoint], { encoding: "utf8", timeout: 30_000 });
        if (create.status !== 0) {
            const detail = (create.stderr || create.stdout || "git switch -c failed").trim();
            throw new Error(`git worktree branch create failed: ${detail}`);
        }
        return branch;
    }
    /**
     * Release a lease. On verified-reset, reset the tree; on unexpected dirt or
     * any git failure we could not prove clean for, quarantine without treating
     * the tree as idle.
     */
    release(leaseId, options = {}) {
        const lease = this.leases.get(leaseId);
        if (lease === undefined) {
            throw new Error(`worktree lease not found: ${leaseId}`);
        }
        let quarantined = options.forceQuarantine === true;
        let quarantineReason = quarantined
            ? "forceQuarantine"
            : undefined;
        if (this.config.reclaimPolicy === "quarantine-always") {
            quarantined = true;
            quarantineReason = "reclaimPolicy=quarantine-always";
        }
        else if (!quarantined && process.env.AGENTOS_FAKE_GIT !== "1") {
            const dirty = spawnSync("git", ["-C", lease.path, "status", "--porcelain"], {
                encoding: "utf8",
                timeout: 15_000,
            });
            if (dirty.error !== undefined || dirty.status !== 0) {
                // Could not prove the tree is clean — fail closed into quarantine.
                quarantined = true;
                quarantineReason = (dirty.error?.message ||
                    dirty.stderr ||
                    dirty.stdout ||
                    `git status exit ${String(dirty.status)}`)
                    .toString()
                    .trim();
            }
            else if (dirty.stdout.trim().length > 0 && options.finalSha === undefined) {
                quarantined = true;
                quarantineReason = "dirty worktree without finalSha";
            }
        }
        if (!quarantined && process.env.AGENTOS_FAKE_GIT !== "1" && existsSync(join(lease.path, ".git"))) {
            const reset = spawnSync("git", ["-C", lease.path, "reset", "--hard", "HEAD"], {
                encoding: "utf8",
                timeout: 30_000,
            });
            if (reset.error !== undefined || reset.status !== 0) {
                quarantined = true;
                quarantineReason = (reset.error?.message ||
                    reset.stderr ||
                    reset.stdout ||
                    `git reset --hard exit ${String(reset.status)}`)
                    .toString()
                    .trim();
            }
            else {
                const clean = spawnSync("git", ["-C", lease.path, "clean", "-fd"], {
                    encoding: "utf8",
                    timeout: 30_000,
                });
                if (clean.error !== undefined || clean.status !== 0) {
                    quarantined = true;
                    quarantineReason = (clean.error?.message ||
                        clean.stderr ||
                        clean.stdout ||
                        `git clean -fd exit ${String(clean.status)}`)
                        .toString()
                        .trim();
                }
            }
        }
        if (quarantined) {
            const q = {
                ...lease,
                state: "quarantined",
                taskId: null,
                sessionId: null,
                leasedAt: null,
                lastSha: options.finalSha ?? lease.lastSha,
                ...(quarantineReason !== undefined ? { quarantineReason } : {}),
            };
            this.leases.set(leaseId, q);
            this.persistProject(lease.projectId);
            this.sink({
                type: "worktree.released",
                payload: {
                    leaseId,
                    projectId: lease.projectId,
                    path: lease.path,
                    quarantined: true,
                    ...(quarantineReason !== undefined ? { reason: quarantineReason } : {}),
                },
            });
            return q;
        }
        const idle = {
            id: lease.id,
            projectId: lease.projectId,
            path: lease.path,
            state: "idle",
            taskId: null,
            sessionId: null,
            branch: lease.branch,
            leasedAt: null,
            lastSha: options.finalSha ?? lease.lastSha,
        };
        this.leases.set(leaseId, idle);
        this.persistProject(lease.projectId);
        this.sink({
            type: "worktree.released",
            payload: {
                leaseId,
                projectId: lease.projectId,
                path: lease.path,
                quarantined: false,
            },
        });
        return idle;
    }
    /** Test helper: drop a quarantine path without reclaim. */
    dropQuarantined(leaseId) {
        const lease = this.leases.get(leaseId);
        if (lease === undefined || lease.state !== "quarantined")
            return;
        try {
            rmSync(lease.path, { recursive: true, force: true });
        }
        catch {
            // best-effort
        }
        this.leases.delete(leaseId);
        this.persistProject(lease.projectId);
    }
    /**
     * Boot reclaim: release leases still marked leased/reclaiming whose session is
     * gone or has no live tmux pane. Returns the number of leases released.
     */
    reclaimOrphanedLeases(isLiveSession) {
        let reclaimed = 0;
        for (const lease of [...this.leases.values()]) {
            if (lease.state !== "leased" && lease.state !== "reclaiming")
                continue;
            if (isLiveSession(lease.sessionId))
                continue;
            try {
                this.release(lease.id, {});
                reclaimed += 1;
            }
            catch {
                // best-effort
            }
        }
        return reclaimed;
    }
}
