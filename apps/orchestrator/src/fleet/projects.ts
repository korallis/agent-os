import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { monotonicFactory } from "ulid";
import type {
  OrchestratorEvent,
  ProjectMode,
  ProjectRecord,
} from "@agent-os/protocol";

export type ProjectEventSink = (event: OrchestratorEvent) => void;

const nextUlid = monotonicFactory();

/**
 * Project registry (master plan §5.2, Phase 3).
 * Durable under ~/.agentos/projects.json; path-jailed to absolute paths.
 */
export class ProjectRegistry {
  private readonly projects = new Map<string, ProjectRecord>();
  private sink: ProjectEventSink = () => undefined;
  private readonly storePath: string;

  constructor(private readonly home: string) {
    this.storePath = join(home, "projects.json");
    this.load();
  }

  onEvent(sink: ProjectEventSink): void {
    this.sink = sink;
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.storePath, "utf8")) as {
        projects?: ProjectRecord[];
      };
      for (const p of raw.projects ?? []) {
        this.projects.set(p.id, p);
      }
    } catch {
      // corrupt store — start empty; events remain truth for rebuild later
    }
  }

  private persist(): void {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const payload = {
      projects: [...this.projects.values()],
    };
    writeFileSync(this.storePath, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  list(): ProjectRecord[] {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ProjectRecord | null {
    return this.projects.get(id) ?? null;
  }

  register(input: {
    name: string;
    path: string;
    mode?: ProjectMode;
    trusted?: boolean;
    yolo?: boolean;
  }): ProjectRecord {
    const abs = resolve(input.path);
    if (!existsSync(abs)) {
      throw new Error(`project path does not exist: ${abs}`);
    }
    const now = new Date().toISOString();
    const record: ProjectRecord = {
      id: nextUlid(),
      name: input.name,
      path: abs,
      mode: input.mode ?? "pipeline",
      trusted: input.trusted ?? false,
      trustHash: null,
      yolo: input.yolo ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.projects.set(record.id, record);
    this.persist();
    this.sink({
      type: "project.registered",
      payload: {
        projectId: record.id,
        name: record.name,
        path: record.path,
        mode: record.mode,
        trusted: record.trusted,
      },
    });
    return record;
  }

  update(
    id: string,
    patch: Partial<Pick<ProjectRecord, "name" | "mode" | "trusted" | "yolo">>,
  ): ProjectRecord {
    const existing = this.projects.get(id);
    if (existing === undefined) {
      throw new Error(`project not found: ${id}`);
    }
    const updated: ProjectRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.projects.set(id, updated);
    this.persist();
    this.sink({
      type: "project.updated",
      payload: {
        projectId: id,
        name: patch.name,
        mode: patch.mode,
        trusted: patch.trusted,
      },
    });
    return updated;
  }
}
