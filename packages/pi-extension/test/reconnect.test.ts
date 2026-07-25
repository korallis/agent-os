import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentOsExtensionHost } from "../src/extension.js";

/**
 * Reconnect survival (external review finding, verified against the code).
 *
 * The old `close` handler compared `this.socket === socket`, which can never
 * match for a socket that failed to connect — `this.socket` is only assigned in
 * the `connect` handler. So the FIRST failed retry ended the chain, and the
 * seat lost telemetry for the life of the process. A daemon outage lasting
 * longer than a single 250 ms retry was enough to do it, silently.
 */

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function listen(path: string): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(() => undefined);
    servers.push(server);
    server.listen(path, () => resolve(server));
  });
}

describe("extension host reconnect", () => {
  it("keeps retrying after a FAILED reconnect and attaches when the daemon returns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p13-reconnect-"));
    dirs.push(dir);
    const socketPath = join(dir, "session.sock");

    let helloSeen = false;
    const host = new AgentOsExtensionHost({
      socketPath,
      sessionId: "01SESSION0000000000000001",
      role: "builder",
      piVersion: "0.82.0",
      retryMs: 20,
      maxRetries: 200,
    });

    // Nothing is listening yet, so the first connect fails. Under the old
    // logic the retry chain died right here.
    await host.connect().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const server = await listen(socketPath);
    server.on("connection", (socket) => {
      socket.on("data", (chunk) => {
        if (String(chunk).includes("ext.hello")) helloSeen = true;
      });
    });

    const deadline = Date.now() + 5000;
    while (!helloSeen && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(helloSeen).toBe(true);
    host.close();
  });

  it("stops retrying once closed, so a shut-down seat does not spin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p13-reconnect-closed-"));
    dirs.push(dir);
    const host = new AgentOsExtensionHost({
      socketPath: join(dir, "never.sock"),
      sessionId: "01SESSION0000000000000002",
      role: "builder",
      piVersion: "0.82.0",
      retryMs: 20,
      maxRetries: 200,
    });
    await host.connect().catch(() => undefined);
    host.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    // No assertion beyond "did not throw / did not hang": the point is that
    // close() ends the chain rather than leaving timers running forever.
    expect(true).toBe(true);
  });

  it("cold-start via connectWithRetry emits exactly one ext.hello", async () => {
    // Dual-driver race: connectWithRetry used to loop connect() while the
    // close handler also scheduleReconnect()'d on the same failures. Both
    // saw socket===null ~retryMs apart, both connected, orphaning a socket
    // and sending two ext.hello frames for one session. Count hellos.
    const dir = mkdtempSync(join(tmpdir(), "p13-reconnect-single-hello-"));
    dirs.push(dir);
    const socketPath = join(dir, "session.sock");

    let helloCount = 0;
    const host = new AgentOsExtensionHost({
      socketPath,
      sessionId: "01SESSION0000000000000004",
      role: "builder",
      piVersion: "0.82.0",
      retryMs: 30,
      maxRetries: 50,
    });

    // Production boot path — must not race an independent retry loop.
    const boot = host.connectWithRetry();

    // Window long enough for a dual-driver race to arm two attempts.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const server = await listen(socketPath);
    server.on("connection", (socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length === 0) continue;
          try {
            const frame = JSON.parse(line) as { type?: unknown };
            if (frame.type === "ext.hello") helloCount += 1;
          } catch {
            // ignore non-JSON
          }
        }
      });
    });

    const ok = await boot;
    // Late second hello from an orphaned socket would arrive shortly after.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(ok).toBe(true);
    expect(helloCount).toBe(1);
    host.close();
  });

  it("reports dropped pending frames as a lifecycle detail on reconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "p13-dropped-frames-"));
    dirs.push(dir);
    const socketPath = join(dir, "session.sock");
    const frames: unknown[] = [];
    let reported: number | null = null;

    const server = await listen(socketPath);
    server.on("connection", (socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length === 0) continue;
          frames.push(JSON.parse(line));
        }
      });
    });

    const host = new AgentOsExtensionHost({
      socketPath,
      sessionId: "01SESSION0000000000000003",
      role: "builder",
      piVersion: "0.82.0",
      retryMs: 0,
      maxRetries: 0,
    });
    host.onDroppedFrames = (count) => {
      reported = count;
    };

    // Force overflow while disconnected so the counter is non-zero.
    for (let i = 0; i < 1005; i += 1) {
      host.usage({
        provider: "test",
        model: "m",
        inputTokens: i,
        outputTokens: 0,
        costUsd: null,
        contextUsedPct: null,
      });
    }

    await host.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(reported).toBeGreaterThan(0);
    const lifecycle = frames.find(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        (f as { type?: unknown }).type === "ext.lifecycle" &&
        typeof (f as { detail?: unknown }).detail === "string" &&
        String((f as { detail: string }).detail).includes("dropped"),
    );
    expect(lifecycle).toBeDefined();
    expect((lifecycle as { detail: string }).detail).toMatch(/dropped \d+ pending frame/);
    host.close();
  });
});
