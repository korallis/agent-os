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
  configDomainSchema,
  configLayerSchema,
  SAFETY_CONFIRM_HEADER,
  safetyPoliciesConfigSchema,
  type ApiErrorCode,
  type ConfigValidationIssue,
  type EventsReplayResponse,
  type HealthResponse,
  type StatusResponse,
} from "@agent-os/protocol";
import type { EventStore } from "@agent-os/event-store";
import { ConfigService, ConfigWriteError } from "../config/service.js";
import { AGENTOSD_VERSION } from "../version.js";

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
    };
  });

  const replayQuerySchema = z.object({
    after: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(10_000).default(1000),
  });

  app.get("/v1/events/replay", (request, reply): EventsReplayResponse | undefined => {
    const query = replayQuerySchema.safeParse(request.query);
    if (!query.success) {
      sendError(reply, 400, "BAD_REQUEST", "invalid replay query");
      return undefined;
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
      if (!(await enqueueWrite(`retry: 2000\n\n`))) return;

      // Replay every page after the cursor (truncated pages are continued)
      // before switching to live subscribe so Last-Event-ID clients never skip.
      let afterId: string | null = cursor;
      for (;;) {
        const page = deps.store.eventsAfterId(afterId, SSE_REPLAY_PAGE);
        for (const envelope of page.events) {
          if (closed) return;
          if (!(await writeFrame(envelope))) return;
        }
        if (!page.truncated || page.events.length === 0) break;
        const last = page.events[page.events.length - 1];
        if (last === undefined) break;
        afterId = last.id;
      }
      if (closed) return;

      unsubscribe = deps.store.subscribe((envelope) => {
        void writeFrame(envelope);
      });

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
