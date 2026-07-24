import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore, readLog } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const WRITER = join(here, "fixtures", "writer.mjs");

/**
 * §11 Phase 1 gate: "Kill/restart after 100 events → exactly-once projection
 * + SSE resume; corrupt tail quarantined."
 *
 * A child process appends events in a tight loop; we SIGKILL it mid-stream
 * (the moral equivalent of `kill -9 agentosd`), then reopen the store and
 * assert the projection reconciles exactly with the surviving log.
 */
describe("kill -9 recovery", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agentos-kill9-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("recovers a consistent projection after SIGKILL mid-stream", { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, [WRITER, home, "100000"], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    // Wait until the writer has demonstrably appended >100 events, then SIGKILL.
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const lines = output.trim().split("\n");
        const last = Number(lines.at(-1));
        if (Number.isFinite(last) && last >= 120) {
          child.kill("SIGKILL");
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", () => resolve());
    });
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    expect(child.killed).toBe(true);

    // Restart: the store must reconcile without help.
    const reopened = EventStore.open(home);
    const logPath = join(home, "events", "events.ndjson");
    const log = readLog(logPath);

    // The surviving log is clean (any partial tail has been quarantined).
    expect(log.corruptTailOffset).toBeNull();
    expect(log.envelopes.length).toBeGreaterThan(100);

    // Projection == log, exactly once: same count, same last seq, monotonic.
    expect(reopened.store.count()).toBe(log.envelopes.length);
    expect(reopened.store.lastSeq()).toBe(log.envelopes.at(-1)?.seq);
    const seqs = log.envelopes.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));

    // The restarted daemon continues appending with no duplicate seq.
    const next = reopened.store.append({
      type: "daemon.started",
      payload: { version: "test", pid: process.pid, home, port: 4700 },
    });
    expect(next.seq).toBe(log.envelopes.length + 1);

    // A second restart replays nothing (projection already reconciled).
    reopened.store.close();
    const again = EventStore.open(home);
    expect(again.replayed).toBe(0);
    expect(again.store.count()).toBe(log.envelopes.length + 1);
    again.store.close();

    // Sanity: the log file's bytes end with a complete line.
    expect(readFileSync(logPath, "utf8").endsWith("\n")).toBe(true);
  });
});
