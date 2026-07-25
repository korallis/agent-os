import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { PtyTicketStore } from "./tickets.js";
import type { TmuxController } from "../fleet/tmux.js";

/**
 * Read-only terminal attach over WebSocket (master plan §7.2, §8).
 *
 * This streams what the pane actually shows, by polling `tmux capture-pane` and
 * sending only when the content changed. It is deliberately READ-ONLY: the
 * Console never writes keystrokes into a crewmate's pane. Taking over is done
 * by the Captain running the attach command in their own terminal, which is
 * what "human-attachable" means in the plan — the daemon is not a proxy for the
 * Captain's hands.
 *
 * Polling rather than a real PTY is a deliberate trade: `tmux pipe-pane` would
 * stream raw output but requires a writable FIFO per session, and a true PTY
 * would need a native addon. Capture-pane reads the same pane the human would
 * see, with no native dependency and no write path to abuse.
 *
 * Capture is async so a slow or stuck tmux cannot block the daemon event loop.
 * Liveness is inferred from capture failures (no separate list-windows probe).
 */

const POLL_MS = 500;
const MAX_CAPTURE_LINES = 400;
/** Consecutive capture failures before treating the pane as gone. */
const GONE_AFTER_FAILURES = 2;

export interface PtyServerDeps {
  server: Server;
  tickets: PtyTicketStore;
  tmux: TmuxController;
  /** Resolve a session id to its tmux target, or null when unknown. */
  resolveTarget: (sessionId: string) => string | null;
  path?: string;
}

export function attachPtyServer(deps: PtyServerDeps): { close: () => Promise<void> } {
  const path = deps.path ?? "/v1/pty";
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (
    request: import("node:http").IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): void => {
    // Loopback-only, mirroring the REST guard — the WS upgrade path must not be
    // a weaker door into the same daemon.
    const remote = request.socket.remoteAddress ?? "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
      socket.destroy();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== path) return;

    // Same exact-origin rule as REST: a browser context must be local. The WS
    // upgrade must not be a weaker door than the routes beside it.
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin.length > 0) {
      let host: string | null = null;
      try {
        host = new URL(origin).hostname;
      } catch {
        host = null;
      }
      if (host === null || !["localhost", "127.0.0.1", "::1"].includes(host)) {
        socket.destroy();
        return;
      }
    }

    const ticket = url.searchParams.get("ticket");
    if (ticket === null || ticket.length === 0) {
      socket.destroy();
      return;
    }
    const sessionId = deps.tickets.consume(ticket);
    if (sessionId === null) {
      socket.destroy();
      return;
    }
    const target = deps.resolveTarget(sessionId);
    if (target === null) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      // Required for clientTracking so wss.clients (and close()) include this socket.
      wss.emit("connection", ws, request);
      streamPane(ws, target, deps.tmux);
    });
  };

  deps.server.on("upgrade", onUpgrade);

  return {
    close: async () => {
      deps.server.off("upgrade", onUpgrade);
      for (const client of wss.clients) {
        try {
          client.close();
        } catch {
          // already gone
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

function safeSend(ws: WebSocket, data: string): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

function streamPane(ws: WebSocket, target: string, tmux: TmuxController): void {
  let last = "";
  let closed = false;
  let failures = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    closed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const endStream = (reason: string): void => {
    if (closed) return;
    stop();
    safeSend(ws, JSON.stringify({ type: "closed", reason, lastSeq: seq }));
    try {
      ws.close();
    } catch {
      // already closing or closed
    }
  };

  /**
   * Monotonic frame sequence, per stream.
   *
   * Without it a dropped frame is indistinguishable from a pane that simply did
   * not change — which is exactly the ambiguity the "no dropped frames" soak
   * has to rule out. The client asserts `seq` increases by one; a gap means a
   * genuine loss, not a quiet pane.
   *
   * It also makes reconnect honest: a resumed stream reports the target it
   * re-attached to and restarts its own numbering from 1, so continuity is a
   * claim the client can check rather than one the server just asserts.
   */
  let seq = 0;

  const tick = (): void => {
    if (closed || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const captured = await tmux.capturePane(target, MAX_CAPTURE_LINES);
        if (closed) return;
        if (captured === null) {
          failures += 1;
          if (failures >= GONE_AFTER_FAILURES) {
            endStream("pane is gone");
          }
          return;
        }
        failures = 0;
        if (captured !== last) {
          seq += 1;
          if (safeSend(ws, JSON.stringify({ type: "pane", seq, content: captured }))) {
            last = captured;
          } else if (
            ws.readyState === WebSocket.CLOSING ||
            ws.readyState === WebSocket.CLOSED
          ) {
            stop();
          }
        }
      } finally {
        inFlight = false;
      }
    })();
  };

  timer = setInterval(tick, POLL_MS);
  tick();

  // Read-only: anything the client sends is ignored rather than forwarded to
  // the pane. Say so explicitly instead of silently dropping it.
  ws.on("message", () => {
    safeSend(
      ws,
      JSON.stringify({
        type: "notice",
        reason: "read-only stream — use the attach command to take over",
      }),
    );
  });

  ws.on("close", () => {
    stop();
  });
  ws.on("error", () => {
    stop();
  });
}
