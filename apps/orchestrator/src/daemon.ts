import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino, { type Logger } from "pino";
import { EventStore } from "@agent-os/event-store";
import {
  acquireHomeLock,
  ensureDaemonToken,
  ensureHome,
  resolveHome,
  type HomeLock,
} from "./home.js";
import { ConfigService } from "./config/service.js";
import { buildServer, type AgentosdServer } from "./server/app.js";
import { AGENTOSD_VERSION, DEFAULT_PORT, LOOPBACK_HOST } from "./version.js";
import { ConnectionRegistry } from "./pi/connections.js";
import { PiAuthBroker } from "./pi/auth-broker.js";
import { detectPi } from "./pi/manager.js";
import { SocketHub } from "./pi/socket-hub.js";
import { OnboardingService } from "./onboarding/state.js";
import {
  hydrateQuotaSamples,
  QuotaProbeScheduler,
} from "./quota-probes/scheduler.js";
import { enableQuotaProviders } from "./quota-probes/enable.js";
import type { QuotaSample } from "@agent-os/protocol";
import { FleetService } from "./fleet/service.js";
import { PromptService } from "./prompts/service.js";
import { AnalyticsService } from "./analytics/service.js";
import { PtyTicketStore } from "./pty/tickets.js";
import { attachPtyServer } from "./pty/server.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Shipped Policy Pack defaults — inside the package, never edited (§2.6). */
export const SHIPPED_DEFAULTS_DIR = join(here, "..", "defaults");
/** Shipped prompt packs — copied into the editable global layer on boot (§2.6). */
export const SHIPPED_PROMPTS_DIR = join(here, "..", "defaults", "prompts");

/** Preferred on-disk location of the built Pi extension (operator-facing path). */
export const EXPECTED_EXTENSION_DIST = join(
  here,
  "..",
  "..",
  "..",
  "packages",
  "pi-extension",
  "dist",
  "extension.js",
);

/**
 * Resolve a built @agent-os/pi-extension entry. Returns undefined when no dist
 * file exists so Brain/crewmate spawn fail closed (PI_UNAVAILABLE / BRAIN_DOWN)
 * instead of launching Pi with `-e <missing>`.
 */
