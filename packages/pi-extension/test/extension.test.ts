import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentOsExtensionHost } from "../src/extension.js";
import { extensionToDaemonFrameSchema } from "@agent-os/protocol";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  dirs.length = 0;
});

describe("agent-os extension socket frames", () => {
  it("emits ext.hello + ext.usage over the Unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-"));
    dirs.push(dir);
    const socketPath = join(dir, "hub.sock");
    const frames: unknown[] = [];

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.length === 0) continue;
            frames.push(JSON.parse(line));
            if (frames.length >= 2) {
              server.close();
              resolve();
            }
          }
        });
      });
      server.on("error", reject);
      server.listen(socketPath, () => {
        const host = new AgentOsExtensionHost({
          socketPath,
          sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          role: "builder",
          piVersion: "0.82.0",
        });
        void host.connect().then(() => {
          host.usage({
            provider: "anthropic",
            model: "claude-opus-4-5",
            inputTokens: 10,
            outputTokens: 20,
            costUsd: 0.01,
            contextUsedPct: 12,
          });
        });
      });
    });

    const hello = extensionToDaemonFrameSchema.parse(frames[0]);
    expect(hello.type).toBe("ext.hello");
    const usage = extensionToDaemonFrameSchema.parse(frames[1]);
    expect(usage.type).toBe("ext.usage");
    if (usage.type === "ext.usage") {
      expect(usage.inputTokens).toBe(10);
      expect(usage.costUsd).toBe(0.01);
    }
  });
});
