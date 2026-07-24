import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { monotonicFactory } from "ulid";
import type { OrchestratorEvent, WorktreeLease, WorktreesConfig } from "@agent-os/protocol";

export type WorktreeEventSink = (event: OrchestratorEvent) => void;

const nextUlid = monotonicFactory();

/**
 * Pooled git worktrees (master plan §5.4).
 * States: idle / leased / quarantined / reclaiming.
 * verified-reset only after artifacts + final SHA durable; quarantine otherwise.
 */
export class WorktreePool {
  private readonly leases = new Map<string, WorktreeLease>();
  private sink: WorktreeEventSink = () => undefined;
  private readonly poolRoot: string;

  constructor(
    private readonly home: string,
    private config: WorktreesConfig,
  ) {
    this.poolRoot = join(home, "worktrees");
    mkdirSync(this.poolRoot, { recursive: true, mode: 0o700 });
    this.load();
  }

  onEvent(sink: WorktreeEventSink): void {
    this.sink = sink;
  }

  updateConfig(config: WorktreesConfig): void {
    this.config = config;
  }

  private metaPath(projectId: string): string {
    return join(this.poolRoot, projectId, "leases.json");
  }

  private load(): void {
    if (!existsSync(this.poolRoot)) return;
    for (const entry of readdirSync(this.poolRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const meta = this.metaPath(entry.name);
      if (!existsSync(meta)) continue;
      try {
        const raw = JSON.parse(readFileSync(meta, "utf8")) as { leases?: WorktreeLease[] };
        for (const lease of raw.leases ?? []) {
          this.leases.set(lease.id, lease);
        }
      } catch {
        // ignore corrupt meta
      }
    }
  }

  private persistProject(projectId: string): void {
    const dir = join(this.poolRoot, projectId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const leases = [...this.leases.values()].filter((l) => l.projectId === projectId);
    writeFileSync(this.metaPath(projectId), `${JSON.stringify({ leases }, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  list(): WorktreeLease[] {
    return [...this.leases.values()];
  }

  listForProject(projectId: string): WorktreeLease[] {
    return [...this.leases.values()].filter((l) => l.projectId === projectId);
  }

  /**
   * Lease an idle worktree or create one under the project pool.
   * `repoPath` is the captain's source git checkout.
   */
  lease(input: {
    projectId: string;
    repoPath: string;
    taskId: string;
    sessionId?: string;
    branch?: string;
  }): WorktreeLease {
    const branch = input.branch ?? `ao/${input.taskId.slice(0, 10).toLowerCase()}`;
    const idle = this.listForProject(input.projectId).find((l) => l.state === "idle");
    if (idle !== undefined) {
      this.checkoutBranchForReuse(idle.path, input.repoPath, branch);
      const leased: WorktreeLease = {
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

    const activeCount = this.listForProject(input.projectId).filter(
      (l) => l.state === "leased" || l.state === "reclaiming",
    ).length;
    if (activeCount >= this.config.poolSize) {
      throw new Error(
        `worktree pool exhausted for project ${input.projectId} (poolSize=${this.config.poolSize})`,
      );
    }

    const id = nextUlid();
    const path = join(this.poolRoot, input.projectId, id);
    mkdirSync(join(this.poolRoot, input.projectId), { recursive: true, mode: 0o700 });

    if (process.env.AGENTOS_FAKE_GIT === "1" || !existsSync(join(input.repoPath, ".git"))) {
      // Explicit test seam / non-git fixture path: marker directory only.
      mkdirSync(path, { recursive: true, mode: 0o700 });
      writeFileSync(join(path, ".agentos-worktree"), `${input.taskId}\n`, { mode: 0o600 });
    } else {
      const add = spawnSync(
        "git",
        ["-C", input.repoPath, "worktree", "add", "-b", branch, path, "HEAD"],
        { encoding: "utf8", timeout: 60_000 },
      );
      if (add.status !== 0) {
        const detail = (add.stderr || add.stdout || "worktree add failed").trim();
        throw new Error(`git worktree add failed: ${detail}`);
      }
    }

    const lease: WorktreeLease = {
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

  /**
   * On idle reuse of a real git worktree, move HEAD to the requested branch so
   * lease.branch matches the tree. Non-git / AGENTOS_FAKE_GIT paths are metadata-only.
   */
  private checkoutBranchForReuse(worktreePath: string, repoPath: string, branch: string): void {
    if (process.env.AGENTOS_FAKE_GIT === "1") return;
    if (!existsSync(join(worktreePath, ".git"))) return;

    const current = spawnSync("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    if (current.status === 0 && current.stdout.trim() === branch) {
      return;
    }

    const exists = spawnSync(
      "git",
      ["-C", worktreePath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { encoding: "utf8", timeout: 15_000 },
    );
    if (exists.status === 0) {
      const sw = spawnSync("git", ["-C", worktreePath, "switch", branch], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (sw.status !== 0) {
        const detail = (sw.stderr || sw.stdout || "git switch failed").trim();
        throw new Error(`git worktree branch switch failed: ${detail}`);
      }
      return;
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
    const create = spawnSync(
      "git",
      ["-C", worktreePath, "switch", "-c", branch, startPoint],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (create.status !== 0) {
      const detail = (create.stderr || create.stdout || "git switch -c failed").trim();
      throw new Error(`git worktree branch create failed: ${detail}`);
    }
  }

  /**
   * Release a lease. On verified-reset, reset the tree; on unexpected dirt or
   * any git failure we could not prove clean for, quarantine without treating
   * the tree as idle.
   */
  release(leaseId: string, options: { finalSha?: string; forceQuarantine?: boolean } = {}): WorktreeLease {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) {
      throw new Error(`worktree lease not found: ${leaseId}`);
    }

    let quarantined = options.forceQuarantine === true;
    let quarantineReason: string | undefined = quarantined
      ? "forceQuarantine"
      : undefined;
    if (this.config.reclaimPolicy === "quarantine-always") {
      quarantined = true;
      quarantineReason = "reclaimPolicy=quarantine-always";
    } else if (!quarantined && process.env.AGENTOS_FAKE_GIT !== "1") {
      const dirty = spawnSync("git", ["-C", lease.path, "status", "--porcelain"], {
        encoding: "utf8",
        timeout: 15_000,
      });
      if (dirty.error !== undefined || dirty.status !== 0) {
        // Could not prove the tree is clean — fail closed into quarantine.
        quarantined = true;
        quarantineReason = (
          dirty.error?.message ||
          dirty.stderr ||
          dirty.stdout ||
          `git status exit ${String(dirty.status)}`
        )
          .toString()
          .trim();
      } else if (dirty.stdout.trim().length > 0 && options.finalSha === undefined) {
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
        quarantineReason = (
          reset.error?.message ||
          reset.stderr ||
          reset.stdout ||
          `git reset --hard exit ${String(reset.status)}`
        )
          .toString()
          .trim();
      } else {
        const clean = spawnSync("git", ["-C", lease.path, "clean", "-fd"], {
          encoding: "utf8",
          timeout: 30_000,
        });
        if (clean.error !== undefined || clean.status !== 0) {
          quarantined = true;
          quarantineReason = (
            clean.error?.message ||
            clean.stderr ||
            clean.stdout ||
            `git clean -fd exit ${String(clean.status)}`
          )
            .toString()
            .trim();
        }
      }
    }

    if (quarantined) {
      const q: WorktreeLease = {
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

    const idle: WorktreeLease = {
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
  dropQuarantined(leaseId: string): void {
    const lease = this.leases.get(leaseId);
    if (lease === undefined || lease.state !== "quarantined") return;
    try {
      rmSync(lease.path, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    this.leases.delete(leaseId);
    this.persistProject(lease.projectId);
  }
}
