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
/** How long charter→brain sync remote calls wait. */
const SYNC_TIMEOUT_MS = 10_000;

export class SecondmateHandoverError extends Error {
  readonly code = "SECONDMATE_HANDOVER_FAILED" as const;
  /**
   * When true, the secondmate certainly did not create the task (pre-POST
   * failure or clean 4xx). Pending handover intent may be cleared.
   * When false, remote may already own the task — pending must survive for redrive.
   */
  readonly definiteRefusal: boolean;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
    definiteRefusal = false,
  ) {
    super(message);
    this.name = "SecondmateHandoverError";
    this.definiteRefusal = definiteRefusal;
  }
}

export class SecondmateCapacityError extends Error {
  readonly code = "SECONDMATE_AT_CAPACITY" as const;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SecondmateCapacityError";
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
    /**
     * Re-drive of durable pending intent. Skips admission capacity so a task
     * that may already exist remotely (ambiguous prior POST) is not refused
     * before the idempotent create can resolve the remote id.
     */
    redrive?: boolean;
  }): Promise<{ remoteTaskId: string }> {
    const token = this.registry.readRuntimeToken(input.record.name);
    if (token === null) {
      throw new SecondmateHandoverError(
        `secondmate ${input.record.name} has no runtime token — start it first`,
        undefined,
        true,
      );
    }
    const baseUrl = `http://127.0.0.1:${input.record.port}`;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    // Pre-POST failures are definite: the task create request never left.
    // Redrive skips capacity — remote may already count this task toward the cap.
    if (input.redrive !== true) {
      await this.assertAdmissionCapacity(input.record, baseUrl, auth);
    }
    const remoteProjectId = await this.ensureRemoteProject(baseUrl, auth, input.project);

    try {
      const response = await fetchWithTimeout(
        `${baseUrl}/v1/tasks`,
        {
          method: "POST",
          headers: auth,
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
        },
        HANDOVER_TIMEOUT_MS,
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (
          response.status === 409 ||
          /capacity|concurrent tasks/i.test(text)
        ) {
          throw new SecondmateCapacityError(
            `secondmate ${input.record.name} is at capacity (admission refused)`,
            { status: response.status, body: text.slice(0, 500) },
          );
        }
        // Clean 4xx: server refused create. 5xx/other: may have accepted.
        const definiteRefusal = response.status >= 400 && response.status < 500;
        throw new SecondmateHandoverError(
          `secondmate ${input.record.name} refused task (HTTP ${response.status})`,
          { status: response.status, body: text.slice(0, 500) },
          definiteRefusal,
        );
      }
      let body: { task?: { id?: string } };
      try {
        body = (await response.json()) as { task?: { id?: string } };
      } catch (error) {
        // HTTP 200 but body unreadable — remote may own the task.
        throw new SecondmateHandoverError(
          error instanceof Error
            ? `secondmate ${input.record.name} accepted with unreadable body: ${error.message}`
            : `secondmate ${input.record.name} accepted with unreadable body`,
          { status: 200 },
          false,
        );
      }
      const remoteTaskId = body.task?.id;
      if (typeof remoteTaskId !== "string" || remoteTaskId.length === 0) {
        // HTTP 200 without id — treat as ambiguous (may still have created).
        throw new SecondmateHandoverError(
          `secondmate ${input.record.name} accepted without a task id`,
          { status: 200 },
          false,
        );
      }
      return { remoteTaskId };
    } catch (error) {
      if (error instanceof SecondmateHandoverError) throw error;
      if (error instanceof SecondmateCapacityError) throw error;
      // Network drop / abort after POST may have been accepted remotely.
      throw new SecondmateHandoverError(
        error instanceof Error ? error.message : "handover failed",
        { domain: input.domain },
        false,
      );
    }
  }

  /**
   * Refuse routing when the secondmate is already at charter.maxConcurrentTasks.
   * Counts active + queued from the live fleet summary (fail closed on probe fail).
   */
  private async assertAdmissionCapacity(
    record: SecondmateRecord,
    baseUrl: string,
    auth: Record<string, string>,
  ): Promise<void> {
    const { charter } = this.readCharter(record);
    const cap = charter.maxConcurrentTasks;
    try {
      const response = await fetchWithTimeout(
        `${baseUrl}/v1/fleet`,
        { headers: auth },
        HANDOVER_TIMEOUT_MS,
      );
      if (!response.ok) {
        throw new SecondmateHandoverError(
          `secondmate ${record.name} fleet probe failed (HTTP ${response.status}) — cannot admit`,
          { status: response.status },
          true,
        );
      }
      const body = (await response.json()) as {
        summary?: { active?: number; queued?: number };
      };
      const active = body.summary?.active ?? 0;
      const queued = body.summary?.queued ?? 0;
      const load = active + queued;
      if (load >= cap) {
        throw new SecondmateCapacityError(
          `secondmate ${record.name} is at capacity (${load}/${cap} concurrent tasks)`,
          { load, cap, active, queued },
        );
      }
    } catch (error) {
      if (error instanceof SecondmateCapacityError) throw error;
      if (error instanceof SecondmateHandoverError) {
        // Pre-POST: even timeouts are definite (task create never sent).
        if (error.definiteRefusal) throw error;
        throw new SecondmateHandoverError(error.message, error.details, true);
      }
      throw new SecondmateHandoverError(
        error instanceof Error
          ? error.message
          : `secondmate ${record.name} capacity probe failed`,
        undefined,
        true,
      );
    }
  }

  private async ensureRemoteProject(
    baseUrl: string,
    auth: Record<string, string>,
    project: { name: string; path: string; mode: ProjectMode; trusted: boolean; yolo: boolean },
  ): Promise<string> {
    try {
      const listRes = await fetchWithTimeout(
        `${baseUrl}/v1/projects`,
        { headers: auth },
        HANDOVER_TIMEOUT_MS,
      );
      if (listRes.ok) {
        const listBody = (await listRes.json()) as {
          projects?: Array<{ id: string; path: string }>;
        };
        const match = (listBody.projects ?? []).find((p) => p.path === project.path);
        if (match !== undefined) return match.id;
      }
      const createRes = await fetchWithTimeout(
        `${baseUrl}/v1/projects`,
        {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            name: project.name,
            path: project.path,
            mode: project.mode,
            trusted: project.trusted,
            yolo: project.yolo,
          }),
        },
        HANDOVER_TIMEOUT_MS,
      );
      if (!createRes.ok) {
        const text = await createRes.text().catch(() => "");
        throw new SecondmateHandoverError(
          `could not register project on secondmate (HTTP ${createRes.status})`,
          { status: createRes.status, body: text.slice(0, 500) },
          true,
        );
      }
      const created = (await createRes.json()) as { project?: { id?: string } };
      const id = created.project?.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new SecondmateHandoverError(
          "secondmate project create returned no id",
          undefined,
          true,
        );
      }
      return id;
    } catch (error) {
      if (error instanceof SecondmateHandoverError) {
        // Pre-POST: task create never sent — always a definite refusal for handover.
        if (error.definiteRefusal) throw error;
        throw new SecondmateHandoverError(error.message, error.details, true);
      }
      throw new SecondmateHandoverError(
        error instanceof Error
          ? error.message
          : "could not register project on secondmate",
        undefined,
        true,
      );
    }
  }

  private charterPath(record: SecondmateRecord): string {
    return join(record.home, "config", "charter.json5");
  }

  private brainConfigPath(record: SecondmateRecord): string {
    return join(record.home, "config", "brain.json5");
  }

  /**
   * Write the charter's brainModel into the secondmate home's brain config so
   * BrainManager.resolveModel() uses it on the next start/reload.
   */
  applyCharterToBrainConfig(record: SecondmateRecord, charter: SecondmateCharter): void {
    const dir = join(record.home, "config");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const cast = charter.brainModel ?? "auto";
    const body = `// brain.json5 — driven by secondmate charter (master plan §5.9)\n{\n  cast: ${JSON.stringify(cast)},\n}\n`;
    writeFileSync(this.brainConfigPath(record), body, { mode: 0o600 });
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
    const cap = record.maxConcurrentTasks;
    // Fail closed when the provision record has no durable cap — never invent 2.
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1) {
      return {
        name: record.name,
        domains: record.domain.length > 0 ? [record.domain] : [],
        brainModel: record.brainModel,
        maxConcurrentTasks: 1,
        acceptsRouting: false,
      };
    }
    return {
      name: record.name,
      domains: record.domain.length > 0 ? [record.domain] : [],
      brainModel: record.brainModel,
      maxConcurrentTasks: cap,
      acceptsRouting: true,
    };
  }

  /** Write a charter into the secondmate's own config layer (files are truth). */
  async writeCharter(record: SecondmateRecord, charter: SecondmateCharter): Promise<void> {
    const validated = secondmateCharterSchema.parse(charter);
    const dir = join(record.home, "config");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      this.charterPath(record),
      `// charter.json5 — secondmate ${record.name} (master plan §5.9)\n${JSON.stringify(validated, null, 2)}\n`,
      { mode: 0o600 },
    );
    this.applyCharterToBrainConfig(record, validated);
    await this.registry.updateRecord(record.name, {
      brainModel: validated.brainModel,
      domain: validated.domains[0] ?? record.domain,
      maxConcurrentTasks: validated.maxConcurrentTasks,
    });
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
   * Write charter + brain config, then if the secondmate is running push the
   * brain cast via its REST config API and respawn its Brain so the live model
   * matches the charter.
   */
  async syncCharter(
    record: SecondmateRecord,
    charter: SecondmateCharter,
  ): Promise<{ charter: SecondmateCharter; brainSynced: boolean; brainModel: string | null }> {
    await this.writeCharter(record, charter);
    const validated = secondmateCharterSchema.parse(charter);
    const token = this.registry.readRuntimeToken(record.name);
    const runtime = this.registry.readRuntime(record.name);
    if (token === null || runtime === null) {
      return { charter: validated, brainSynced: false, brainModel: validated.brainModel };
    }
    const baseUrl = `http://127.0.0.1:${record.port}`;
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const cast = validated.brainModel ?? "auto";
    // Strict JSON so Fastify's application/json parser accepts the body.
    const brainBody = JSON.stringify({ cast });
    try {
      const put = await fetchWithTimeout(
        `${baseUrl}/v1/config/global/brain`,
        {
          method: "PUT",
          headers: auth,
          body: brainBody,
        },
        SYNC_TIMEOUT_MS,
      );
      if (!put.ok) {
        throw new Error(`config write HTTP ${put.status}`);
      }
      const start = await fetchWithTimeout(
        `${baseUrl}/v1/brain/start`,
        { method: "POST", headers: auth, body: "{}" },
        SYNC_TIMEOUT_MS,
      );
      if (!start.ok) {
        throw new Error(`brain start HTTP ${start.status}`);
      }
      const brainRes = await fetchWithTimeout(
        `${baseUrl}/v1/brain`,
        { headers: auth },
        SYNC_TIMEOUT_MS,
      );
      if (brainRes.ok) {
        const body = (await brainRes.json()) as { brain?: { model?: string | null } };
        return {
          charter: validated,
          brainSynced: true,
          brainModel: body.brain?.model ?? validated.brainModel,
        };
      }
      return { charter: validated, brainSynced: true, brainModel: validated.brainModel };
    } catch (error) {
      throw new SecondmateHandoverError(
        error instanceof Error
          ? `charter brain sync failed: ${error.message}`
          : "charter brain sync failed",
      );
    }
  }

  /**
   * Choose a secondmate for a domain (auto-pick / discovery). First charter that
   * accepts the domain wins. Named routing must not use this — check the named
   * secondmate's own charter via acceptsDomain instead.
   */
  routeFor(domain: string): SecondmateRecord | null {
    for (const record of this.registry.list()) {
      if (this.acceptsDomain(record, domain)) return record;
    }
    return null;
  }

  /**
   * Whether a specific secondmate's charter accepts routing for `domain`.
   * Used by named route_to_secondmate — not first-wins across the fleet.
   */
  acceptsDomain(record: SecondmateRecord, domain: string): boolean {
    const { charter } = this.readCharter(record);
    return charter.acceptsRouting && charter.domains.includes(domain);
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
    try {
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${record.port}/v1/fleet`,
        { headers: { authorization: `Bearer ${token}` } },
        BEARINGS_TIMEOUT_MS,
      );
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SecondmateHandoverError(`remote call timed out after ${timeoutMs}ms`, {
        url,
        timeoutMs,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
