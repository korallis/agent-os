import {
  healthResponseSchema,
  statusResponseSchema,
} from "@agent-os/protocol";
import type { AfkState } from "@agent-os/protocol";
import { startDaemon } from "./daemon.js";
import { formatConfigDoctor, type ConfigDoctorReport } from "./prompts/doctor.js";
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

/**
 * `agentos afk [on|off] [duration]` — arm or report the autonomy posture.
 *
 * Duration accepts `90m`, `8h`, `2d`. Arming without a FAQ is legal and means
 * "answer nothing automatically", which is honest: the posture is armed but
 * every question still waits for the Captain.
 */
export function parseDuration(input: string): number | null {
  const match = /^(\d+)([mhd])$/.exec(input.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2];
  const minutes = unit === "m" ? value : unit === "h" ? value * 60 : value * 60 * 24;
  return minutes * 60_000;
}

export async function runAfk(mode?: string, duration?: string): Promise<void> {
  const base = `http://${LOOPBACK_HOST}:${cliPort()}`;
  let token: string;
  try {
    token = readToken(resolveHome());
  } catch {
    console.log("afk: daemon home not readable");
    process.exitCode = 1;
    return;
  }

  const printState = (state: AfkState, active: boolean): void => {
    console.log(`afk: ${active ? "ARMED" : "OFF"}${state.until !== null ? `  until ${state.until}` : ""}`);
    console.log(`  faq entries   ${state.faq.length}`);
    console.log(`  auto-answered ${state.answered}`);
    console.log(`  escalated     ${state.escalated}`);
    if (state.faq.length === 0 && active) {
      // Say it plainly rather than letting "ARMED" imply autonomy that is not there.
      console.log("  (no FAQ entries — every question still waits for you)");
    }
  };

  try {
    if (mode === undefined || mode === "status") {
      const response = await fetch(`${base}/v1/afk`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        console.log(`afk: daemon error ${response.status}`);
        process.exitCode = 1;
        return;
      }
      const body = (await response.json()) as { afk: AfkState; active: boolean };
      printState(body.afk, body.active);
      return;
    }

    if (mode !== "on" && mode !== "off") {
      console.log("afk: usage — agentos afk [on [duration] | off | status]");
      process.exitCode = 2;
      return;
    }

    let until: string | null = null;
    if (mode === "on" && duration !== undefined) {
      const ms = parseDuration(duration);
      if (ms === null) {
        console.log(`afk: unrecognised duration "${duration}" (expected e.g. 90m, 8h, 2d)`);
        process.exitCode = 2;
        return;
      }
      until = new Date(Date.now() + ms).toISOString();
    }

    const response = await fetch(`${base}/v1/afk`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ armed: mode === "on", until }),
    });
    if (!response.ok) {
      console.log(`afk: daemon error ${response.status}`);
      process.exitCode = 1;
      return;
    }
    const body = (await response.json()) as { afk: AfkState; active: boolean };
    printState(body.afk, body.active);
  } catch {
    console.log("afk: daemon not reachable");
    process.exitCode = 1;
  }
}

/**
 * `agentos stow <projectId> <notes...>` — record a durable note under the
 * project's `docs/notes/`, through the same tool surface the Brain uses, so the
 * containment check and the evidence log apply identically.
 */
export async function runStow(projectId?: string, notes?: string): Promise<void> {
  if (projectId === undefined || notes === undefined || notes.length === 0) {
    console.log("stow: usage — agentos stow <projectId> <notes>");
    process.exitCode = 2;
    return;
  }
  const base = `http://${LOOPBACK_HOST}:${cliPort()}`;
  try {
    const token = readToken(resolveHome());
    const response = await fetch(`${base}/v1/tools/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool: "stow_knowledge", input: { projectId, notes } }),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      data?: { path?: string };
      error?: { code?: string; message?: string };
    };
    if (!response.ok || body.ok !== true) {
      console.log(`stow: ${body.error?.code ?? "FAILED"} — ${body.error?.message ?? `HTTP ${response.status}`}`);
      process.exitCode = 1;
      return;
    }
    console.log(`stow: written ${body.data?.path ?? "(path unreported)"}`);
  } catch {
    console.log("stow: daemon not reachable");
    process.exitCode = 1;
  }
}

/** `agentos config doctor` — which prompt templates have drifted (§11 Phase 8). */
export async function runConfigDoctorCommand(): Promise<void> {
  const base = `http://${LOOPBACK_HOST}:${cliPort()}`;
  try {
    const token = readToken(resolveHome());
    const response = await fetch(`${base}/v1/config/doctor`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      console.log(`config doctor: daemon error ${response.status}`);
      process.exitCode = 1;
      return;
    }
    const body = (await response.json()) as { doctor: ConfigDoctorReport };
    for (const line of formatConfigDoctor(body.doctor)) console.log(line);
  } catch {
    console.log("config doctor: daemon not reachable");
    process.exitCode = 1;
  }
}

const USAGE = `agentos — Agent OS CLI

usage:
  agentos start       run the agentosd daemon in the foreground
  agentos status      report daemon health and event-store status
  agentos doctor      verify tmux/git/gh/node/pi/uv presence (warnings only)
  agentos config doctor
                      report prompt templates that have drifted from shipped
  agentos bearings    fleet snapshot (/v1/fleet)
  agentos afk [on [90m|8h|2d] | off | status]
                      autonomy posture — answers only recorded FAQ entries
  agentos stow <projectId> <notes>
                      record a durable note under the project's docs/notes/
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
      await runAfk(argv[1], argv[2]);
      return;
    case "stow":
      await runStow(argv[1], argv.slice(2).join(" "));
      return;
    case "config":
      if (argv[1] === "doctor") {
        await runConfigDoctorCommand();
        return;
      }
      console.error(`unknown config subcommand: ${argv[1] ?? "(none)"}\n\n${USAGE}`);
      process.exitCode = 2;
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
