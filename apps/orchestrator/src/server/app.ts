import { timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type RawReplyDefaultExpression,
  type RawRequestDefaultExpression,
  type RawServerDefault,
} from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import {
  apiKeyConnectRequestSchema,
  brainToolNameSchema,
  configDomainSchema,
  configLayerSchema,
  oauthStartRequestSchema,
  onboardingAdvanceRequestSchema,
  PI_PINNED_VERSION,
  projectRegisterRequestSchema,
  SAFETY_CONFIRM_HEADER,
  safetyPoliciesConfigSchema,
  taskCreateRequestSchema,
  toolCallRequestSchema,
  type ApiErrorCode,
  type ConfigValidationIssue,
  type EventsReplayResponse,
  type HealthResponse,
  type OnboardingState,
  type QuotaSample,
  type StatusResponse,
  type TaskEventsResponse,
} from "@agent-os/protocol";
import type { EventStore } from "@agent-os/event-store";
import { ConfigService, ConfigWriteError } from "../config/service.js";
import { AGENTOSD_VERSION } from "../version.js";
import type { ConnectionRegistry } from "../pi/connections.js";
import { writeApiKeyFile } from "../pi/connections.js";
import type { PiDetection } from "../pi/manager.js";
import { listDetectedProviders } from "../pi/manager.js";
import type { OnboardingService } from "../onboarding/state.js";
import { OnboardingBlockedError } from "../onboarding/state.js";
import { enableQuotaProviders } from "../quota-probes/enable.js";
import { probeConnection, isLimitReached } from "../quota-probes/probes.js";
import { resolveAuthJsonPathsWithFallback } from "../security/auth-store.js";
import type { FleetService } from "../fleet/service.js";
import type { PromptService } from "../prompts/service.js";
import type { AnalyticsService } from "../analytics/service.js";

/** Drop an SSE client if its write buffer stays stalled this long. */
const SSE_STALL_MS = 30_000;
/** Page size for Last-Event-ID history replay (loop until !truncated). */
const SSE_REPLAY_PAGE = 10_000;

export interface ServerDeps {
  store: EventStore;
  config: ConfigService;
  token: string;
  home: string;
  port: number;
  startedAt: string;
  logger: Logger;
  /** Phase 2 services — optional for pure Phase 1 unit paths. */
  connections?: ConnectionRegistry;
  onboarding?: OnboardingService;
  pi?: PiDetection;
  /** In-memory latest quota samples (connectionId → sample). */
  quotaSamples?: Map<string, QuotaSample>;
  /** Phase 3 fleet substrate. */
  fleet?: FleetService;
  /** Phase 4 layered prompt packs. */
  prompts?: PromptService;
  /** Phase 6 usage & cost analytics derived from the event log. */
  analytics?: AnalyticsService;
}

export type AgentosdServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression<RawServerDefault>,
  RawReplyDefaultExpression<RawServerDefault>,
  Logger
> & {
  /** Force-close hijacked SSE responses so graceful shutdown cannot hang. */
  destroySseStreams(): void;
};

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const ALLOWED_ORIGIN_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function sendError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
  issues: ConfigValidationIssue[] | null = null,
): void {
  void reply.status(status).send({ error: { code, message, issues } });
}

