"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@agent-os/ui";
import type { AttachTicketResponse } from "@agent-os/protocol";

/**
 * Read-only terminal attach (master plan §7.2).
 *
 * Mints a single-use ticket over authenticated REST, then opens the PTY
 * WebSocket with it. The stream is deliberately read-only — the Console never
 * types into a crewmate's pane. Taking over is the Captain running the attach
 * command in their own terminal, which the session page shows alongside this.
 *
 * The ticket is one-shot, so reconnecting mints a fresh one; a ticket captured
 * from a log or history is already spent.
 */

type Status = "idle" | "connecting" | "streaming" | "closed" | "error";

interface PaneFrame {
  type: "pane" | "closed" | "notice";
  content?: string;
  reason?: string;
}

export function TerminalAttach({ sessionId }: { sessionId: string }) {
  const [status, setStatus] = useState<Status>("idle");
  const [pane, setPane] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const boundSession = useRef(sessionId);
  /** Bumped on session change, reconnect, and unmount to drop stale in-flight work. */
  const connectGen = useRef(0);

  // Never let one seat's pane persist under another seat's id.
  useEffect(() => {
    if (boundSession.current !== sessionId) {
      boundSession.current = sessionId;
      connectGen.current += 1;
      socketRef.current?.close();
      socketRef.current = null;
      setStatus("idle");
      setPane("");
      setMessage(null);
    }
  }, [sessionId]);

  useEffect(() => {
    return () => {
      connectGen.current += 1;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const connect = async (): Promise<void> => {
    const gen = ++connectGen.current;
    const forSession = sessionId;

    socketRef.current?.close();
    socketRef.current = null;

    setStatus("connecting");
    setMessage(null);
    try {
      const res = await fetch(`/api/agentos/sessions/${forSession}/attach-ticket`, {
        method: "POST",
      });
      if (gen !== connectGen.current || boundSession.current !== forSession) return;
      if (!res.ok) {
        setStatus("error");
        setMessage(
          res.status === 404
            ? "This session is no longer in the fleet registry."
            : `Could not mint an attach ticket (daemon ${res.status}).`,
        );
        return;
      }
      const body = (await res.json()) as AttachTicketResponse;
      if (gen !== connectGen.current || boundSession.current !== forSession) return;
      // Connect DIRECTLY to the loopback daemon: Next route handlers cannot
      // proxy a WS upgrade. The ticket is the credential, which is why it is
      // single-use and short-lived — the daemon token never leaves the server.
      socketRef.current?.close();
      const ws = new WebSocket(body.wsUrl);
      if (gen !== connectGen.current || boundSession.current !== forSession) {
        ws.close();
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => {
        if (gen !== connectGen.current) {
          ws.close();
          return;
        }
        setStatus("streaming");
      };
      ws.onmessage = (event) => {
        if (gen !== connectGen.current) return;
        try {
          const frame = JSON.parse(String(event.data)) as PaneFrame;
          if (frame.type === "pane" && frame.content !== undefined) {
            setPane(frame.content);
          } else if (frame.type === "closed") {
            setStatus("closed");
            setMessage(frame.reason ?? "Stream closed.");
          } else if (frame.type === "notice") {
            setMessage(frame.reason ?? null);
          }
        } catch {
          // Ignore malformed frames rather than tearing the view down.
        }
      };
      ws.onerror = () => {
        if (gen !== connectGen.current) return;
        setStatus("error");
        setMessage("Terminal stream failed.");
      };
      ws.onclose = () => {
        if (gen !== connectGen.current) return;
        setStatus((prev) => (prev === "error" ? prev : "closed"));
      };
    } catch {
      if (gen !== connectGen.current || boundSession.current !== forSession) return;
      setStatus("error");
      setMessage("Could not reach agentosd to attach.");
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-fg-1">Terminal (read-only)</h3>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[11px] font-medium",
              status === "streaming"
                ? "text-ok"
                : status === "error"
                  ? "text-danger"
                  : "text-fg-3",
            )}
          >
            {status}
          </span>
          <button
            type="button"
            onClick={() => void connect()}
            disabled={status === "connecting" || status === "streaming"}
            className="rounded-lg bg-panel-2 border border-line-1 px-3 py-1 text-[11px] font-medium text-fg-1 disabled:opacity-50"
          >
            {status === "streaming" ? "Streaming" : status === "closed" ? "Reconnect" : "Attach"}
          </button>
        </div>
      </div>
      {message !== null && (
        <p
          className={cn(
            "mb-2 text-[11px]",
            status === "error" ? "text-danger" : "text-fg-3",
          )}
        >
          {message}
        </p>
      )}
      <div className="rounded-2xl border border-line-2 bg-shell overflow-hidden">
        {pane.length === 0 ? (
          <p className="px-4 py-10 text-center text-[12px] text-fg-3">
            {status === "idle"
              ? "Attach to stream this pane. The Console never types into it."
              : status === "connecting"
                ? "Connecting…"
                : "No pane output yet."}
          </p>
        ) : (
          <pre className="max-h-[420px] overflow-auto px-4 py-3 text-[11px] leading-[16px] font-mono text-fg-2 whitespace-pre">
            {pane}
          </pre>
        )}
      </div>
    </section>
  );
}
