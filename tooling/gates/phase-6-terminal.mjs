#!/usr/bin/env node
/**
 * Terminal frame continuity (master plan §11 Phase 6).
 *
 *   T1  a sustained stream is sequenced with NO gaps
 *   T2  a reconnect resumes the SAME pane and restarts its own numbering
 *
 * Split into its own file rather than appended to phase-6.mjs: this needs a
 * freshly spawned seat with a live pane, and by the end of a fourteen-gate run
 * the shared daemon's sessions have been stopped, delivered, or torn down by
 * earlier gates.
 *
 * Why sequence numbers at all: a pane that does not change sends nothing, so
 * "no frame arrived" is normal. Without a per-frame seq, a genuine drop is
 * indistinguishable from a quiet pane — which is exactly the ambiguity the
 * "no dropped frames" criterion has to rule out.
 *
 * Usage: node tooling/gates/phase-6-terminal.mjs
 *
 * Stream window for T1 defaults to 600_000 ms (the measured 10-minute soak).
 * Set AGENTOS_TERMINAL_SOAK_MS to a shorter value for local iteration; CI uses
 * the real duration so a product that only emits a brief initial capture fails.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickPort } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const TMUX_SOCKET = `agentos-p6t-${process.pid}`;
const PORT = pickPort(5800, 40);
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_SOAK_MS = 600_000;
const parsedSoak = Number(process.env.AGENTOS_TERMINAL_SOAK_MS);
const SOAK_MS =
  Number.isFinite(parsedSoak) && parsedSoak > 0 ? parsedSoak : DEFAULT_SOAK_MS;

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanups = [];
let daemon;
let exitCode = 1;

try {
  const home = mkdtempSync(join(tmpdir(), "agentos-p6t-home-"));
  const repo = mkdtempSync(join(tmpdir(), "agentos-p6t-repo-"));
  cleanups.push(home, repo);
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "p6t@agent-os.local");
  git("config", "user.name", "phase6-terminal");
  writeFileSync(join(repo, "README.md"), "# p6t\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  daemon = spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(PORT),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      AGENTOS_FAKE_GIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 30_000;
  let token = null;
  while (Date.now() < deadline && token === null) {
    try {
      const candidate = readFileSync(join(home, "daemon.token"), "utf8").trim();
      if ((await fetch(`${BASE}/v1/health`)).ok) token = candidate;
    } catch {
      // not up
    }
    if (token === null) await sleep(150);
  }
  if (token === null) throw new Error("daemon did not start");

  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) =>
    (await fetch(`${BASE}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) })).json();
  const tool = async (name, input) => {
    const res = await post("/v1/tools/call", { tool: name, input });
    if (res.ok !== true) throw new Error(`${name}: ${res.error?.code} ${res.error?.message}`);
    return res;
  };

  const projectId = (
    await post("/v1/projects", { name: "p6t", path: repo, mode: "local-only", trusted: true })
  ).project.id;
  const taskId = (
    await post("/v1/tasks", {
      spec: {
        shape: "SHIP",
        title: "terminal continuity fixture",
        intent: "hold a pane open for frame sequencing",
        projectId,
        mode: "local-only",
        yolo: true,
      },
    })
  ).task.id;
  await tool("resolve_cast", {
    taskId,
    roles: [{ role: "builder", model: "openai/gpt-5.6-sol", thinking: "medium", cleanRoom: true }],
    familyCheckOverride: false,
  });
  const spawned = await tool("spawn_crewmate", {
    taskId,
    role: "builder",
    model: "openai/gpt-5.6-sol",
    thinking: "medium",
    vars: {},
    redBaselineOverride: true,
  });
  const session = spawned.data.session;

  // Try to make the pane change so the stream produces MULTIPLE frames. The
  // fake-Pi seat runs `sleep`, so left alone it emits exactly one frame — the
  // initial capture — and that is correct behaviour, not a drop.
  //
  // respawn-pane needs to fork a process, which some sandboxed CI environments
  // refuse ("fork failed: Device not configured"). Whether it succeeds is
  // reported below rather than assumed, so a one-frame stream is never mistaken
  // for a sustained one that lost frames.
  const ticker = spawnSync(
    "tmux",
    [
      "-L",
      TMUX_SOCKET,
      "respawn-pane",
      "-k",
      "-t",
      session.tmuxWindow,
      "sh -c 'while true; do date +%s.%N; sleep 0.3; done'",
    ],
    { encoding: "utf8" },
  );
  const paneChanges = ticker.status === 0;
  await sleep(800);

  const { WebSocket } = await import("ws");
  const streamFor = async (ms) => {
    const ticket = await post(`/v1/sessions/${session.sessionId}/attach-ticket`, {});
    return await new Promise((resolve) => {
      const seqs = [];
      const targets = new Set();
      let sawContent = false;
      const startedAt = Date.now();
      let lastFrameAt = null;
      // The PTY server enforces a loopback Origin; without it the upgrade
      // succeeds and the socket is closed immediately.
      const ws = new WebSocket(ticket.wsUrl, { origin: "http://127.0.0.1" });
      const done = () => {
        try {
          ws.close();
        } catch {
          // already closing
        }
        resolve({ seqs, sawContent, targets, startedAt, lastFrameAt, windowMs: ms });
      };
      ws.on("message", (raw) => {
        try {
          const frame = JSON.parse(String(raw));
          if (frame.type === "pane" && typeof frame.seq === "number") {
            seqs.push(frame.seq);
            lastFrameAt = Date.now();
            if (typeof frame.content === "string" && frame.content.length > 0) sawContent = true;
            if (typeof frame.target === "string" && frame.target.length > 0) targets.add(frame.target);
          }
        } catch {
          // ignore malformed
        }
      });
      ws.on("error", done);
      setTimeout(done, ms);
    });
  };

  const contiguous = (seqs) =>
    seqs.length > 1 && seqs.every((value, index) => value === seqs[0] + index);

  // Server poll interval (apps/orchestrator/src/pty/server.ts). Theoretical max
  // frames when every tick sees a change is windowMs / POLL_MS. Require a high
  // fraction so an early burst cannot green a long soak, with modest slack for
  // capture lag and scheduler jitter.
  const POLL_MS = 500;
  const FLOOR_FRACTION = 0.9;
  const END_ARRIVAL_FRACTION = 0.1;
  const theoreticalMax = (windowMs) => Math.floor(windowMs / POLL_MS);
  const minFramesFor = (windowMs) =>
    Math.max(2, Math.floor(theoreticalMax(windowMs) * FLOOR_FRACTION));

  const arrivedNearEnd = (startedAt, lastFrameAt, windowMs) => {
    if (typeof lastFrameAt !== "number") return false;
    const endAt = startedAt + windowMs;
    const tailMs = Math.max(POLL_MS * 2, Math.floor(windowMs * END_ARRIVAL_FRACTION));
    return lastFrameAt >= endAt - tailMs;
  };

  // T1 is the soak claim: multi-frame contiguity for the full window. When the
  // environment cannot fork a ticking pane, FAIL (do not green) so a pass always
  // means sustained emission was actually exercised.
  const soakOk = (stream) => {
    if (!paneChanges) return false;
    const floor = minFramesFor(stream.windowMs);
    return (
      stream.seqs.length >= floor &&
      stream.seqs[0] === 1 &&
      stream.sawContent &&
      contiguous(stream.seqs) &&
      arrivedNearEnd(stream.startedAt, stream.lastFrameAt, stream.windowMs)
    );
  };

  // T2 proves a reconnect resumes THE SAME PANE and restarts its own numbering
  // at 1.
  //
  // An earlier revision reduced this to `seqs.length >= 2`, on the reasoning
  // that a short reconnect window is too noisy to carry a floor. That is the
  // defect T1's 90% floor exists to prevent, one gate along: a reconnect that
  // delivered two frames and died would have passed. The honest fix is to
  // LENGTHEN THE WINDOW so a floor is affordable, not to drop the floor —
  // hence RECONNECT_MS below is 12s rather than 4s.
  //
  // The floor fraction is gentler than T1's because a reattach genuinely loses
  // time to the ticket round trip and the first capture, which a steady-state
  // soak does not pay.
  const RECONNECT_FLOOR_FRACTION = 0.6;
  const minReconnectFrames = (windowMs) =>
    Math.max(3, Math.floor(theoreticalMax(windowMs) * RECONNECT_FLOOR_FRACTION));

  const reconnectOk = (stream, firstTargets) => {
    const { seqs, sawContent, targets } = stream;
    if (!(seqs.length >= 1 && seqs[0] === 1 && sawContent)) return false;
    // Pane identity, measured rather than inferred. Every frame now carries the
    // tmux target it was captured from, so "same pane" is a comparison against
    // the first stream instead of a restatement of "we saw some content".
    const samePane =
      targets.size === 1 &&
      firstTargets.size === 1 &&
      [...targets][0] === [...firstTargets][0];
    if (!samePane) return false;
    if (!paneChanges) return seqs.length === 1 || contiguous(seqs);
    return contiguous(seqs) && seqs.length >= minReconnectFrames(stream.windowMs);
  };

  // When the ticker could not start, T1 cannot pass — fail fast with a short
  // diagnostic sample instead of burning the full soak window. T2 still runs
  // its short reconnect check afterward (renumbering needs no soak).
  // Long enough that a proportional floor is meaningful (see reconnectOk).
  const reconnectMs = Math.min(12_000, SOAK_MS);
  const t1WindowMs = paneChanges ? SOAK_MS : reconnectMs;
  const first = await streamFor(t1WindowMs);
  const firstFloor = minFramesFor(SOAK_MS);
  const firstNearEnd = arrivedNearEnd(first.startedAt, first.lastFrameAt, t1WindowMs);
  const firstContiguous = contiguous(first.seqs);
  gate(
    "T1",
    "sustained multi-frame soak: sequenced from 1, contiguous, floor met, frames still arriving near end",
    soakOk(first),
    !paneChanges
      ? `FAIL: pane ticker did not start (tmux respawn-pane could not fork) — soak criterion not exercised; frames=${first.seqs.length} sampleMs=${t1WindowMs} (full soak skipped)`
      : `frames=${first.seqs.length} seq[${first.seqs[0]}..${first.seqs.at(-1)}] contiguous=${firstContiguous} content=${first.sawContent} paneTickerStarted=${paneChanges} soakMs=${SOAK_MS} minFrames=${firstFloor} (floor=${FLOOR_FRACTION} of theoretical ${theoreticalMax(SOAK_MS)} at ${POLL_MS}ms poll) lastFrameNearEnd=${firstNearEnd}`,
  );

  const second = await streamFor(reconnectMs);
  const secondContiguous =
    paneChanges ? contiguous(second.seqs) : second.seqs.length === 1 ? "n/a" : contiguous(second.seqs);
  const firstTarget = first.targets.size === 1 ? [...first.targets][0] : null;
  const secondTarget = second.targets.size === 1 ? [...second.targets][0] : null;
  const samePane = firstTarget !== null && firstTarget === secondTarget;
  gate(
    "T2",
    "a reconnect resumes the same pane and restarts its own numbering at 1",
    reconnectOk(second, first.targets),
    `frames=${second.seqs.length} restartedAt=${second.seqs[0]} contiguous=${secondContiguous} ` +
      `samePane=${samePane} target=${secondTarget ?? "none"} firstTarget=${firstTarget ?? "none"} ` +
      `minFrames=${minReconnectFrames(reconnectMs)} (floor=${RECONNECT_FLOOR_FRACTION} of theoretical ` +
      `${theoreticalMax(reconnectMs)} at ${POLL_MS}ms poll) windowMs=${reconnectMs}`,
  );

  if (!paneChanges) {
    console.log(
      "\nNOTE: this environment refused to start a ticking pane (tmux respawn-pane could not fork).",
    );
    console.log(
      "T1 FAILS by design — the 10-minute soak claim requires a live ticker so a green run never",
    );
    console.log(
      "implies multi-frame sustained emission that was not exercised. T2 may still prove renumbering.",
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  try {
    daemon?.kill("SIGTERM");
  } catch {
    // ignore
  }
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const path of cleanups) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

process.exit(exitCode);
