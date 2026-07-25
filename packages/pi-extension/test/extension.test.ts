import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import agentOsPiExtension, {
  AgentOsExtensionHost,
  extractAssistantText,
  gateWorkspaceBlockReason,
  validatorJailBlockReason,
  pathIsInsideGate,
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
  delete process.env.AGENTOS_GATE_WORKSPACE;
  delete process.env.AGENTOS_HOME;
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

  it("writes per-session outputs/<sessionId>.md and emits usage on settle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-out-"));
    dirs.push(dir);
    const socketPath = join(dir, "hub.sock");
    const sessionDir = join(dir, "session");
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const frames: unknown[] = [];

    process.env.AGENTOS_SOCKET = socketPath;
    process.env.AGENTOS_SESSION_ID = sessionId;
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

    const outPath = join(sessionDir, "outputs", `${sessionId}.md`);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, "utf8")).toBe("real side answer");
    expect(existsSync(join(sessionDir, "output.md"))).toBe(false);

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

  it("skips writing an output file when the assistant produced no text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-empty-"));
    dirs.push(dir);
    const socketPath = join(dir, "hub.sock");
    const sessionDir = join(dir, "session");
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

    process.env.AGENTOS_SOCKET = socketPath;
    process.env.AGENTOS_SESSION_ID = sessionId;
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
      const server = createServer();
      server.on("error", reject);
      server.listen(socketPath, () => {
        const host = agentOsPiExtension(pi);
        expect(host).toBeDefined();
        void host!.connect().then(() => {
          handlers.get("agent_settled")?.();
          setTimeout(() => {
            server.close();
            resolve();
          }, 50);
        });
      });
    });

    expect(existsSync(join(sessionDir, "outputs", `${sessionId}.md`))).toBe(false);
    expect(existsSync(join(sessionDir, "output.md"))).toBe(false);
  });
});

describe("clean-room model-visible tool surface", () => {
  it("registers no agent-os tools for a clean-room planner (opinion side)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-crew-tools-"));
    dirs.push(dir);
    process.env.AGENTOS_SOCKET = join(dir, "hub.sock");
    process.env.AGENTOS_SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC0";
    process.env.AGENTOS_ROLE = "planner";

    const registered: string[] = [];
    const pi: PiExtensionApi = {
      version: "0.82.0",
      registerTool: (definition) => {
        registered.push(definition.name);
      },
    };

    const host = agentOsPiExtension(pi);
    expect(host).toBeDefined();
    host?.close();
    expect(registered).toEqual([]);
  });

  it("registers the Brain tool bridge only when AGENTOS_ROLE=brain", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-brain-tools-"));
    dirs.push(dir);
    process.env.AGENTOS_SOCKET = join(dir, "hub.sock");
    process.env.AGENTOS_SESSION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FD0";
    process.env.AGENTOS_ROLE = "brain";

    const registered: string[] = [];
    const pi: PiExtensionApi = {
      version: "0.82.0",
      registerTool: (definition) => {
        registered.push(definition.name);
      },
    };

    const host = agentOsPiExtension(pi);
    expect(host).toBeDefined();
    host?.close();
    expect(registered).toContain("dispatch_fusion");
    expect(registered).toContain("spawn_crewmate");
    expect(registered).toContain("read_run_artifacts");
    expect(registered).toContain("agent_os_ask");
    expect(registered.length).toBeGreaterThan(10);
  });
});

