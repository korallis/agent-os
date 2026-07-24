import {
  healthResponseSchema,
  statusResponseSchema,
} from "@agent-os/protocol";
import { startDaemon } from "./daemon.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { readToken, resolveHome } from "./home.js";
import { DEFAULT_PORT, LOOPBACK_HOST } from "./version.js";

/** The `agentos` CLI (master plan piece #4): start · status · doctor. */

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

export async function runBearings(): Promise<void> {
  const base = `http://${LOOPBACK_HOST}:${cliPort()}`;
  try {
    const token = readToken(resolveHome());
    const response = await fetch(`${base}/v1/fleet`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      console.log(`bearings: daemon error ${response.status}`);
      process.exitCode = 1;
      return;
    }
    const body = (await response.json()) as {
      summary: {
        active: number;
        queued: number;
        needsCaptain: number;
        doneToday: number;
        failed: number;
        brainDown: boolean;
        brain: { status: string; model: string | null; wakeQueueDepth: number };
      };
    };
    const s = body.summary;
    console.log("agentos bearings");
    console.log(`  brain      ${s.brain.status}${s.brainDown ? " (DOWN)" : ""}  model=${s.brain.model ?? "—"}`);
    console.log(`  wake queue ${s.brain.wakeQueueDepth}`);
    console.log(`  active     ${s.active}`);
    console.log(`  queued     ${s.queued}`);
    console.log(`  needs you  ${s.needsCaptain}`);
    console.log(`  done today ${s.doneToday}`);
    console.log(`  failed     ${s.failed}`);
  } catch {
    console.log("bearings: daemon not reachable");
    process.exitCode = 1;
  }
}

export async function runAfk(duration?: string): Promise<void> {
  console.log(
    `afk: autonomy posture armed${duration !== undefined ? ` for ${duration}` : ""} (Phase 8 full FAQ auto-answer pending)`,
  );
  console.log("  — extended thresholds and batched reports use supervision/budgets config");
}

export async function runStow(): Promise<void> {
  console.log("stow: knowledge sweep — use Brain tool stow_knowledge (docs/notes/) from Console/Brain chat");
}

const USAGE = `agentos — Agent OS CLI

usage:
  agentos start       run the agentosd daemon in the foreground
  agentos status      report daemon health and event-store status
  agentos doctor      verify tmux/git/gh/node/pi/uv presence (warnings only)
  agentos bearings    fleet snapshot (/v1/fleet)
  agentos afk [dur]   autonomy posture (Phase 8)
  agentos stow        knowledge sweep hint
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
    case "bearings":
      await runBearings();
      return;
    case "afk":
      await runAfk(argv[1]);
      return;
    case "stow":
      await runStow();
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
