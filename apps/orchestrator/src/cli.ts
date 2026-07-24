import {
  healthResponseSchema,
  statusResponseSchema,
} from "@agent-os/protocol";
import { startDaemon } from "./daemon.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { readToken, resolveHome } from "./home.js";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./version.js";

/** The `agentos` CLI skeleton (master plan piece #4): start · status · doctor. */

export async function runStart(): Promise<void> {
  const daemon = await startDaemon({ stdout: true });
  const shutdown = (signal: string): void => {
    daemon
      .close("signal", signal)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function cliPort(): number {
  const env = process.env.AGENTOS_PORT;
  if (env !== undefined && env.length > 0) {
    const parsed = Number(env);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_PORT;
}

export async function runStatus(): Promise<void> {
  const base = `http://${LOOPBACK_HOST}:${cliPort()}`;
  let health: unknown;
  try {
    const response = await fetch(`${base}/v1/health`);
    health = await response.json();
  } catch {
    console.log(`agentosd: NOT RUNNING (no listener on ${base})`);
    process.exitCode = 1;
    return;
  }
  const parsedHealth = healthResponseSchema.safeParse(health);
  if (!parsedHealth.success) {
    console.log(`agentosd: listener on ${base} did not identify as agentosd`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `agentosd: RUNNING  v${parsedHealth.data.version}  pid ${parsedHealth.data.pid}  ${base}`,
  );

  try {
    const token = readToken(resolveHome());
    const response = await fetch(`${base}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const parsed = statusResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      const { daemon, events } = parsed.data;
      console.log(`  home       ${daemon.home}`);
      console.log(`  started    ${daemon.startedAt} (up ${Math.round(daemon.uptimeSeconds)}s)`);
      console.log(`  events     ${events.count} (last seq ${events.lastSeq})`);
    }
  } catch {
    console.log("  (status detail unavailable — token not readable from this home)");
  }
}

export function runDoctorCommand(): void {
  console.log(formatDoctorReport(runDoctor()));
}

const USAGE = `agentos — Agent OS CLI (Phase 1 skeleton)

usage:
  agentos start    run the agentosd daemon in the foreground
  agentos status   report daemon health and event-store status
  agentos doctor   verify tmux/git/gh/node/pi/uv presence (warnings only)
`;

export async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  switch (command) {
    case "start":
      await runStart();
      return;
    case "status":
      await runStatus();
      return;
    case "doctor":
      runDoctorCommand();
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}