describe("builder gate-workspace tool fence", () => {
  it("pathIsInsideGate resolves and rejects ../ escape", () => {
    const gate = "/tmp/agentos-gate-ws";
    const cwd = "/tmp/builder-tree";
    expect(pathIsInsideGate(`${gate}/gate.py`, gate, cwd)).toBe(true);
    expect(pathIsInsideGate("/tmp/builder-tree/src/a.ts", gate, cwd)).toBe(false);
    expect(pathIsInsideGate("../agentos-gate-ws/secret", gate, cwd)).toBe(true);
    expect(pathIsInsideGate("../../etc/passwd", gate, cwd)).toBe(false);
  });

  it("gateWorkspaceBlockReason blocks read/write into the gate dir", () => {
    const gate = "/tmp/agentos-gate-ws";
    const cwd = "/tmp/builder-tree";
    const blocked = gateWorkspaceBlockReason(
      "read",
      { path: `${gate}/gate.py` },
      gate,
      cwd,
    );
    expect(blocked).toMatch(/tool\/fs-blocked/);
    expect(
      gateWorkspaceBlockReason("write", { path: `${cwd}/ok.ts` }, gate, cwd),
    ).toBeNull();
  });

  it("blocks bash relative, ~, and $HOME paths that resolve into the gate tree", () => {
    const home = "/Users/captain";
    const gate = `${home}/.agentos/runs/task1/gate-workspace`;
    const cwd = `${home}/.agentos/worktrees/builder-1`;
    expect(
      gateWorkspaceBlockReason(
        "bash",
        { command: `cat ${gate}/gate.py` },
        gate,
        cwd,
        home,
      ),
    ).toMatch(/tool\/fs-blocked/);
    expect(
      gateWorkspaceBlockReason(
        "bash",
        { command: "cat ~/.agentos/runs/task1/gate-workspace/gate.py" },
        gate,
        cwd,
        home,
      ),
    ).toMatch(/tool\/fs-blocked/);
    expect(
      gateWorkspaceBlockReason(
        "bash",
        { command: "cat $HOME/.agentos/runs/task1/gate-workspace/gate.py" },
        gate,
        cwd,
        home,
      ),
    ).toMatch(/tool\/fs-blocked/);
    expect(
      gateWorkspaceBlockReason(
        "bash",
        { command: "cat ../../runs/task1/gate-workspace/secret" },
        gate,
        cwd,
        home,
      ),
    ).toMatch(/tool\/fs-blocked/);
    expect(
      gateWorkspaceBlockReason(
        "bash",
        { command: "echo hello > ./src/ok.ts" },
        gate,
        cwd,
        home,
      ),
    ).toBeNull();
  });

  it("blocks builder tool_call into gate workspace and emits ext.tool_blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-gate-fence-"));
    dirs.push(dir);
    const gateDir = join(dir, "gate-workspace");
    const socketPath = join(dir, "hub.sock");
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FE0";
    process.env.AGENTOS_SOCKET = socketPath;
    process.env.AGENTOS_SESSION_ID = sessionId;
    process.env.AGENTOS_ROLE = "builder";
    process.env.AGENTOS_GATE_WORKSPACE = gateDir;

    const frames: unknown[] = [];
    let toolCallHandler: ((...args: unknown[]) => unknown) | undefined;

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
            if (frames.some((f) => (f as { type?: string }).type === "ext.tool_blocked")) {
              server.close();
              resolve();
            }
          }
        });
      });
      server.on("error", reject);
      server.listen(socketPath, () => {
        const pi: PiExtensionApi = {
          version: "0.82.0",
          on: (event, handler) => {
            if (event === "tool_call") toolCallHandler = handler;
          },
        };
        const host = agentOsPiExtension(pi);
        expect(host).toBeDefined();
        expect(toolCallHandler).toBeTypeOf("function");
        void host!.connect().then(() => {
          const result = toolCallHandler?.({
            toolName: "read",
            toolCallId: "tc1",
            input: { path: join(gateDir, "gate.py") },
          }) as { block?: boolean; reason?: string } | undefined;
          expect(result?.block).toBe(true);
          expect(result?.reason ?? "").toMatch(/tool\/fs-blocked/);
          setTimeout(() => {
            if (!frames.some((f) => (f as { type?: string }).type === "ext.tool_blocked")) {
              host?.close();
              server.close();
              reject(new Error("ext.tool_blocked not received"));
            }
          }, 2000);
        });
      });
    });

    const blocked = frames.find(
      (f) => (f as { type?: string }).type === "ext.tool_blocked",
    );
    const parsed = extensionToDaemonFrameSchema.parse(blocked);
    expect(parsed.type).toBe("ext.tool_blocked");
    if (parsed.type === "ext.tool_blocked") {
      expect(parsed.toolName).toBe("read");
      expect(parsed.reason).toMatch(/gate workspace/);
    }
  });

  it("fails closed on fence errors (block: true, never undefined)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-fence-fail-"));
    dirs.push(dir);
    const gateDir = join(dir, "gate-workspace");
    const socketPath = join(dir, "hub.sock");
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FE1";
    process.env.AGENTOS_SOCKET = socketPath;
    process.env.AGENTOS_SESSION_ID = sessionId;
    process.env.AGENTOS_ROLE = "builder";
    process.env.AGENTOS_GATE_WORKSPACE = gateDir;

    let toolCallHandler: ((...args: unknown[]) => unknown) | undefined;
    await new Promise<void>((resolve, reject) => {
      const server = createServer(() => {
        // accept connection; no need to parse frames for this assertion
      });
      server.on("error", reject);
      server.listen(socketPath, () => {
        const pi: PiExtensionApi = {
          version: "0.82.0",
          on: (event, handler) => {
            if (event === "tool_call") toolCallHandler = handler;
          },
        };
        const host = agentOsPiExtension(pi);
        expect(host).toBeDefined();
        void host!.connect().then(() => {
          // Proxy input that throws when enumerated paths are read — forces catch.
          const hostile = new Proxy(
            {},
            {
              get() {
                throw new Error("boom");
              },
              ownKeys() {
                throw new Error("boom");
              },
              getOwnPropertyDescriptor() {
                throw new Error("boom");
              },
            },
          );
          const result = toolCallHandler?.({
            toolName: "bash",
            toolCallId: "tc-fail",
            input: hostile,
          }) as { block?: boolean; reason?: string } | undefined;
          expect(result).toBeDefined();
          expect(result?.block).toBe(true);
          expect(result?.reason ?? "").toMatch(/fence/i);
          host?.close();
          server.close();
          resolve();
        });
      });
    });
  });
});

