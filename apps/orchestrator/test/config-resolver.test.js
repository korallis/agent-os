import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAll, resolveDomain } from "../src/config/resolver.js";
import { SHIPPED_DEFAULTS_DIR } from "../src/daemon.js";
/**
 * §11 Phase 1 config gates: layered resolution matrix (project beats global,
 * task beats project), per-key source layers, all-or-nothing rejection with
 * path-precise issues, and the project trust-gating stub.
 */
const SHIPPED_SUPERVISION = {
    heartbeatSeconds: 30,
    staleMinutes: { api: 5, build: 12 },
    escalationLadderSteps: 3,
    respawnPerStage: 1,
    absorb: ["PROGRESS"],
};
describe("resolveDomain — layering matrix", () => {
    it("uses shipped defaults when no other layer exists", () => {
        const resolved = resolveDomain("supervision", { shipped: SHIPPED_SUPERVISION });
        expect(resolved.value["heartbeatSeconds"]).toBe(30);
        expect(resolved.sources["heartbeatSeconds"]).toBe("shipped");
        expect(resolved.sources["staleMinutes.build"]).toBe("shipped");
        expect(resolved.rejections).toHaveLength(0);
    });
    it("global overrides shipped, per key, with deep merge", () => {
        const resolved = resolveDomain("supervision", {
            shipped: SHIPPED_SUPERVISION,
            global: { staleMinutes: { build: 20 } },
        });
        expect(resolved.value["staleMinutes"]).toEqual({ api: 5, build: 20 });
        expect(resolved.sources["staleMinutes.build"]).toBe("global");
        expect(resolved.sources["staleMinutes.api"]).toBe("shipped");
        expect(resolved.sources["heartbeatSeconds"]).toBe("shipped");
    });
    it("project beats global when trusted; task beats project", () => {
        const resolved = resolveDomain("supervision", {
            shipped: SHIPPED_SUPERVISION,
            global: { heartbeatSeconds: 10, escalationLadderSteps: 4 },
            project: { heartbeatSeconds: 15, respawnPerStage: 2 },
            task: { heartbeatSeconds: 20 },
        }, { trusted: true });
        expect(resolved.value["heartbeatSeconds"]).toBe(20);
        expect(resolved.sources["heartbeatSeconds"]).toBe("task");
        expect(resolved.value["respawnPerStage"]).toBe(2);
        expect(resolved.sources["respawnPerStage"]).toBe("project");
        expect(resolved.value["escalationLadderSteps"]).toBe(4);
        expect(resolved.sources["escalationLadderSteps"]).toBe("global");
        expect(resolved.rejections).toHaveLength(0);
    });
    it("REFUSES the project layer when the repo is not trust-acknowledged (stub)", () => {
        const resolved = resolveDomain("supervision", {
            shipped: SHIPPED_SUPERVISION,
            global: { heartbeatSeconds: 10 },
            project: { heartbeatSeconds: 15 },
        }, { trusted: false });
        expect(resolved.value["heartbeatSeconds"]).toBe(10);
        expect(resolved.sources["heartbeatSeconds"]).toBe("global");
        const projectRejection = resolved.rejections.find((r) => r.layer === "project");
        expect(projectRejection).toBeDefined();
        expect(projectRejection?.issues[0]?.message).toContain("trust");
    });
    it("rejects an invalid layer wholesale — nothing partially applied", () => {
        const resolved = resolveDomain("supervision", {
            shipped: SHIPPED_SUPERVISION,
            // valid respawnPerStage AND invalid heartbeat in the same file:
            global: { respawnPerStage: 3, heartbeatSeconds: "banana" },
        });
        // The valid key must NOT have been applied either.
        expect(resolved.value["respawnPerStage"]).toBe(1);
        expect(resolved.value["heartbeatSeconds"]).toBe(30);
        expect(resolved.sources["respawnPerStage"]).toBe("shipped");
        const rejection = resolved.rejections[0];
        expect(rejection?.layer).toBe("global");
        // Path-precise typed issue.
        expect(rejection?.issues.some((i) => i.path === "heartbeatSeconds")).toBe(true);
    });
    it("rejects unknown keys with a path-precise issue (strict schemas)", () => {
        const resolved = resolveDomain("supervision", {
            shipped: SHIPPED_SUPERVISION,
            global: { llmDecides: true },
        });
        expect(resolved.rejections[0]?.issues[0]?.message).toContain("llmDecides");
    });
    it("a rejected middle layer does not block higher layers", () => {
        const resolved = resolveDomain("supervision", {
            shipped: SHIPPED_SUPERVISION,
            global: { heartbeatSeconds: -5 },
            task: { heartbeatSeconds: 25 },
        }, { trusted: true });
        expect(resolved.value["heartbeatSeconds"]).toBe(25);
        expect(resolved.sources["heartbeatSeconds"]).toBe("task");
        expect(resolved.rejections).toHaveLength(1);
    });
});
describe("resolveAll — full home resolution", () => {
    let globalDir;
    let projectDir;
    beforeEach(() => {
        globalDir = mkdtempSync(join(tmpdir(), "agentos-cfg-global-"));
        projectDir = mkdtempSync(join(tmpdir(), "agentos-cfg-project-"));
        mkdirSync(globalDir, { recursive: true });
    });
    afterEach(() => {
        rmSync(globalDir, { recursive: true, force: true });
        rmSync(projectDir, { recursive: true, force: true });
    });
    it("resolves the shipped defaults pack end-to-end with dotted source keys", () => {
        const result = resolveAll({ shippedDir: SHIPPED_DEFAULTS_DIR, globalDir });
        expect(result.config.supervision.heartbeatSeconds).toBe(30);
        expect(result.config.policies.scoutReadOnly).toBe(true);
        expect(result.config.console.defaultPage).toBe("fleet");
        expect(result.sources["supervision.heartbeatSeconds"]).toBe("shipped");
        expect(result.sources["policies.scoutReadOnly"]).toBe("shipped");
        expect(result.rejections).toHaveLength(0);
    });
    it("applies JSON5 (comments, trailing commas) from the global layer", () => {
        writeFileSync(join(globalDir, "supervision.json5"), "// operator override\n{ heartbeatSeconds: 12, /* inline */ }\n");
        const result = resolveAll({ shippedDir: SHIPPED_DEFAULTS_DIR, globalDir });
        expect(result.config.supervision.heartbeatSeconds).toBe(12);
        expect(result.sources["supervision.heartbeatSeconds"]).toBe("global");
    });
    it("records a rejection for an unparseable global file and keeps shipped values", () => {
        writeFileSync(join(globalDir, "supervision.json5"), "{ not json5 at all ::: }");
        const result = resolveAll({ shippedDir: SHIPPED_DEFAULTS_DIR, globalDir });
        expect(result.config.supervision.heartbeatSeconds).toBe(30);
        expect(result.rejections[0]?.layer).toBe("global");
        expect(result.rejections[0]?.issues[0]?.message).toContain("JSON5 parse error");
    });
    it("project layer only takes effect under an explicit trust policy", () => {
        writeFileSync(join(projectDir, "supervision.json5"), "{ heartbeatSeconds: 3 }");
        const untrusted = resolveAll({ shippedDir: SHIPPED_DEFAULTS_DIR, globalDir, projectDir });
        expect(untrusted.config.supervision.heartbeatSeconds).toBe(30);
        expect(untrusted.rejections.some((r) => r.layer === "project")).toBe(true);
        const trusted = resolveAll({
            shippedDir: SHIPPED_DEFAULTS_DIR,
            globalDir,
            projectDir,
            projectPolicy: { trusted: true },
        });
        expect(trusted.config.supervision.heartbeatSeconds).toBe(3);
        expect(trusted.sources["supervision.heartbeatSeconds"]).toBe("project");
    });
    it("task overrides beat every file layer", () => {
        writeFileSync(join(globalDir, "supervision.json5"), "{ heartbeatSeconds: 12 }");
        const result = resolveAll({
            shippedDir: SHIPPED_DEFAULTS_DIR,
            globalDir,
            taskOverrides: { supervision: { heartbeatSeconds: 4 } },
        });
        expect(result.config.supervision.heartbeatSeconds).toBe(4);
        expect(result.sources["supervision.heartbeatSeconds"]).toBe("task");
    });
});
