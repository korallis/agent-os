import { createServer } from "node:net";
import { chmodSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { extensionToDaemonFrameSchema, } from "@agent-os/protocol";
const HUB_SOCK_MODE = 0o600;
export class SocketHub {
    socketDir;
    server = null;
    sockets = new Map();
    /** Per-session listeners, opened before a Pi spawn and closed on session end. */
    sessionServers = new Map();
    onFrame = () => undefined;
    eventSink = () => undefined;
    constructor(socketDir) {
        this.socketDir = socketDir;
    }
    onExtensionFrame(handler) {
        this.onFrame = handler;
    }
    onEvent(sink) {
        this.eventSink = sink;
    }
    /** Listen on hub.sock as a liveness/handshake endpoint only (no session traffic). */
    async listen() {
        mkdirSync(this.socketDir, { recursive: true, mode: 0o700 });
        const path = `${this.socketDir}/hub.sock`;
        if (existsSync(path)) {
            try {
                unlinkSync(path);
            }
            catch {
                // ignore
            }
        }
        return new Promise((resolve, reject) => {
            // Unbound accept path: connections are accepted for liveness probes but
            // every session-claiming frame is refused in handleConnection.
            const server = createServer((socket) => this.handleConnection(socket));
            server.on("error", reject);
            // Owner-only socket: restrict group/other access on multi-user hosts.
            server.listen({ path, readableAll: false, writableAll: false }, () => {
                try {
                    chmodSync(path, HUB_SOCK_MODE);
                }
                catch {
                    // Best-effort; parent dir is already 0o700.
                }
                this.server = server;
                resolve(path);
            });
        });
    }
    sessionSocketPath(sessionId) {
        return `${this.socketDir}/${sessionId}.sock`;
    }
    /**
     * Open a dedicated 0600 listener for one session before its Pi is spawned.
     * Per-session sockets (rather than one shared hub) mean a session's control
     * channel cannot be claimed by another local process asserting a `sessionId`
     * in `ext.hello`. Idempotent. Synchronous: Unix bind is ready when
     * `server.listening` is true; callers must not spawn Pi until this returns.
     */
    openSession(sessionId) {
        const existing = this.sessionServers.get(sessionId);
        const path = this.sessionSocketPath(sessionId);
        if (existing !== undefined)
            return path;
        mkdirSync(this.socketDir, { recursive: true, mode: 0o700 });
        if (existsSync(path)) {
            try {
                unlinkSync(path);
            }
            catch {
                // stale socket from a previous daemon life
            }
        }
        const server = createServer((socket) => this.handleConnection(socket, sessionId));
        let listenError;
        server.once("error", (error) => {
            listenError = error;
            this.sessionServers.delete(sessionId);
        });
        server.listen({ path, readableAll: false, writableAll: false });
        if (listenError !== undefined) {
            try {
                server.close();
            }
            catch {
                // ignore
            }
            throw listenError;
        }
        if (!server.listening) {
            try {
                server.close();
            }
            catch {
                // ignore
            }
            throw new Error(`failed to bind session socket ${path}`);
        }
        try {
            chmodSync(path, HUB_SOCK_MODE);
        }
        catch {
            // Best-effort; parent dir is already 0o700.
        }
        this.sessionServers.set(sessionId, server);
        return path;
    }
    /** Tear down a session listener and its socket file. */
    async closeSession(sessionId) {
        this.sockets.get(sessionId)?.destroy();
        this.sockets.delete(sessionId);
        const server = this.sessionServers.get(sessionId);
        this.sessionServers.delete(sessionId);
        if (server !== undefined) {
            await new Promise((resolve) => {
                server.close(() => resolve());
            });
        }
        try {
            unlinkSync(this.sessionSocketPath(sessionId));
        }
        catch {
            // already gone
        }
    }
    isSessionConnected(sessionId) {
        return this.sockets.has(sessionId);
    }
    /**
     * @param boundSessionId when the connection arrived on a per-session
     * listener, the only `sessionId` this peer is allowed to claim. When
     * omitted (hub.sock), no session-claiming frames are dispatched.
     */
    handleConnection(socket, boundSessionId) {
        let buffer = "";
        let sessionId = null;
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            let nl;
            while ((nl = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (line.length === 0)
                    continue;
                let parsed;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    continue;
                }
                const frame = extensionToDaemonFrameSchema.safeParse(parsed);
                if (!frame.success)
                    continue;
                // hub.sock is liveness-only: refuse every session-claiming ext.* frame.
                if (boundSessionId === undefined) {
                    continue;
                }
                // A per-session peer may only speak for the session it connected as.
                if (frame.data.sessionId !== boundSessionId) {
                    continue;
                }
                if (frame.data.type === "ext.hello") {
                    sessionId = frame.data.sessionId;
                    this.sockets.set(sessionId, socket);
                    this.eventSink({
                        type: "ext.hello",
                        payload: {
                            sessionId: frame.data.sessionId,
                            role: frame.data.role,
                            piVersion: frame.data.piVersion,
                        },
                    });
                }
                else if (frame.data.type === "ext.usage") {
                    this.eventSink({
                        type: "ext.usage",
                        payload: {
                            sessionId: frame.data.sessionId,
                            provider: frame.data.provider,
                            model: frame.data.model,
                            inputTokens: frame.data.inputTokens,
                            outputTokens: frame.data.outputTokens,
                            costUsd: frame.data.costUsd,
                        },
                    });
                }
                this.onFrame(frame.data);
            }
        });
        socket.on("close", () => {
            // Only drop the map entry when it still points at this socket. A reconnect
            // that hellos on a new socket before the old close fires must not wipe the live peer.
            if (sessionId !== null && this.sockets.get(sessionId) === socket) {
                this.sockets.delete(sessionId);
            }
        });
    }
    sendControl(sessionId, frame) {
        const socket = this.sockets.get(sessionId);
        if (socket === undefined)
            return false;
        socket.write(`${JSON.stringify(frame)}\n`);
        return true;
    }
    async close() {
        for (const socket of this.sockets.values()) {
            socket.destroy();
        }
        this.sockets.clear();
        for (const [id, server] of this.sessionServers) {
            await new Promise((resolve) => {
                server.close(() => resolve());
            });
            try {
                unlinkSync(this.sessionSocketPath(id));
            }
            catch {
                // already gone
            }
        }
        this.sessionServers.clear();
        if (this.server !== null) {
            const server = this.server;
            this.server = null;
            await new Promise((resolve) => {
                server.close(() => resolve());
            });
        }
    }
}
/** Ensure parent dir for a session socket path exists. */
export function ensureSocketParent(socketPath) {
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
}