export function resolveExtensionPath(): string | undefined {
  const candidates = [
    EXPECTED_EXTENSION_DIST,
    join(here, "..", "node_modules", "@agent-os", "pi-extension", "dist", "extension.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/** Grace period before force-destroying hijacked SSE sockets on shutdown. */
const SSE_SHUTDOWN_GRACE_MS = 150;

export interface DaemonOptions {
  /** State home; defaults to AGENTOS_HOME or ~/.agentos. */
  home?: string;
  /** Port override for tests (0 = ephemeral). Host is config-locked loopback. */
  port?: number;
  /** Also log to stdout (CLI foreground mode). */
  stdout?: boolean;
}

export interface RunningDaemon {
  home: string;
  port: number;
  token: string;
  startedAt: string;
  store: EventStore;
  config: ConfigService;
  server: AgentosdServer;
  logger: Logger;
  close(reason?: "signal" | "shutdown", signal?: string): Promise<void>;
}

function resolvePort(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const env = process.env.AGENTOS_PORT;
  if (env !== undefined && env.length > 0) {
    const parsed = Number(env);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) return parsed;
  }
  return DEFAULT_PORT;
}

/**
 * Boots agentosd (master plan §2.5): home dirs → exclusive home lock →
 * daemon.token (under lock) → shipped-defaults install → event-store open
 * (log replay + corrupt-tail quarantine) → config layering + watcher →
 * Fastify on 127.0.0.1 (loopback config-locked) → daemon.started.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const home = options.home ?? resolveHome();
  const paths = ensureHome(home);
  const lock: HomeLock = acquireHomeLock(home);
  /** True until ownership is transferred to a returned RunningDaemon.close. */
  let lockOwned = true;

  let store: EventStore | undefined;
  let config: ConfigService | undefined;
  let server: AgentosdServer | undefined;

  try {
    const token = ensureDaemonToken(home);
    const port = resolvePort(options.port);

    const fileDestination = pino.destination({ dest: paths.logFile, mkdir: true, sync: false });
    const streams: pino.StreamEntry[] = [{ level: "info", stream: fileDestination }];
    if (options.stdout === true) {
      streams.push({ level: "info", stream: process.stdout });
    }
    const logger = pino(
      {
        level: "info",
        // No secrets in logs: bearer material is redacted, and the token value
        // itself is never passed to the logger anywhere in this codebase.
        redact: {
          paths: ["req.headers.authorization", "headers.authorization"],
          censor: "[REDACTED]",
        },
      },
      pino.multistream(streams),
    );

    const opened = EventStore.open(home);
    store = opened.store;
    if (opened.quarantinedTail !== null) {
      logger.warn({ quarantinedTail: opened.quarantinedTail }, "corrupt event-log tail quarantined");
    }
    if (opened.replayed > 0) {
      logger.info({ replayed: opened.replayed }, "projection replayed from event log");
    }

    config = new ConfigService(SHIPPED_DEFAULTS_DIR, paths.configDir);
    const installed = config.installDefaults();
    const eventStore = store;
    config.onEvent((event) => {
      eventStore.append(event);
    });
    if (installed.length > 0) {
      store.append({ type: "config.installed", payload: { domains: installed } });
    }
    config.startWatching();

    const startedAt = new Date().toISOString();

    const pi = detectPi(home);
    const authBroker = PiAuthBroker.forManagedHome(pi.managedHome);
    const connections = new ConnectionRegistry(home);
    connections.onEvent((event) => {
      eventStore.append(event);
    });
    // R5.1: new / detected connections auto-enable matching quota probes.
    const configService = config;
    connections.onProbeAutoEnable(({ provider, billingMode }) => {
      enableQuotaProviders(configService, [{ provider, billingMode }]);
    });
    connections.syncFromAuthStore();

    const onboarding = new OnboardingService(home);
    onboarding.onEvent((event) => {
      eventStore.append(event);
    });

    const quotaSamples: Map<string, QuotaSample> = hydrateQuotaSamples(store);
    const socketHub = new SocketHub(join(home, "sockets"));
    socketHub.onEvent((event) => {
      eventStore.append(event);
    });
    try {
      await socketHub.listen();
    } catch (error) {
      logger.warn({ err: error }, "socket hub failed to listen — extension channel unavailable");
    }

    const extensionPath = resolveExtensionPath();
    if (extensionPath === undefined) {
      logger.warn(
        { expected: EXPECTED_EXTENSION_DIST },
        "agent-os Pi extension dist not found — Brain and crewmate spawn will fail closed (PI_UNAVAILABLE / BRAIN_DOWN); build packages/pi-extension first",
      );
    }
    // Prompt packs are files first: shipped templates are materialised into the
    // global layer so the Captain tunes behaviour by editing files, not code.
    const prompts = new PromptService(SHIPPED_PROMPTS_DIR, join(home, "prompts"));
    prompts.onEvent((event) => {
      eventStore.append(event);
    });
    prompts.installDefaults();

    const agentosdBin = resolveAgentosdBin();
    const fleet = new FleetService({
      home,
      config,
      connections,
      prompts,
      pi,
      authBroker,
      agentosdBin,
      ...(extensionPath !== undefined ? { extensionPath } : {}),
      sockets: socketHub,
      fakeTmux: process.env.AGENTOS_FAKE_TMUX === "1",
      fakePi: process.env.AGENTOS_FAKE_PI === "1",
      fakeBrain: process.env.AGENTOS_FAKE_BRAIN === "1",
      // Read live rather than snapshotting: a handoff decision made from a
      // stale sample is a decision about a window that already moved.
      quotaSamples: () => [...quotaSamples.values()],
    });
    fleet.onEvent((event) => {
      eventStore.append(event);
    });
    // Live visibility + the Brain's tool bridge both ride the extension socket.
    socketHub.onExtensionFrame((frame) => {
      try {
        fleet.handleExtensionFrame(frame);
      } catch (error) {
        logger.warn({ err: error, frame: frame.type }, "extension frame handling failed");
      }
    });

    // Analytics is a pure reader over durable state — no separate accounting
    // store to drift out of sync with the event log. The reader is time-bounded
    // to the requested window (newest-first so truncation drops oldest frames)
    // and surfaces truncation when the bound is hit. Session attribution uses a
    // separate non-windowed session.spawned lookup.
    const analytics = new AnalyticsService(
      ({ days, limit }) => {
        const since = new Date();
        since.setUTCDate(since.getUTCDate() - (days - 1));
        since.setUTCHours(0, 0, 0, 0);
        const sinceTs = since.toISOString();
        const page = eventStore.eventsSince(sinceTs, limit);
        // Prefer the projection count when available so we report truncation
        // even if the page itself filled exactly to the limit boundary.
        const inWindow = eventStore.countSince(sinceTs);
        return {
          events: page.events,
          truncated: page.truncated || inWindow > limit,
        };
      },
      () => [...quotaSamples.values()],
      () => {
        const { events: spawns, truncated: spawnTruncated } = eventStore.eventsByType(
          "session.spawned",
          100_000,
        );
        const facts: Array<{
          sessionId: string;
          role: string;
          model: string;
          taskId: string | null;
        }> = [];
        for (const envelope of spawns) {
          if (envelope.event.type !== "session.spawned") continue;
          facts.push({
            sessionId: envelope.event.payload.sessionId,
            role: envelope.event.payload.role,
            model: envelope.event.payload.model,
            taskId: envelope.event.payload.taskId,
          });
        }
        return { facts, truncated: spawnTruncated };
      },
      () =>
        connections
          .list()
          .map((c) => ({ provider: c.provider, billingSurface: c.billingSurface })),
    );

    // Read-only terminal attach: single-use tickets minted over authenticated
    // REST, redeemed once on the WS upgrade. WS is used for PTY only (§8).
    const ptyTickets = new PtyTicketStore();

    const deps = {
      store,
      config,
      token,
      home,
      port,
      startedAt,
      logger,
      connections,
      onboarding,
      pi,
      authBroker,
      quotaSamples,
      fleet,
      prompts,
      analytics,
      ptyTickets,
    };
    server = buildServer(deps);
    await server.listen({ host: LOOPBACK_HOST, port });
    const address = server.server.address();
    const boundPort =
      typeof address === "object" && address !== null ? address.port : port;
    // With port 0 (tests) the real port is only known after listen.
    deps.port = boundPort;
    fleet.setPrimaryPort(boundPort);

    const pty = attachPtyServer({
      server: server.server,
      tickets: ptyTickets,
      tmux: fleet.tmux,
      resolveTarget: (sessionId) =>
        fleet.tools.listSessions().find((s) => s.sessionId === sessionId)?.tmuxWindow ?? null,
    });

    const quotaScheduler = new QuotaProbeScheduler({
      home,
      store,
      config,
      connections,
      pi,
      quotaSamples,
      logger,
    });
    quotaScheduler.start();

    // Start Brain after listen so REST is available during reconcile.
    try {
      await fleet.start();
    } catch (error) {
      logger.warn({ err: error }, "brain start failed — entering degraded mode");
      fleet.brain.enterDown(error instanceof Error ? error.message : "brain start failed");
    }

    store.append({
      type: "daemon.started",
      payload: { version: AGENTOSD_VERSION, pid: process.pid, home, port: boundPort },
    });
    logger.info(
      {
        home,
        port: boundPort,
        version: AGENTOSD_VERSION,
        piVersion: pi.version,
        piPinned: pi.pinnedVersion,
        hydratedQuotaSamples: quotaSamples.size,
        brain: fleet.brain.getSnapshot().status,
      },
      "agentosd started",
    );

    const runningStore = store;
    const runningConfig = config;
    const runningServer = server;
    const runningFleet = fleet;
    let closed = false;
    lockOwned = false;
    return {
      home,
      port: boundPort,
      token,
      startedAt,
      store: runningStore,
      config: runningConfig,
      server: runningServer,
      logger,
      async close(reason = "shutdown", signal?: string) {
        if (closed) return;
        closed = true;
        try {
          await runningFleet.stop();
          quotaScheduler.stop();
          runningStore.append({
            type: "daemon.stopping",
            payload: { reason, signal: signal ?? null },
          });
          runningConfig.stop();
          await pty.close();
          await socketHub.close();
          const closePromise = runningServer.close();
          await new Promise<void>((resolve) => setTimeout(resolve, SSE_SHUTDOWN_GRACE_MS));
          runningServer.destroySseStreams();
          runningServer.server.closeAllConnections();
          await closePromise;
          logger.info({ reason }, "agentosd stopped");
          fileDestination.flushSync();
        } finally {
          try {
            runningStore.close();
          } catch {
            // best-effort
          }
          try {
            lock.release();
          } catch {
            // best-effort
          }
        }
      },
    };
  } catch (error) {
    try {
      config?.stop();
    } catch {
      // best-effort
    }
    try {
      if (server !== undefined) await server.close();
    } catch {
      // best-effort
    }
    try {
      store?.close();
    } catch {
      // best-effort
    }
    throw error;
  } finally {
    if (lockOwned) {
      lock.release();
    }
  }
}

/** Resolve the on-disk agentosd entrypoint for secondmate child processes. */
function resolveAgentosdBin(): string {
  // Prefer the running process path when launched as agentosd.js.
  const argv1 = process.argv[1];
  if (typeof argv1 === "string" && argv1.length > 0 && existsSync(argv1)) {
    return argv1;
  }
  const candidate = join(here, "bin", "agentosd.js");
  if (existsSync(candidate)) return candidate;
  return join(here, "bin", "agentosd.js");
}
