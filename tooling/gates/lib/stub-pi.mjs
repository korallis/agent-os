#!/usr/bin/env node
/**
 * Recording stand-in for the Pi binary, used by `tooling/gates/phase-4.mjs` G2.
 *
 * The clean-room claim is about the bytes each fusion side is actually launched
 * with, so the gate has to observe a real spawn — the fake-Pi path never reads
 * `input.prompt` at all, which is exactly why a hash recorded from a single
 * variable could stand in for proof.
 *
 * On `--version` it answers like a Pi so daemon detection succeeds. Otherwise
 * it writes its full argv (including the `-p <prompt>` bytes and the clean-room
 * flags) next to itself, keyed by AGENTOS_SESSION_ID, then stays alive so the
 * daemon's pane-liveness reconcile does not mark the seat lost mid-assertion.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("0.0.0-agentos-gate-stub\n");
} else {
  const promptIndex = argv.indexOf("-p");
  const sessionId = process.env.AGENTOS_SESSION_ID ?? "unknown";
  writeFileSync(
    join(here, `capture-${sessionId}.json`),
    JSON.stringify({
      sessionId,
      role: process.env.AGENTOS_ROLE ?? null,
      argv,
      prompt: promptIndex === -1 ? null : (argv[promptIndex + 1] ?? null),
    }),
    { mode: 0o600 },
  );
  // Hold the pane open; the gate kills the tmux server during cleanup.
  setInterval(() => {}, 60_000);
}
