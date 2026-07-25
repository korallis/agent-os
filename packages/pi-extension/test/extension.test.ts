import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import agentOsPiExtension, {
  AgentOsExtensionHost,
  extractAssistantText,
  usageFromAssistantMessage,
  type PiExtensionApi,
} from "../src/extension.js";
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
  delete process.env.AGENTOS_SOCKET;
  delete process.env.AGENTOS_SESSION_ID;
  delete process.env.AGENTOS_ROLE;
  delete process.env.AGENTOS_SESSION_DIR;
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

describe("assistant output capture", () => {
  it("extracts text blocks and usage from a finalized assistant message", () => {
    const message = {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Ship it." },
        { type: "text", text: " With tests." },
      ],
      usage: {
        input: 12,
        output: 4,
        cost: { total: 0.02 },
      },
    };
    expect(extractAssistantText(message)).toBe("Ship it. With tests.");
    expect(usageFromAssistantMessage(message)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 12,
      outputTokens: 4,
      costUsd: 0.02,
      contextUsedPct: null,
    });
    expect(extractAssistantText({ role: "user", content: "hi" })).toBe("");
    expect(usageFromAssistantMessage({ role: "user" })).toBeNull();
  });

  it("writes output.md and emits usage from message_end on settle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-out-"));
    dirs.push(dir);
    const socketPath = join(dir, "hub.sock");
    const sessionDir = join(dir, "session");
    const frames: unknown[] = [];

    process.env.AGENTOS_SOCKET = socketPath;
    process.env.AGENTOS_SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    process.env.AGENTOS_ROLE = "planner";
    process.env.AGENTOS_SESSION_DIR = sessionDir;

    const handlers = new Map<string, (...args: unknown[]) => void>();
    const pi: PiExtensionApi = {
      version: "0.82.0",
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    };

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
          }
        });
      });
      server.on("error", reject);
      server.listen(socketPath, () => {
        const host = agentOsPiExtension(pi);
        expect(host).toBeDefined();
        void host!.connect().then(() => {
          handlers.get("message_end")?.({
            message: {
              role: "assistant",
              provider: "openai",
              model: "gpt-5.6-sol",
              content: [{ type: "text", text: "real side answer" }],
              usage: {
                input: 100,
                output: 25,
                cost: { total: 0.4 },
              },
            },
          });
          handlers.get("agent_settled")?.();
          setTimeout(() => {
            server.close();
            resolve();
          }, 50);
        });
      });
    });

    expect(existsSync(join(sessionDir, "output.md"))).toBe(true);
    expect(readFileSync(join(sessionDir, "output.md"), "utf8")).toBe("real side answer");

    const types = frames.map((f) => (f as { type: string }).type);
    expect(types).toContain("ext.hello");
    expect(types).toContain("ext.usage");
    expect(types).toContain("ext.lifecycle");
    const usage = frames.find((f) => (f as { type: string }).type === "ext.usage") as {
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      model: string;
    };
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(25);
    expect(usage.costUsd).toBe(0.4);
    expect(usage.model).toBe("gpt-5.6-sol");
  });
});
