import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSON5 from "json5";
import type {
  OrchestratorEvent,
  ProjectMode,
  SecondmateBearings,
  SecondmateCharter,
  TaskSnapshot,
} from "@agent-os/protocol";
import { secondmateCharterSchema } from "@agent-os/protocol";
import type { SecondmateRecord, SecondmateRegistry } from "./secondmates.js";

/**
 * Secondmate fleet operations (master plan §5.9, §11 Phase 7).
 *
 * A secondmate is a second Agent OS daemon on its own home and port, with its
 * own Brain, sharing exactly one thing with the primary: the Captain's Pi auth
 * store. Everything else — tasks, worktrees, event log, config — is separate.
 *
 * Three properties this module is responsible for:
 *   - the charter is CONFIG, so changing a secondmate's Brain or routing domains
 *     is a file edit that syncs, not a code change;
 *   - routing is by domain, and a task routed to a secondmate leaves the
 *     primary's fleet rather than being duplicated in both;
 *   - `/bearings` reports what each secondmate actually says about itself,
 *     including "unreachable", never a cached guess.
 */

export type SecondmateEventSink = (event: OrchestratorEvent) => void;

/** How long a bearings probe waits before calling a secondmate unreachable. */
const BEARINGS_TIMEOUT_MS = 5_000;
/** How long a task handover POST waits before failing closed (task stays on primary). */
const HANDOVER_TIMEOUT_MS = 10_000;

export class SecondmateHandoverError extends Error {
  readonly code = "SECONDMATE_HANDOVER_FAILED" as const;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SecondmateHandoverError";
  }
}

export class SecondmateFleet {
  private sink: SecondmateEventSink = () => undefined;

  constructor(private readonly registry: SecondmateRegistry) {}

  onEvent(sink: SecondmateEventSink): void {
    this.sink = sink;
  }