function tokenMatches(provided: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The agentosd Fastify app (master plan §8). Loopback-only (config-locked),
 * bearer-authenticated except `/v1/health`, exact-origin checked, typed
 * errors everywhere.
 */
export function buildServer(deps: ServerDeps): AgentosdServer {
  const app = Fastify({
    loggerInstance: deps.logger,
    // Per-request logging off: SSE/health polling would flood the file log.
    logController: new LogController({ disableRequestLogging: true }),
  });

  /** Hijacked SSE `reply.raw` responses — destroyed on daemon shutdown. */
  const sseStreams = new Set<ServerResponse>();
  const destroySseStreams = (): void => {
    for (const raw of sseStreams) {
      try {
        raw.destroy();
      } catch {
        // already gone
      }
    }
    sseStreams.clear();
  };

  // JSON5 config writes arrive as text (§8.2 "JSON5 body").
  app.addContentTypeParser(
    ["application/json5", "text/plain"],
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  app.addHook("onRequest", (request, reply, done) => {
    // Defense-in-depth: the listener binds 127.0.0.1 only, but reject any
    // non-loopback peer address outright (§10.2 #4).
    if (!LOOPBACK_ADDRESSES.has(request.ip)) {
      sendError(reply, 403, "FORBIDDEN", "loopback-only: remote connections are refused");
      done();
      return;
    }
    // Exact-origin check: browser contexts must be local (§8.1).
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin.length > 0) {
      let host: string | null = null;
      try {
        host = new URL(origin).hostname;
      } catch {
        host = null;
      }
      if (host === null || !ALLOWED_ORIGIN_HOSTS.has(host === "::1" ? "[::1]" : host)) {
        sendError(reply, 403, "FORBIDDEN", "cross-origin requests are refused");
        done();
        return;
      }
    }
    // Bearer auth for everything except health (§8.1).
    if (request.url === "/v1/health" || request.url.startsWith("/v1/health?")) {
      done();
      return;
    }
    const auth = request.headers.authorization;
    const provided = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tokenMatches(provided, deps.token)) {
      sendError(reply, 401, "UNAUTHORIZED", "missing or invalid bearer token");
      done();
      return;
    }
    done();
  });

  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, 404, "NOT_FOUND", "no such route");
  });

  app.get("/v1/health", (): HealthResponse => {
    return { ok: true, name: "agentosd", version: AGENTOSD_VERSION, pid: process.pid };
  });

  app.get("/v1/status", (): StatusResponse => {
    return {
      daemon: {
        version: AGENTOSD_VERSION,
        pid: process.pid,
        home: deps.home,
        port: deps.port,
        startedAt: deps.startedAt,
        uptimeSeconds: (Date.now() - Date.parse(deps.startedAt)) / 1000,
      },
      events: {
        count: deps.store.count(),
        lastSeq: deps.store.lastSeq(),
        lastId: deps.store.lastEventId(),
      },
      pi: {
        pinnedVersion: PI_PINNED_VERSION,
        detectedVersion: deps.pi?.version ?? null,
        binary: deps.pi?.binary ?? null,
        managedHome: deps.pi?.managedHome ?? null,
        configDirEnv: deps.pi?.configDirEnv ?? null,
      },
    };
  });

  // ── Phase 3: fleet / projects / tasks / tools ──────────────────────────

  app.get("/v1/fleet", async (_request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    return { summary: deps.fleet.summary() };
  });

  app.get("/v1/fleet/state", async (_request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    return { state: deps.fleet.tools.readFleetState() };
  });

  app.get("/v1/wakes", async (_request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    return { wakes: deps.fleet.watcher.getHistory(200) };
  });

  // Console + phase-6 gates hit the fleet-prefixed path.
  app.get("/v1/fleet/wakes", async (_request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    return { wakes: deps.fleet.watcher.getHistory(200) };
  });

  app.get("/v1/projects", async (_request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    return { projects: deps.fleet.projects.list() };
  });

  app.post("/v1/projects", async (request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    const body = projectRegisterRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_REQUEST", "invalid project body");
      return;
    }
    try {
      const project = deps.fleet.projects.register({
        name: body.data.name,
        path: body.data.path,
        ...(body.data.mode !== undefined ? { mode: body.data.mode } : {}),
        ...(body.data.trusted !== undefined ? { trusted: body.data.trusted } : {}),
        ...(body.data.yolo !== undefined ? { yolo: body.data.yolo } : {}),
      });
      return { project };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(reply, 400, "BAD_REQUEST", message);
      return;
    }
  });

  app.get("/v1/tasks", async (_request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    return { tasks: deps.fleet.listTaskItems() };
  });

  app.post("/v1/tasks", async (request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    const body = taskCreateRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_REQUEST", "invalid task body");
      return;
    }
    const result = deps.fleet.tools.invoke("create_task", {
      spec: body.data.spec,
      ...(body.data.idempotencyKey !== undefined
        ? { idempotencyKey: body.data.idempotencyKey }
        : {}),
    });
    if (!result.ok) {
      const code = mapToolError(result.error?.code);
      sendError(reply, code === "NOT_FOUND" ? 404 : 400, code, result.error?.message ?? "create failed");
      return;
    }
    return { task: result.data };
  });

  app.get<{ Params: { id: string } }>("/v1/tasks/:id", async (request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    const task = deps.fleet.tools.getTask(request.params.id);
    if (task === null) {
      sendError(reply, 404, "NOT_FOUND", "task not found");
      return;
    }
    return { task };
  });

  /**
   * Task-scoped event history for Task Detail evidence (tool.invoked, gate.result,
   * session/fusion frames). Truncation is meaningful for THIS task only.
   */
  const taskEventsQuerySchema = z.object({
    types: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(10_000).default(5_000),
  });

  app.get<{ Params: { id: string } }>(
    "/v1/tasks/:id/events",
    (request, reply): TaskEventsResponse | undefined => {
      const query = taskEventsQuerySchema.safeParse(request.query);
      if (!query.success) {
        sendError(reply, 400, "BAD_REQUEST", "invalid task events query");
        return undefined;
      }
      const types =
        query.data.types === undefined || query.data.types.trim() === ""
          ? null
          : query.data.types
              .split(",")
              .map((t) => t.trim())
              .filter((t) => t.length > 0);
      if (types !== null && types.length === 0) {
        sendError(reply, 400, "BAD_REQUEST", "empty types filter");
        return undefined;
      }
      const { events, truncated } = deps.store.eventsForTask(
        request.params.id,
        types,
        query.data.limit,
      );
      return { taskId: request.params.id, events, truncated };
    },
  );

  // ── Analytics (master plan §7.6) ────────────────────────────────────────
  app.get<{ Querystring: { days?: string } }>("/v1/analytics", async (request, reply) => {
    if (deps.analytics === undefined) {
      sendError(reply, 404, "NOT_FOUND", "analytics service unavailable");
      return;
    }
    const parsed = Number(request.query.days ?? "14");
    const days = Number.isInteger(parsed) && parsed >= 1 && parsed <= 365 ? parsed : 14;
    return deps.analytics.snapshot({ days });
  });

  // ── Fusion runs (master plan §7.4) ──────────────────────────────────────
  app.get<{ Params: { id: string } }>("/v1/tasks/:id/fusion", async (request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    return { runs: deps.fleet.fusionRuns.listForTask(request.params.id) };
  });

  app.get<{ Params: { id: string; runId: string } }>(
    "/v1/tasks/:id/fusion/:runId",
    async (request, reply) => {
      if (deps.fleet === undefined) {
        sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
        return;
      }
      const detail = deps.fleet.fusionRuns.detail(request.params.id, request.params.runId);
      if (detail === null) {
        sendError(reply, 404, "NOT_FOUND", "fusion run not found");
        return;
      }
      return detail;
    },
  );

  // ── Prompt packs (master plan §2.6) ─────────────────────────────────────
  app.get("/v1/prompts", async (_request, reply) => {
    if (deps.prompts === undefined) {
      sendError(reply, 404, "NOT_FOUND", "prompt service unavailable");
      return;
    }
    return { templates: deps.prompts.list() };
  });

  app.get<{ Querystring: { ref?: string } }>("/v1/prompts/diff", async (request, reply) => {
    if (deps.prompts === undefined) {
      sendError(reply, 404, "NOT_FOUND", "prompt service unavailable");
      return;
    }
    const ref = request.query.ref;
    if (ref === undefined || ref.length === 0) {
      sendError(reply, 400, "BAD_REQUEST", "ref query parameter is required");
      return;
    }
    try {
      return deps.prompts.threeWayDiff(ref);
    } catch (error) {
      sendError(
        reply,
        400,
        "BAD_REQUEST",
        error instanceof Error ? error.message : "invalid prompt ref",
      );
      return;
    }
  });

  app.post("/v1/tools/call", async (request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    const body = toolCallRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_REQUEST", "invalid tool call body");
      return;
    }
    const toolParsed = brainToolNameSchema.safeParse(body.data.tool);
    if (!toolParsed.success) {
      sendError(reply, 400, "BAD_REQUEST", "unknown tool");
      return;
    }
    const result =
      body.data.sessionId !== undefined
        ? deps.fleet.tools.invokeFromSession(
            body.data.sessionId,
            toolParsed.data,
            body.data.input,
          )
        : deps.fleet.tools.invoke(
            toolParsed.data,
            body.data.input,
            body.data.idempotencyKey !== undefined
              ? { idempotencyKey: body.data.idempotencyKey }
              : {},
          );
    return {
      invocationId: result.invocationId,
      ok: result.ok,
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  });

  app.post("/v1/brain/start", async (_request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    const brain = deps.fleet.brain.start("api");
    return { brain };
  });

  app.get("/v1/brain", async (_request, reply) => {
    if (deps.fleet === undefined) {
      sendError(reply, 404, "NOT_FOUND", "fleet service unavailable");
      return;
    }
    return { brain: deps.fleet.brain.getSnapshot() };
  });

  // ── Phase 2: connections / quota / onboarding ──────────────────────────

  app.get("/v1/connections", async (_request, reply) => {
    if (deps.connections === undefined) {
      sendError(reply, 404, "NOT_FOUND", "connections service unavailable");
      return;
    }
    deps.connections.syncFromAuthStore();
    return {
      connections: deps.connections.list(),
      piPinnedVersion: PI_PINNED_VERSION,
    };
  });

  app.post("/v1/connections/oauth/start", async (request, reply) => {
    if (deps.connections === undefined) {
      sendError(reply, 404, "NOT_FOUND", "connections service unavailable");
      return;
    }
    const body = oauthStartRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_REQUEST", "invalid oauth start body");
      return;
    }
    const connection = deps.connections.upsertConnection({
      provider: body.data.provider,
      kind: "pi-oauth",
      billingMode: body.data.billingMode ?? null,
    });
    // Visible tmux login is driven by the host; we record the attach contract.
    // Inject PI_CONFIG_DIR (managed isolation) so login lands in the same store spawns use.
    const session = "agentos";
    const window = `login-${body.data.provider}`;
    const attachCommand = buildOAuthAttachCommand({
      session,
      window,
      provider: body.data.provider,
      pi: deps.pi,
      home: deps.home,
    });
    return {
      connectionId: connection.id,
      tmuxSession: session,
      tmuxWindow: window,
      attachCommand,
    };
  });

  app.post("/v1/connections/api-key", async (request, reply) => {
    if (deps.connections === undefined) {
      sendError(reply, 404, "NOT_FOUND", "connections service unavailable");
      return;
    }
    const body = apiKeyConnectRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_REQUEST", "invalid api-key body");
      return;
    }
    // Never log the key. Write to 0600 file under AGENTOS_HOME/secrets.
    writeApiKeyFile(deps.home, body.data.provider, body.data.apiKey);
    const connection = deps.connections.upsertConnection({
      provider: body.data.provider,
      kind: "pi-api-key",
      billingMode: body.data.provider === "anthropic" ? "api-key" : null,
      ...(body.data.label !== undefined ? { label: body.data.label } : {}),
    });
    const healthy = {
      ...connection,
      health: "healthy" as const,
      effectiveCredentialPath: "env-keychain" as const,
      updatedAt: new Date().toISOString(),
    };
    deps.connections.update(healthy);
    return { connection: healthy };
  });

  app.get("/v1/quota", async (_request, reply) => {
    if (deps.quotaSamples === undefined) {
      sendError(reply, 404, "NOT_FOUND", "quota service unavailable");
      return;
    }
    return { samples: [...deps.quotaSamples.values()] };
  });

  app.get<{ Params: { id: string } }>("/v1/connections/:id/quota", async (request, reply) => {
    if (deps.quotaSamples === undefined || deps.connections === undefined) {
      sendError(reply, 404, "NOT_FOUND", "quota service unavailable");
      return;
    }
    const connection = deps.connections.get(request.params.id);
    if (connection === null) {
      sendError(reply, 404, "NOT_FOUND", "connection not found");
      return;
    }
    return {
      connectionId: connection.id,
      sample: deps.quotaSamples.get(connection.id) ?? null,
    };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/connections/:id/quota/refresh",
    async (request, reply) => {
      if (
        deps.quotaSamples === undefined ||
        deps.connections === undefined ||
        deps.pi === undefined
      ) {
        sendError(reply, 404, "NOT_FOUND", "quota service unavailable");
        return;
      }
      const connection = deps.connections.get(request.params.id);
      if (connection === null) {
        sendError(reply, 404, "NOT_FOUND", "connection not found");
        return;
      }
      const authJsonPaths = resolveAuthJsonPathsWithFallback(
        deps.pi.isolationMode === "managed" ? deps.pi.managedHome : null,
      );
      const { sample, events } = await probeConnection({
        connection,
        config: deps.config.config.quota,
        authJsonPath: authJsonPaths[0] ?? "",
        authJsonPaths,
        agentosHome: deps.home,
      });
      deps.quotaSamples.set(connection.id, sample);
      for (const event of events) {
        deps.store.append(event);
      }
      const limit = isLimitReached(sample);
      deps.connections.setLimitReached(connection.id, limit.reached, limit.reason);
      return { connectionId: connection.id, sample };
    },
  );

  app.get("/v1/onboarding", async (_request, reply) => {
    if (deps.onboarding === undefined) {
      sendError(reply, 404, "NOT_FOUND", "onboarding service unavailable");
      return;
    }
    return { state: deps.onboarding.getState() };
  });

  app.post("/v1/onboarding", async (request, reply) => {
    if (deps.onboarding === undefined) {
      sendError(reply, 404, "NOT_FOUND", "onboarding service unavailable");
      return;
    }
    const body = onboardingAdvanceRequestSchema.safeParse(request.body);
    if (!body.success) {
      sendError(reply, 400, "BAD_REQUEST", "invalid onboarding action");
      return;
    }
    try {
      const svc = deps.onboarding;
      switch (body.data.action) {
        case "refresh-doctor":
          return { state: svc.refreshDoctor() };
        case "set-providers":
          return { state: svc.setProviders(body.data.providers ?? []) };
        case "verify-auth":
          if (body.data.provider === undefined) {
            sendError(reply, 400, "BAD_REQUEST", "provider required");
            return;
          }
          return { state: svc.verifyAuth(body.data.provider) };
        case "set-claude-billing": {
          if (body.data.claudeBillingMode === undefined) {
            sendError(reply, 400, "BAD_REQUEST", "claudeBillingMode required");
            return;
          }
          const state = svc.setClaudeBilling(body.data.claudeBillingMode);
          syncAnthropicBillingFromWizard(deps, state);
          return { state };
        }
        case "verify-claude-sdk":
          return { state: svc.verifyClaudeSdk() };
        case "enable-probes": {
          // Auto-enable probes for selected+verified providers (R5.1).
          if (deps.connections !== undefined) {
            deps.connections.syncFromAuthStore();
          }
          const result = enableProbesForOnboarding(deps, svc);
          if (result === "empty-selection") {
            sendError(
              reply,
              400,
              "BAD_REQUEST",
              "select and verify at least one provider before enabling probes",
            );
            return;
          }
          const state = svc.enableProbes();
          syncAnthropicBillingFromWizard(deps, state);
          return { state };
        }
        case "complete": {
          const state = svc.complete();
          syncAnthropicBillingFromWizard(deps, state);
          return { state };
        }
        case "restart":
          return { state: svc.restart() };
        default:
          sendError(reply, 400, "BAD_REQUEST", "unknown action");
          return;
      }
    } catch (error) {
      if (error instanceof OnboardingBlockedError) {
        sendError(reply, 409, "ONBOARDING_BLOCKED", error.message);
        return;
      }
      throw error;
    }
  });

  const replayQuerySchema = z.object({
    after: z.string().optional(),
    /** Exclusive upper bound for newest-first pages (`order=desc`). */
    before: z.string().optional(),
    /**
     * `asc` — oldest-first after `after` (SSE Last-Event-ID semantics, default).
     * `desc` — newest-first before `before` (evidence surfaces).
     */
    order: z.enum(["asc", "desc"]).default("asc"),
    limit: z.coerce.number().int().min(1).max(10_000).default(1000),
  });

  app.get("/v1/events/replay", (request, reply): EventsReplayResponse | undefined => {
    const query = replayQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "BAD_REQUEST", "invalid replay query");
      return undefined;
    }
    if (query.data.order === "desc") {
      const { events, truncated } = deps.store.eventsBeforeId(
        query.data.before ?? null,
        query.data.limit,
      );
      return { events, truncated };
    }
    const { events, truncated } = deps.store.eventsAfterId(
      query.data.after ?? null,
      query.data.limit,
    );
    return { events, truncated };
  });

  /**
   * SSE stream (§8.2): ULID event ids, `Last-Event-ID` replay, heartbeat
   * cadence read live from supervision config (hot-reload observable).
   */
  app.get("/v1/events", (request, reply) => {
    const query = z.object({ after: z.string().optional() }).safeParse(request.query);
    const headerCursor = request.headers["last-event-id"];
    const cursor =
      typeof headerCursor === "string" && headerCursor.length > 0
        ? headerCursor
        : (query.success ? query.data.after : undefined) ?? null;

    reply.hijack();
    const raw = reply.raw;
    sseStreams.add(raw);

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    let drainWaiter: ((ok: boolean) => void) | null = null;
    /** Serialize writes so live fan-out cannot interleave with drain waits. */
    let writeChain: Promise<void> = Promise.resolve();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      sseStreams.delete(raw);
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      if (heartbeatTimer !== null) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
      if (drainWaiter !== null) {
        const waiter = drainWaiter;
        drainWaiter = null;
        waiter(false);
      }
      try {
        raw.end();
      } catch {
        try {
          raw.destroy();
        } catch {
          // already gone
        }
      }
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);
    raw.on("error", cleanup);
    if (request.raw.destroyed || raw.destroyed || request.raw.closed || raw.writableEnded) {
      cleanup();
      return;
    }

    raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const waitForDrain = (): Promise<boolean> =>
      new Promise((resolve) => {
        if (closed) {
          resolve(false);
          return;
        }
        const finish = (ok: boolean): void => {
          if (stallTimer !== null) {
            clearTimeout(stallTimer);
            stallTimer = null;
          }
          drainWaiter = null;
          raw.off("drain", onDrain);
          resolve(ok && !closed);
        };
        const onDrain = (): void => finish(true);
        drainWaiter = finish;
        stallTimer = setTimeout(() => {
          cleanup();
        }, SSE_STALL_MS);
        raw.once("drain", onDrain);
      });

    /**
     * Write a chunk; on backpressure wait for `drain` (or drop the subscriber
     * if the client stays stalled).
     */
    const safeWrite = async (chunk: string): Promise<boolean> => {
      if (closed) return false;
      try {
        const ok = raw.write(chunk);
        if (ok) return true;
        if (!raw.writableNeedDrain) return true;
        return waitForDrain();
      } catch {
        cleanup();
        return false;
      }
    };

    const enqueueWrite = (chunk: string): Promise<boolean> => {
      const result = writeChain.then(
        () => safeWrite(chunk),
        () => safeWrite(chunk),
      );
      writeChain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const writeFrame = (envelope: { id: string; event: { type: string } }): Promise<boolean> =>
      enqueueWrite(
        `id: ${envelope.id}\nevent: ${envelope.event.type}\ndata: ${JSON.stringify(envelope)}\n\n`,
      );

    void (async () => {
      let live = false;
      try {
        if (!(await enqueueWrite(`retry: 2000\n\n`))) return;

        // Subscribe first into a buffer so appends during paged replay are not lost;
        // after replay, drain with id de-dupe then switch to direct fan-out.
        const liveBuffer: Array<{ id: string; event: { type: string } }> = [];
        let buffering = true;
        const seenIds = new Set<string>();

        unsubscribe = deps.store.subscribe((envelope) => {
          if (closed) return;
          if (buffering) {
            liveBuffer.push(envelope);
            return;
          }
          void writeFrame(envelope);
        });

        let afterId: string | null = cursor;
        for (;;) {
          const page = deps.store.eventsAfterId(afterId, SSE_REPLAY_PAGE);
          for (const envelope of page.events) {
            if (closed) return;
            seenIds.add(envelope.id);
            if (!(await writeFrame(envelope))) return;
          }
          if (!page.truncated || page.events.length === 0) break;
          const last = page.events[page.events.length - 1];
          if (last === undefined) break;
          afterId = last.id;
        }
        if (closed) return;

        while (liveBuffer.length > 0) {
          const batch = liveBuffer.splice(0, liveBuffer.length);
          for (const envelope of batch) {
            if (closed) return;
            if (seenIds.has(envelope.id)) continue;
            seenIds.add(envelope.id);
            if (!(await writeFrame(envelope))) return;
          }
        }
        // Buffer empty and no await between check and flip: single-threaded handoff.
        buffering = false;

        // Heartbeat: cadence follows supervision.heartbeatSeconds live, so a
        // hot-reloaded value is observable on the wire (§11 config gate).
        const scheduleHeartbeat = (): void => {
          if (closed) return;
          const seconds = deps.config.config.supervision.heartbeatSeconds;
          heartbeatTimer = setTimeout(() => {
            void enqueueWrite(`: heartbeat ${seconds}s\n\n`).then((ok) => {
              if (ok) scheduleHeartbeat();
            });
          }, seconds * 1000);
        };
        scheduleHeartbeat();
        live = true;
      } catch {
        // ignore
      } finally {
        if (!live) cleanup();
      }
    })();
  });

  app.get("/v1/config/effective", () => {
    return deps.config.effective();
  });

  const configParamsSchema = z.object({
    layer: configLayerSchema,
    domain: configDomainSchema,
  });

  app.get("/v1/config/:layer/:domain", (request, reply) => {
    const params = configParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 404, "NOT_FOUND", "unknown config layer or domain");
      return undefined;
    }
    const { layer, domain } = params.data;
    if (layer === "project" || layer === "task") {
      sendError(
        reply,
        400,
        "LAYER_NOT_WRITABLE",
        `${layer} layers are trust-gated/task-scoped and land in Phase 2+`,
      );
      return undefined;
    }
    return { layer, domain, value: deps.config.layerValue(layer, domain) };
  });

  app.put("/v1/config/:layer/:domain", (request, reply) => {
    const params = configParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 404, "NOT_FOUND", "unknown config layer or domain");
      return undefined;
    }
    const { layer, domain } = params.data;
    if (layer !== "global") {
      sendError(
        reply,
        400,
        "LAYER_NOT_WRITABLE",
        layer === "shipped"
          ? "shipped defaults are read-only by design (§2.6)"
          : `${layer} layers are trust-gated/task-scoped and land in Phase 2+`,
      );
      return undefined;
    }

    const body = request.body;
    const json5Text =
      typeof body === "string" ? body : JSON.stringify(body ?? {}, null, 2);

    // Safety-policy writes require explicit Captain confirmation (§11 gate).
    if (domain === "policies") {
      const confirm = request.headers[SAFETY_CONFIRM_HEADER];
      if (confirm !== "true" && confirm !== "yes") {
        sendError(
          reply,
          428,
          "CONFIRMATION_REQUIRED",
          `safety-policy writes require the ${SAFETY_CONFIRM_HEADER}: true header (Captain-only, §2.6 #12)`,
        );
        return undefined;
      }
    }

    try {
      const { contentHash } = deps.config.writeGlobal(domain, json5Text);
      if (domain === "policies") {
        const effective = safetyPoliciesConfigSchema.parse(deps.config.config.policies);
        const safetyOverride = Object.values(effective).some((enabled) => !enabled);
        deps.store.append({
          type: "policy.changed",
          payload: { domain: "policies", layer: "global", safetyOverride },
        });
      }
      return { applied: true as const, domain, layer, contentHash };
    } catch (error) {
      if (error instanceof ConfigWriteError) {
        sendError(
          reply,
          400,
          "CONFIG_INVALID",
          `invalid ${error.layer} config for domain "${error.domain}" — nothing applied`,
          error.issues,
        );
        return undefined;
      }
      throw error;
    }
  });

  return Object.assign(app, { destroySseStreams });
}

