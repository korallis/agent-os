import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectiveConfigResponseSchema, eventsReplayResponseSchema, healthResponseSchema, statusResponseSchema, apiErrorResponseSchema, SAFETY_CONFIRM_HEADER, } from "@agent-os/protocol";
import { startDaemon } from "../src/daemon.js";
/**
 * Integration suite against a real daemon on an ephemeral loopback port:
 * §11 Phase 1 gates for auth (401s), origin checks, SSE replay/resume,
 * hot-reload, typed config rejection, and safety-policy confirmation.
 */
let home;
let daemon;
let base;
let auth;
beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "agentos-daemon-"));
    daemon = await startDaemon({ home, port: 0 });
    base = `http://127.0.0.1:${daemon.port}`;
    auth = { authorization: `Bearer ${daemon.token}` };
});
afterAll(async () => {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
});
async function readSse(path, headers, until, timeoutMs = 5000) {
    const controller = new AbortController();
    const response = await fetch(`${base}${path}`, {
        headers: { ...auth, ...headers },
        signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (reader === undefined)
        throw new Error("no body");
    const decoder = new TextDecoder();
    const frames = [];
    let buffer = "";
    const deadline = Date.now() + timeoutMs;
    // A single in-flight read is reused across poll iterations — racing a fresh
    // reader.read() every loop would abandon reads and silently drop chunks.
    let pending = null;
    while (Date.now() < deadline) {
        pending ??= reader.read();
        const race = await Promise.race([
            pending,
            new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
        ]);
        if (race === "timeout") {
            if (until(frames))
                break;
            continue;
        }
        pending = null;
        if (race.done)
            break;
        buffer += decoder.decode(race.value, { stream: true });
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
            const block = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine !== undefined) {
                frames.push(JSON.parse(dataLine.slice(6)));
            }
            sep = buffer.indexOf("\n\n");
        }
        if (until(frames))
            break;
    }
    controller.abort();
    return frames;
}
describe("agentosd HTTP surface", () => {
    it("serves /v1/health unauthenticated", async () => {
        const response = await fetch(`${base}/v1/health`);
        expect(response.status).toBe(200);
        const parsed = healthResponseSchema.parse(await response.json());
        expect(parsed.name).toBe("agentosd");
    });
    it("401s every other route without the bearer token", async () => {
        for (const path of ["/v1/status", "/v1/events/replay", "/v1/config/effective"]) {
            const response = await fetch(`${base}${path}`);
            expect(response.status).toBe(401);
            const parsed = apiErrorResponseSchema.parse(await response.json());
            expect(parsed.error.code).toBe("UNAUTHORIZED");
        }
        const bad = await fetch(`${base}/v1/status`, {
            headers: { authorization: "Bearer wrong-token" },
        });
        expect(bad.status).toBe(401);
    });
    it("refuses cross-origin browser requests (loopback origin check §8.1)", async () => {
        const response = await fetch(`${base}/v1/health`, {
            headers: { origin: "https://evil.example" },
        });
        expect(response.status).toBe(403);
        const parsed = apiErrorResponseSchema.parse(await response.json());
        expect(parsed.error.code).toBe("FORBIDDEN");
        const ok = await fetch(`${base}/v1/health`, {
            headers: { origin: "http://localhost:3000" },
        });
        expect(ok.status).toBe(200);
    });
    it("reports status with event-store counters", async () => {
        const response = await fetch(`${base}/v1/status`, { headers: auth });
        const parsed = statusResponseSchema.parse(await response.json());
        expect(parsed.daemon.home).toBe(home);
        expect(parsed.events.count).toBeGreaterThanOrEqual(2); // config.installed + daemon.started
    });
    it("installed shipped defaults into <home>/config on init", async () => {
        for (const domain of ["supervision", "policies", "console"]) {
            const raw = readFileSync(join(home, "config", `${domain}.json5`), "utf8");
            expect(raw).toContain("GLOBAL layer");
        }
        const response = await fetch(`${base}/v1/config/effective`, { headers: auth });
        const parsed = effectiveConfigResponseSchema.parse(await response.json());
        // Templates parse as {} → everything still sourced from shipped.
        expect(parsed.sources["supervision.heartbeatSeconds"]).toBe("shipped");
    });
});
describe("config writes and hot reload", () => {
    it("rejects an invalid write with typed path-precise issues and applies nothing", async () => {
        const before = readFileSync(join(home, "config", "supervision.json5"), "utf8");
        const response = await fetch(`${base}/v1/config/global/supervision`, {
            method: "PUT",
            headers: { ...auth, "content-type": "text/plain" },
            body: '{ heartbeatSeconds: "nope", staleMinutes: { build: 20 } }',
        });
        expect(response.status).toBe(400);
        const parsed = apiErrorResponseSchema.parse(await response.json());
        expect(parsed.error.code).toBe("CONFIG_INVALID");
        expect(parsed.error.issues?.some((i) => i.path === "heartbeatSeconds")).toBe(true);
        // Nothing applied: file untouched, effective value unchanged.
        expect(readFileSync(join(home, "config", "supervision.json5"), "utf8")).toBe(before);
        const effective = await fetch(`${base}/v1/config/effective`, { headers: auth });
        const config = effectiveConfigResponseSchema.parse(await effective.json());
        expect(config.config.supervision.staleMinutes.build).toBe(12);
    });
    it("applies a valid JSON5 write and emits config.changed", async () => {
        const response = await fetch(`${base}/v1/config/global/supervision`, {
            method: "PUT",
            headers: { ...auth, "content-type": "text/plain" },
            body: "// operator\n{ heartbeatSeconds: 11, }",
        });
        expect(response.status).toBe(200);
        const effective = await fetch(`${base}/v1/config/effective`, { headers: auth });
        const config = effectiveConfigResponseSchema.parse(await effective.json());
        expect(config.config.supervision.heartbeatSeconds).toBe(11);
        expect(config.sources["supervision.heartbeatSeconds"]).toBe("global");
        const replay = await fetch(`${base}/v1/events/replay`, { headers: auth });
        const events = eventsReplayResponseSchema.parse(await replay.json());
        const changed = events.events.filter((e) => e.event.type === "config.changed");
        expect(changed.length).toBeGreaterThanOrEqual(1);
    });
    it("hot-reloads an EXTERNAL file edit of a supervision value (observed)", async () => {
        const seen = readSse("/v1/events", {}, (frames) => frames.some((f) => f.event.type === "config.changed" &&
            f.event.payload.domain === "supervision" &&
            daemon.config.config.supervision.heartbeatSeconds === 17));
        await new Promise((resolve) => setTimeout(resolve, 150));
        writeFileSync(join(home, "config", "supervision.json5"), "{ heartbeatSeconds: 17 }");
        const frames = await seen;
        expect(frames.some((f) => f.event.type === "config.changed" && f.event.payload.domain === "supervision")).toBe(true);
        expect(daemon.config.config.supervision.heartbeatSeconds).toBe(17);
    });
    it("keeps previous values and emits config.rejected on an invalid external edit", async () => {
        const seen = readSse("/v1/events", {}, (frames) => frames.some((f) => f.event.type === "config.rejected"));
        await new Promise((resolve) => setTimeout(resolve, 150));
        writeFileSync(join(home, "config", "supervision.json5"), "{ heartbeatSeconds: -2 }");
        const frames = await seen;
        const rejected = frames.find((f) => f.event.type === "config.rejected");
        expect(rejected).toBeDefined();
        // Previous value retained.
        expect(daemon.config.config.supervision.heartbeatSeconds).toBe(17);
    });
    it("requires confirmation for safety-policy writes and emits policy.changed", async () => {
        const noConfirm = await fetch(`${base}/v1/config/global/policies`, {
            method: "PUT",
            headers: { ...auth, "content-type": "text/plain" },
            body: "{ scoutReadOnly: false }",
        });
        expect(noConfirm.status).toBe(428);
        expect(apiErrorResponseSchema.parse(await noConfirm.json()).error.code).toBe("CONFIRMATION_REQUIRED");
        const confirmed = await fetch(`${base}/v1/config/global/policies`, {
            method: "PUT",
            headers: {
                ...auth,
                "content-type": "text/plain",
                [SAFETY_CONFIRM_HEADER]: "true",
            },
            body: "{ scoutReadOnly: false }",
        });
        expect(confirmed.status).toBe(200);
        const replay = await fetch(`${base}/v1/events/replay`, { headers: auth });
        const events = eventsReplayResponseSchema.parse(await replay.json());
        const policyChanged = events.events.filter((e) => e.event.type === "policy.changed");
        expect(policyChanged.length).toBe(1);
        expect(policyChanged[0]?.event.payload).toMatchObject({ safetyOverride: true });
    });
    it("refuses writes to shipped/project/task layers with a typed error", async () => {
        for (const layer of ["shipped", "project", "task"]) {
            const response = await fetch(`${base}/v1/config/${layer}/supervision`, {
                method: "PUT",
                headers: { ...auth, "content-type": "text/plain" },
                body: "{ heartbeatSeconds: 20 }",
            });
            expect(response.status).toBe(400);
            expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe("LAYER_NOT_WRITABLE");
        }
    });
});
describe("SSE replay & resume", () => {
    it("replays history and resumes from Last-Event-ID", async () => {
        const all = await readSse("/v1/events", {}, (frames) => frames.length >= 3);
        expect(all.length).toBeGreaterThanOrEqual(3);
        expect(all[0]?.seq).toBe(1);
        const cursor = all[1];
        if (cursor === undefined)
            throw new Error("expected at least 2 frames");
        const resumed = await readSse("/v1/events", { "last-event-id": cursor.id }, (frames) => frames.length >= all.length - 2);
        expect(resumed[0]?.seq).toBe(cursor.seq + 1);
    });
    it("REST replay honors after + limit with truncation flag", async () => {
        const response = await fetch(`${base}/v1/events/replay?limit=2`, { headers: auth });
        const parsed = eventsReplayResponseSchema.parse(await response.json());
        expect(parsed.events).toHaveLength(2);
        expect(parsed.truncated).toBe(true);
    });
});
describe("§11 gate: state change reflects over SSE within 500 ms", () => {
    it("delivers a config state change to an SSE subscriber in <500ms", async () => {
        let changedAt = 0;
        let observedAt = 0;
        const seen = readSse("/v1/events", {}, (frames) => {
            const hit = frames.find((f) => f.event.type === "config.changed" &&
                f.event.payload.contentHash.length > 0 &&
                changedAt > 0);
            if (hit !== undefined && observedAt === 0)
                observedAt = Date.now();
            return observedAt > 0;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        changedAt = Date.now();
        const response = await fetch(`${base}/v1/config/global/supervision`, {
            method: "PUT",
            headers: { ...auth, "content-type": "text/plain" },
            body: "{ heartbeatSeconds: 21 }",
        });
        expect(response.status).toBe(200);
        await seen;
        expect(observedAt).toBeGreaterThan(0);
        expect(observedAt - changedAt).toBeLessThan(500);
    });
});