  /**
   * Hand a task to a running secondmate: ensure the project exists remotely,
   * POST the task spec, and return the remote task id. Does not mutate the
   * primary — the caller releases only after acceptance.
   */
  async handoverTask(input: {
    record: SecondmateRecord;
    task: TaskSnapshot;
    project: { name: string; path: string; mode: ProjectMode; trusted: boolean; yolo: boolean };
    domain: string;
  }): Promise<{ remoteTaskId: string }> {
    const token = this.registry.readRuntimeToken(input.record.name);
    if (token === null) {
      throw new SecondmateHandoverError(
        `secondmate ${input.record.name} has no runtime token — start it first`,
      );
    }
    const baseUrl = `http://127.0.0.1:${input.record.port}`;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const remoteProjectId = await this.ensureRemoteProject(baseUrl, auth, input.project);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDOVER_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: auth,
        signal: controller.signal,
        body: JSON.stringify({
          spec: {
            shape: input.task.shape,
            title: input.task.title,
            intent: input.task.intent,
            projectId: remoteProjectId,
            mode: input.task.mode,
            ...(input.task.shape === "SHIP" ? { yolo: input.task.yolo } : {}),
          },
          idempotencyKey: `routed-from-primary:${input.task.id}`,
        }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new SecondmateHandoverError(
          `secondmate ${input.record.name} refused task (HTTP ${response.status})`,
          { status: response.status, body: text.slice(0, 500) },
        );
      }
      const body = (await response.json()) as { task?: { id?: string } };
      const remoteTaskId = body.task?.id;
      if (typeof remoteTaskId !== "string" || remoteTaskId.length === 0) {
        throw new SecondmateHandoverError(
          `secondmate ${input.record.name} accepted without a task id`,
        );
      }
      return { remoteTaskId };
    } catch (error) {
      if (error instanceof SecondmateHandoverError) throw error;
      throw new SecondmateHandoverError(
        error instanceof Error ? error.message : "handover failed",
        { domain: input.domain },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureRemoteProject(
    baseUrl: string,
    auth: Record<string, string>,
    project: { name: string; path: string; mode: ProjectMode; trusted: boolean; yolo: boolean },
  ): Promise<string> {
    const listRes = await fetch(`${baseUrl}/v1/projects`, { headers: auth });
    if (listRes.ok) {
      const listBody = (await listRes.json()) as {
        projects?: Array<{ id: string; path: string }>;
      };
      const match = (listBody.projects ?? []).find((p) => p.path === project.path);
      if (match !== undefined) return match.id;
    }
    const createRes = await fetch(`${baseUrl}/v1/projects`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: project.name,
        path: project.path,
        mode: project.mode,
        trusted: project.trusted,
        yolo: project.yolo,
      }),
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => "");
      throw new SecondmateHandoverError(
        `could not register project on secondmate (HTTP ${createRes.status})`,
        { body: text.slice(0, 500) },
      );
    }
    const created = (await createRes.json()) as { project?: { id?: string } };
    const id = created.project?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new SecondmateHandoverError("secondmate project create returned no id");
    }
    return id;
  }

  private charterPath(record: SecondmateRecord): string {
    return join(record.home, "config", "charter.json5");
  }

  /**
   * Read a secondmate's charter from its own config layer. Missing or invalid
   * charters fall back to the provisioning record rather than throwing — a
   * malformed charter must not make the secondmate invisible to `/bearings`.
   */
  readCharter(record: SecondmateRecord): {
    charter: SecondmateCharter;
    source: "charter-file" | "provision-record";
    error: string | null;
  } {
    const path = this.charterPath(record);
    if (existsSync(path)) {
      try {
        const parsed = secondmateCharterSchema.parse(JSON5.parse(readFileSync(path, "utf8")));
        return { charter: parsed, source: "charter-file", error: null };
      } catch (error) {
        return {
          charter: this.charterFromRecord(record),
          source: "provision-record",
          error: error instanceof Error ? error.message : "invalid charter",
        };
      }
    }
    return { charter: this.charterFromRecord(record), source: "provision-record", error: null };
  }

  private charterFromRecord(record: SecondmateRecord): SecondmateCharter {
    return {
      name: record.name,
      domains: record.domain.length > 0 ? [record.domain] : [],
      brainModel: record.brainModel,
      maxConcurrentTasks: 2,
      acceptsRouting: true,
    };
  }

  /** Write a charter into the secondmate's own config layer (files are truth). */
  writeCharter(record: SecondmateRecord, charter: SecondmateCharter): void {
    const validated = secondmateCharterSchema.parse(charter);
    const dir = join(record.home, "config");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      this.charterPath(record),
      `// charter.json5 — secondmate ${record.name} (master plan §5.9)\n${JSON.stringify(validated, null, 2)}\n`,
      { mode: 0o600 },
    );
    this.sink({
      type: "secondmate.charter_changed",
      payload: {
        name: record.name,
        brainModel: validated.brainModel,
        domains: validated.domains,
      },
    });
  }

  /**
   * Choose a secondmate for a domain. Returns null when none accepts it — the
   * caller must then keep the task on the primary rather than inventing a
   * destination.
   */
  routeFor(domain: string): SecondmateRecord | null {
    for (const record of this.registry.list()) {
      const { charter } = this.readCharter(record);
      if (!charter.acceptsRouting) continue;
      if (charter.domains.includes(domain)) return record;
    }
    return null;
  }

  /**
   * Ask every secondmate for its own status. A secondmate that does not answer
   * within the timeout is reported unreachable — never filled in from the last
   * known value, because a stale "healthy" is the one answer that matters.
   */
  async bearings(): Promise<SecondmateBearings[]> {
    const records = this.registry.list();
    return Promise.all(records.map((record) => this.bearingsFor(record)));
  }

  private async bearingsFor(record: SecondmateRecord): Promise<SecondmateBearings> {
    const { charter, source, error } = this.readCharter(record);
    const base = {
      name: record.name,
      home: record.home,
      port: record.port,
      domains: charter.domains,
      brainModel: charter.brainModel,
      charterSource: source,
      charterError: error,
    };
    const token = this.readToken(record);
    if (token === null) {
      return {
        ...base,
        reachable: false,
        reason: "no daemon token — secondmate has never started",
        active: null,
        queued: null,
        brainStatus: null,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BEARINGS_TIMEOUT_MS);
    try {
      const response = await fetch(`http://127.0.0.1:${record.port}/v1/fleet`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ...base,
          reachable: false,
          reason: `daemon responded ${response.status}`,
          active: null,
          queued: null,
          brainStatus: null,
        };
      }
      const body = (await response.json()) as {
        summary: { active: number; queued: number; brain: { status: string } };
      };
      return {
        ...base,
        reachable: true,
        reason: null,
        active: body.summary.active,
        queued: body.summary.queued,
        brainStatus: body.summary.brain.status,
      };
    } catch (error) {
      return {
        ...base,
        reachable: false,
        reason: error instanceof Error ? error.message : "unreachable",
        active: null,
        queued: null,
        brainStatus: null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read the secondmate daemon token from the primary-side runtime tree
   * (outside the audited secondmate home).
   */
  private readToken(record: SecondmateRecord): string | null {
    return this.registry.readRuntimeToken(record.name);
  }
}
