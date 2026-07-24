import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino, { type Logger } from "pino";
import { EventStore } from "@agent-os/event-store";
import { ensureHome, readToken, resolveHome } from "./home.js";
import { ConfigService } from "./config/service.js";
import { buildServer, type AgentosdServer } from "./server/app.js";
import { AGENTOSD_VERSION, DEFAULT_PORT, LOOPBACK_HOST } from "./version.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Shipped Policy Pack defaults — inside the package, never edited (§2.6). */
export const SHIPPED_DEFAULTS_DIR = join(here, "..", "defaults");

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
 * Boots agentosd (master plan §2.5): home init → shipped-defaults install →
 * event-store open (log replay + corrupt-tail quarantine) → config layering
 * + watcher → Fastify on 127.0.0.1 (loopback config-locked) → daemon.started.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const home = options.home ?? resolveHome();
  const paths = ensureHome(home);
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
  const { store } = opened;
  if (opened.quarantinedTail !== null) {
    logger.warn({ quarantinedTail: opened.quarantinedTail }, "corrupt event-log tail quarantined");
  }
  if (opened.replayed > 0) {
    logger.info({ replayed: opened.replayed }, "projection replayed from event log");
  }

  const config = new ConfigService(SHIPPED_DEFAULTS_DIR, paths.configDir);
  const installed = config.installDefaults();
  config.onEvent((event) => {
    store.append(event);
  });
  if (installed.length > 0) {
    store.append({ type: "config.installed", payload: { domains: installed } });
  }
  config.startWatching();

  const token = readToken(home);
  const startedAt = new Date().toISOString();

  const deps = { store, config, token, home, port, startedAt, logger };
  const server = buildServer(deps);
  await server.listen({ host: LOOPBACK_HOST, port });
  const boundPort = (() => {
    const address = server.server.address();
    return typeof address === "object" && address !== null ? address.port : port;
  })();
  // With port 0 (tests) the real port is only known after listen.
  deps.port = boundPort;

  store.append({
    type: "daemon.started",
    payload: { version: AGENTOSD_VERSION, pid: process.pid, home, port: boundPort },
  });
  logger.info({ home, port: boundPort, version: AGENTOSD_VERSION }, "agentosd started");

  let closed = false;
  return {
    home,
    port: boundPort,
    token,
    startedAt,
    store,
    config,
    server,
    logger,
    async close(reason = "shutdown", signal?: string) {
      if (closed) return;
      closed = true;
      store.append({
        type: "daemon.stopping",
        payload: { reason, signal: signal ?? null },
      });
      config.stop();
      await server.close();
      store.close();
      logger.info({ reason }, "agentosd stopped");
      fileDestination.flushSync();
    },
  };
}