/**
 * R5.1: flip quota.json5 providers.enabled for onboarding providers.
 * Presence fallback only when the selection checklist is empty; if any
 * providers are selected, enable only selected+verified (or selected).
 * Unprobeable-only selections (e.g. vercel-ai-gateway) return ok as a no-op.
 */
function enableProbesForOnboarding(
  deps: ServerDeps,
  svc: OnboardingService,
): "ok" | "empty-selection" {
  const state = svc.getState();
  const selected = state.providers.filter((p) => p.selected);

  if (selected.length > 0) {
    const selectedVerified = selected.filter((p) => p.authVerified);
    const toEnable = selectedVerified.length > 0 ? selectedVerified : selected;
    enableQuotaProviders(
      deps.config,
      toEnable.map((p) => ({
        provider: p.provider,
        billingMode: p.claudeBillingMode,
      })),
    );
    return "ok";
  }

  // Presence fallback only when the checklist is empty (never seeded).
  if (state.providers.length > 0) return "empty-selection";

  const presence = listDetectedProviders(deps.home).filter((p) => p.present);
  if (presence.length === 0) return "empty-selection";
  enableQuotaProviders(
    deps.config,
    presence.map((p) => ({ provider: p.provider, billingMode: null })),
  );
  return "ok";
}

/**
 * Keep anthropic ProviderConnection.billingMode/billingSurface aligned with the
 * wizard so probes/readProbeToken take the subscription-sdk Claude Code path.
 * Upserts only the mode-matching kind (api-key → pi-api-key, else pi-oauth)
 * so oauth and api-key cards are never cross-stamped.
 */