describe("validator write-jail tool fence", () => {
  it("validatorJailBlockReason allows gate workspace and denies sibling validation/", () => {
    const agentHome = "/Users/captain/.agentos";
    const gate = `${agentHome}/runs/task1/gate-workspace`;
    const cwd = gate;
    expect(
      validatorJailBlockReason(
        "write",
        { path: `${gate}/gate.py` },
        gate,
        agentHome,
        cwd,
      ),
    ).toBeNull();
    expect(
      validatorJailBlockReason(
        "write",
        { path: `${agentHome}/runs/task1/validation/red-proof.json` },
        gate,
        agentHome,
        cwd,
      ),
    ).toMatch(/write-jailed/);
    expect(
      validatorJailBlockReason(
        "bash",
        { command: "cat ../validation/red-proof.json" },
        gate,
        agentHome,
        cwd,
      ),
    ).toMatch(/write-jailed/);
    expect(
      validatorJailBlockReason(
        "read",
        { path: "/tmp/outside.txt" },
        gate,
        agentHome,
        cwd,
      ),
    ).toBeNull();
  });

  it("blocks validator tool_call into validation/ and emits ext.tool_blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentos-ext-val-jail-"));
    dirs.push(dir);
    const gateDir = join(dir, "runs", "task", "gate-workspace");
    const socketPath = join(dir, "hub.sock");
    const sessionId = "01ARZ3NDEKTSV4RRFFQ69G5FE2";
    process.env.AGENTOS_SOCKET = socketPath;
    process.env.AGENTOS_SESSION_ID = sessionId;
    process.env.AGENTOS_ROLE = "validator";
    process.env.AGENTOS_GATE_WORKSPACE = gateDir;
    process.env.AGENTOS_HOME = dir;

    const frames: unknown[] = [];
    let toolCallHandler: ((...args: unknown[]) => unknown) | undefined;

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
            if (frames.some((f) => (f as { type?: string }).type === "ext.tool_blocked")) {
              server.close();
              resolve();
            }
          }
        });
      });
      server.on("error", reject);
      server.listen(socketPath, () => {
        const pi: PiExtensionApi = {
          version: "0.82.0",
          on: (event, handler) => {
            if (event === "tool_call") toolCallHandler = handler;
          },
        };
        const host = agentOsPiExtension(pi);
        expect(host).toBeDefined();
        expect(toolCallHandler).toBeTypeOf("function");
        void host!.connect().then(() => {
          const result = toolCallHandler?.({
            toolName: "write",
            toolCallId: "tc-val",
            input: { path: join(dir, "runs", "task", "validation", "red-proof.json") },
          }) as { block?: boolean; reason?: string } | undefined;
          expect(result?.block).toBe(true);
          expect(result?.reason ?? "").toMatch(/write-jailed/);
          setTimeout(() => {
            if (!frames.some((f) => (f as { type?: string }).type === "ext.tool_blocked")) {
              host?.close();
              server.close();
              reject(new Error("ext.tool_blocked not received"));
            }
          }, 2000);
        });
      });
    });

    const blocked = frames.find(
      (f) => (f as { type?: string }).type === "ext.tool_blocked",
    );
    const parsed = extensionToDaemonFrameSchema.parse(blocked);
    expect(parsed.type).toBe("ext.tool_blocked");
  });
});
