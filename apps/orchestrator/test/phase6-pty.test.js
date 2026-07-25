import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { PtyTicketStore } from "../src/pty/tickets.js";
import { attachPtyServer } from "../src/pty/server.js";
import { TmuxController } from "../src/fleet/tmux.js";
/**
 * Attach tickets are the credential that reaches the browser, so their
 * single-use and expiry properties are asserted directly rather than inferred
 * from the WS handshake behaving.
 */
describe("PTY attach tickets", () => {
    it("authorises exactly one redemption", () => {
        const store = new PtyTicketStore();
        const { ticket } = store.issue("01JSESSIONAAAAAAAAAAAAAAAA");
        expect(store.consume(ticket)).toBe("01JSESSIONAAAAAAAAAAAAAAAA");
        // A captured ticket — from a log, history, or a shoulder — is already spent.
        expect(store.consume(ticket)).toBeNull();
    });
    it("expires and cannot be redeemed late", () => {
        const store = new PtyTicketStore();
        const now = 1_000_000;
        const { ticket, expiresAt } = store.issue("01JSESSIONBBBBBBBBBBBBBBBB", now);
        expect(expiresAt).toBeGreaterThan(now);
        expect(store.consume(ticket, expiresAt + 1)).toBeNull();
    });
    it("binds a ticket to the session it was minted for", () => {
        const store = new PtyTicketStore();
        const a = store.issue("01JSESSIONCCCCCCCCCCCCCCCC");
        const b = store.issue("01JSESSIONDDDDDDDDDDDDDDDD");
        expect(store.consume(a.ticket)).toBe("01JSESSIONCCCCCCCCCCCCCCCC");
        expect(store.consume(b.ticket)).toBe("01JSESSIONDDDDDDDDDDDDDDDD");
    });
    it("rejects an unknown ticket without leaking which part was wrong", () => {
        const store = new PtyTicketStore();
        store.issue("01JSESSIONEEEEEEEEEEEEEEEE");
        expect(store.consume("not-a-real-ticket")).toBeNull();
        // The real ticket is still redeemable — a failed guess must not burn it.
        expect(store.size()).toBe(1);
    });
});
describe("PTY stream lifecycle", () => {
    const sessionId = "01JSESSIONPTYSTREAMTEST0001";
    const windowTarget = "agentos:pty-seat";
    let server = null;
    let pty = null;
    let sockets = [];
    afterEach(async () => {
        for (const ws of sockets) {
            try {
                ws.close();
            }
            catch {
                // already closed
            }
        }
        sockets = [];
        if (pty !== null) {
            await pty.close();
            pty = null;
        }
        if (server !== null) {
            await new Promise((resolve) => {
                server.close(() => resolve());
            });
            server = null;
        }
    });
    async function listen() {
        const tickets = new PtyTicketStore();
        const tmux = new TmuxController({ fake: true });
        const window = tmux.newWindow({
            windowName: "pty-seat",
            argv: ["true"],
        });
        tmux.setFakePane(window.target, "hello from pane");
        server = createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("ok");
        });
        pty = attachPtyServer({
            server,
            tickets,
            tmux,
            resolveTarget: (id) => (id === sessionId ? window.target : null),
        });
        await new Promise((resolve) => {
            server.listen(0, "127.0.0.1", () => resolve());
        });
        const address = server.address();
        if (typeof address !== "object" || address === null) {
            throw new Error("expected bound address");
        }
        return { port: address.port, tickets, tmux };
    }
    function openWs(port, ticket) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/pty?ticket=${ticket}`);
            const frames = [];
            sockets.push(ws);
            // Collect before open so an immediate first pane frame is not dropped.
            ws.on("message", (data) => {
                try {
                    frames.push(JSON.parse(String(data)));
                }
                catch {
                    // ignore malformed
                }
            });
            const onError = (err) => reject(err);
            ws.once("error", onError);
            ws.once("open", () => {
                ws.off("error", onError);
                resolve({ ws, frames });
            });
        });
    }
    async function waitForFrame(frames, match, timeoutMs = 5_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const hit = frames.find(match);
            if (hit !== undefined)
                return hit;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`timed out waiting for frame; saw ${JSON.stringify(frames)}`);
    }
    function waitForClose(ws, timeoutMs = 5_000) {
        if (ws.readyState === WebSocket.CLOSED)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
            ws.once("close", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    it("streams pane content then closes cleanly when the window is killed", async () => {
        const { port, tickets, tmux } = await listen();
        const { ticket } = tickets.issue(sessionId);
        const { ws, frames } = await openWs(port, ticket);
        const pane = await waitForFrame(frames, (f) => f.type === "pane" && f.content === "hello from pane");
        expect(pane.type).toBe("pane");
        // Seat ends — a normal operational event; must not throw out of the poll timer.
        tmux.killWindow(windowTarget);
        const closed = await waitForFrame(frames, (f) => f.type === "closed");
        expect(closed.reason).toMatch(/gone/i);
        await waitForClose(ws);
        expect(ws.readyState).toBe(WebSocket.CLOSED);
        // Daemon HTTP surface still serves after the attach path tore down.
        const health = await fetch(`http://127.0.0.1:${port}/`);
        expect(health.status).toBe(200);
        expect(await health.text()).toBe("ok");
        // Extra poll interval: ensure no lingering timer throws after close.
        await new Promise((r) => setTimeout(r, 600));
        const stillHealthy = await fetch(`http://127.0.0.1:${port}/`);
        expect(stillHealthy.status).toBe(200);
    });
    it("tracks clients so close() tears down live streams", async () => {
        const { port, tickets } = await listen();
        const { ticket } = tickets.issue(sessionId);
        const { ws, frames } = await openWs(port, ticket);
        await waitForFrame(frames, (f) => f.type === "pane");
        await pty.close();
        pty = null;
        await waitForClose(ws);
        expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
    it("answers client writes with a read-only notice without throwing", async () => {
        const { port, tickets } = await listen();
        const { ticket } = tickets.issue(sessionId);
        const { ws, frames } = await openWs(port, ticket);
        await waitForFrame(frames, (f) => f.type === "pane");
        ws.send("keystrokes must not reach the pane");
        const notice = await waitForFrame(frames, (f) => f.type === "notice");
        expect(notice.reason).toMatch(/read-only/i);
    });
});