function syncAnthropicBillingFromWizard(deps: ServerDeps, state: OnboardingState): void {
  if (deps.connections === undefined) return;
  const claude = state.providers.find(
    (p) => p.provider === "anthropic" && p.selected && p.claudeBillingMode !== null,
  );
  if (claude === undefined || claude.claudeBillingMode === null) return;
  const mode = claude.claudeBillingMode;
  const kind = mode === "api-key" ? "pi-api-key" : "pi-oauth";
  deps.connections.upsertConnection({
    provider: "anthropic",
    kind,
    billingMode: mode,
  });
}

/**
 * OAuth login attach command — inject managed PI_CONFIG_DIR so credentials
 * land in the same store buildPiSpawnSpec uses for casts.
 */
function buildOAuthAttachCommand(options: {
  session: string;
  window: string;
  provider: string;
  pi: PiDetection | undefined;
  home: string;
}): string {
  const configDirEnv = options.pi?.configDirEnv ?? "PI_CONFIG_DIR";
  const managedHome = options.pi?.managedHome ?? `${options.home}/pi`;
  const binary = options.pi?.binary ?? "pi";
  const quotedBinary = shellSingleQuote(binary);
  const useManaged =
    options.pi === undefined ||
    options.pi.isolationMode === "managed" ||
    options.pi.configDirEnv !== null;
  const login = useManaged
    ? `env ${configDirEnv}=${shellSingleQuote(managedHome)} ${quotedBinary} /login ${options.provider}`
    : `${quotedBinary} /login ${options.provider}`;
  return `tmux -L agentos new-session -A -s ${options.session} \\; new-window -n ${options.window} -- ${login}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function mapToolError(code: string | undefined): ApiErrorCode {
  switch (code) {
    case "ILLEGAL_TRANSITION":
      return "ILLEGAL_TRANSITION";
    case "POLICY_VIOLATION":
      return "POLICY_VIOLATION";
    case "BRAIN_DOWN":
      return "BRAIN_DOWN";
    case "LIMIT_REACHED":
      return "LIMIT_REACHED";
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "CONFLICT":
      return "CONFLICT";
    default:
      return "BAD_REQUEST";
  }
}
