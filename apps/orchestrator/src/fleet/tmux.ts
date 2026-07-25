import { spawn, spawnSync } from "node:child_process";

/**
 * Typed tmux wrapper (master plan §5.5).
 * Socket name is always `-L agentos` (or a test override).
 * Pi processes are children of tmux, not the daemon.
 */

export interface TmuxOptions {
  socketName?: string;
  /** When true, skip real tmux and record virtual windows. */
  fake?: boolean;
}

export interface TmuxWindow {
  session: string;
  window: string;
  target: string;
}

export class TmuxError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

/** Quote a single argv token for the `sh -c` line tmux runs. */
export function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a command line that starts from an *empty* environment and sets only
 * the allowlisted pairs. `tmux new-window` inherits the daemon's environment
 * otherwise, which would silently defeat `scrubEnv` and leak provider keys into
 * every crewmate.
 */
export function envPrefixedCommand(argv: string[], env?: Record<string, string>): string {
  const command = argv.map(shellQuote).join(" ");
  if (env === undefined) return command;
  const assignments = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${shellQuote(value)}`);
  return ["env", "-i", ...assignments, command].join(" ");
}

export class TmuxController {
  /** Exposed so the PTY reader targets the same tmux server the fleet uses. */
  readonly socketName: string;
  private readonly fake: boolean;
  private readonly fakeWindows = new Map<string, { session: string; window: string; cmd: string }>();
  /** Optional virtual pane text for fake-mode capture-pane. */
  private readonly fakePanes = new Map<string, string>();

  constructor(options: TmuxOptions = {}) {
    this.socketName =
      options.socketName ?? process.env.AGENTOS_TMUX_SOCKET ?? "agentos";
    this.fake = options.fake === true || process.env.AGENTOS_FAKE_TMUX === "1";
  }

  get isFake(): boolean {
    return this.fake;
  }

  private args(extra: string[]): string[] {
    return ["-L", this.socketName, ...extra];
  }

  private run(extra: string[]): { status: number; stdout: string; stderr: string } {
    if (this.fake) {
      return { status: 0, stdout: "", stderr: "" };
    }
    const result = spawnSync("tmux", this.args(extra), {
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  ensureSession(session = "agentos"): void {
    if (this.fake) return;
    const has = this.run(["has-session", "-t", session]);
    if (has.status === 0) return;
    const created = this.run(["new-session", "-d", "-s", session, "-n", "keeper"]);
    if (created.status !== 0) {
      throw new TmuxError("failed to create tmux session", created.stderr);
    }
  }

  /**
   * Create a new window running `argv`. When `env` is supplied the process
   * starts from an empty environment holding exactly those pairs — this is how
   * the scrubbed spawn env actually reaches Pi.
   */
  newWindow(input: {
    session?: string;
    windowName: string;
    argv: string[];
    env?: Record<string, string>;
    cwd?: string;
  }): TmuxWindow {
    const session = input.session ?? "agentos";
    const command = envPrefixedCommand(input.argv, input.env);
    this.ensureSession(session);
    if (this.fake) {
      const key = `${session}:${input.windowName}`;
      this.fakeWindows.set(key, {
        session,
        window: input.windowName,
        cmd: command,
      });
      return { session, window: input.windowName, target: key };
    }

    const extra: string[] = [
      "new-window",
      "-d",
      "-t",
      session,
      "-n",
      input.windowName,
    ];
    if (input.cwd !== undefined) {
      extra.push("-c", input.cwd);
    }
    extra.push(command);
    const result = this.run(extra);
    if (result.status !== 0) {
      throw new TmuxError(`failed to create window ${input.windowName}`, result.stderr);
    }
    return {
      session,
      window: input.windowName,
      target: `${session}:${input.windowName}`,
    };
  }

  killWindow(target: string): void {
    if (this.fake) {
      this.fakeWindows.delete(target);
      this.fakePanes.delete(target);
      return;
    }
    this.run(["kill-window", "-t", target]);
  }

  /** Returns false when the window is gone (pane-died fallback). */
  hasWindow(target: string): boolean {
    if (this.fake) return this.fakeWindows.has(target);
    const result = this.run(["list-windows", "-a", "-F", "#{session_name}:#{window_name}"]);
    if (result.status !== 0) return false;
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .includes(target);
  }

  /**
   * Read pane contents without blocking the event loop.
   * Returns null when the window is missing or capture fails (PTY liveness signal).
   */
  capturePane(target: string, maxLines = 400): Promise<string | null> {
    if (this.fake) {
      if (!this.fakeWindows.has(target)) return Promise.resolve(null);
      return Promise.resolve(this.fakePanes.get(target) ?? "");
    }
    return new Promise((resolve) => {
      const child = spawn(
        "tmux",
        this.args([
          "capture-pane",
          "-p",
          "-t",
          target,
          "-S",
          `-${maxLines}`,
        ]),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, 5_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => {
        finish(code === 0 ? stdout : null);
      });
    });
  }

  /** Test helper: set virtual pane text for fake-mode capture. */
  setFakePane(target: string, content: string): void {
    if (!this.fakeWindows.has(target)) return;
    this.fakePanes.set(target, content);
  }

  /** Test/gate accessor: the exact command line a virtual window was given. */
  fakeWindowCommand(target: string): string | null {
    return this.fakeWindows.get(target)?.cmd ?? null;
  }

  listWindows(session = "agentos"): string[] {
    if (this.fake) {
      return [...this.fakeWindows.keys()].filter((k) => k.startsWith(`${session}:`));
    }
    const result = this.run([
      "list-windows",
      "-t",
      session,
      "-F",
      "#{session_name}:#{window_name}",
    ]);
    if (result.status !== 0) return [];
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  sendKeys(target: string, text: string): void {
    if (this.fake) return;
    const result = this.run(["send-keys", "-t", target, "-l", text]);
    if (result.status !== 0) {
      throw new TmuxError(`send-keys failed for ${target}`, result.stderr);
    }
    this.run(["send-keys", "-t", target, "Enter"]);
  }

  /** Human attach command (never executed by the daemon). */
  attachCommand(target: string): string {
    return `tmux -L ${this.socketName} attach -t ${target}`;
  }
}
