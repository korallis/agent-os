#!/usr/bin/env node
/**
 * Figma-fidelity gate (master plan §11 Phase 6, [R6.3]).
 *
 *   F1  every Console route is either mapped to a Figma frame or explicitly
 *       declared out of scope with a reason — no route may be silently absent
 *   F2  every mapped route has BOTH sides of the side-by-side on disk
 *   F3  the implementation captures are re-taken at the Figma frame size, so a
 *       reviewer is comparing like with like
 *   F4  every exempt (out-of-scope) screen still uses the shared shell and
 *       design tokens — exemption is not a licence to diverge visually
 *
 * This is a completeness-and-freshness gate, not a pixel-diff. A pixel
 * threshold would either be so loose it passes anything or so tight it fails on
 * font hinting; what actually prevents drift is that a human comparison exists
 * for every screen and that the implementation half is regenerated from the
 * current build rather than left to rot from an earlier one.
 *
 * Usage: node tooling/gates/phase-6-fidelity.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { pickPort } from "./lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON_BIN = join(ROOT, "apps", "orchestrator", "dist", "bin", "agentosd.js");
const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, "tooling", "evidence", "figma-fidelity.json"), "utf8"),
);
const TMUX_SOCKET = `agentos-p6fid-${process.pid}`;
const PORT = pickPort(6000, 40);
const CONSOLE_PORT = pickPort(3400, 60);
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE = `http://127.0.0.1:${CONSOLE_PORT}`;
const CONSOLE_SRC = join(ROOT, "apps", "console", "src");

/** The Figma frames are drawn at this size; capture implementations to match. */
const FRAME = { width: 1440, height: 1024 };

const results = [];
function gate(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PNG IHDR width/height — no dependency, fails closed on non-PNG. */
function pngSize(path) {
  const buf = readFileSync(path);
  if (buf.length < 24) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Every route the Console actually serves, from its own app directory. */
function consoleRoutes() {
  const appDir = join(ROOT, "apps", "console", "src", "app");
  const routes = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_") || entry.name === "api") continue;
      const child = join(dir, entry.name);
      // Dynamic segments are detail screens, not top-level frames.
      const dynamic = entry.name.startsWith("[");
      const route = dynamic ? prefix : `${prefix}/${entry.name}`;
      if (!dynamic && existsSync(join(child, "page.tsx"))) routes.push(route);
      walk(child, dynamic ? prefix : route);
    }
  };
  walk(appDir, "");
  return [...new Set(routes)].sort();
}

function routePagePath(route) {
  const segments = route.split("/").filter(Boolean);
  return join(CONSOLE_SRC, "app", ...segments, "page.tsx");
}

function listFilesRecursive(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/**
 * Source files owned by an exempt route: its page plus components whose folder
 * name matches the last path segment (e.g. /pipeline → components/pipeline).
 */
function exemptSourceFiles(route) {
  const files = [];
  const page = routePagePath(route);
  if (existsSync(page)) files.push(page);
  const segment = route.split("/").filter(Boolean).at(-1);
  if (segment !== undefined) {
    const componentDir = join(CONSOLE_SRC, "components", segment);
    for (const file of listFilesRecursive(componentDir)) {
      if (/\.(tsx|ts|css)$/.test(file)) files.push(file);
    }
  }
  return files;
}

/**
 * Hard-coded colour / type that is not a design-token class. Token classes
 * (bg-shell, text-fg-*, border-line-*, accents) are allowed; raw hex in class
 * names or style blocks is not. Figma-aligned text-[Npx] is used across mapped
 * screens and is not flagged.
 */
function designSystemViolations(source) {
  const violations = [];
  const hexClass =
    /(?:bg|text|border|from|to|via|ring|outline|fill|stroke|decoration|shadow|accent|caret|divide)-\[(?:[^\]]*#|#[0-9a-fA-F]{3,8})/g;
  const hexInStyle = /(?:color|background(?:-color)?|border-color|fill|stroke)\s*:\s*#[0-9a-fA-F]{3,8}/gi;
  const hexLiteralInStyleAttr = /style=\{\{[^}]*#[0-9a-fA-F]{3,8}/g;
  const fontSizeStyle = /fontSize\s*:\s*['"]?\d/g;
  for (const match of source.matchAll(hexClass)) {
    violations.push(`hex-class:${match[0].slice(0, 40)}`);
  }
  for (const match of source.matchAll(hexInStyle)) {
    violations.push(`hex-style:${match[0].slice(0, 40)}`);
  }
  for (const match of source.matchAll(hexLiteralInStyleAttr)) {
    violations.push(`hex-style-attr:${match[0].slice(0, 40)}`);
  }
  for (const match of source.matchAll(fontSizeStyle)) {
    violations.push(`fontSize-style:${match[0].slice(0, 24)}`);
  }
  return violations;
}

function usesSharedShell(pageSource) {
  const importsTopbar =
    /import\s*\{[^}]*\bTopbar\b[^}]*\}\s*from\s*["']@\/components\/shell\/Topbar["']/.test(
      pageSource,
    );
  const rendersTopbar = /<Topbar\b/.test(pageSource);
  // Mapped screens use Topbar + <main className="flex-1…">; exempt screens must
  // share that scaffold so the product stays visually consistent.
  const pageScaffold = /<main\b[^>]*\bflex-1\b/.test(pageSource);
  return importsTopbar && rendersTopbar && pageScaffold;
}

const cleanups = [];
let daemon;
let consoleServer;
let browser;

try {
  const routes = consoleRoutes();
  const mapped = Object.keys(MANIFEST.routes);
  const outOfScope = Object.keys(MANIFEST.outOfScope ?? {});

  // ── F1 — completeness ─────────────────────────────────────────────────
  {
    const unaccounted = routes.filter((r) => !mapped.includes(r) && !outOfScope.includes(r));
    const stale = mapped.filter((r) => !routes.includes(r));
    // Out-of-scope entries must carry a reason, not just an exemption.
    const unexplained = outOfScope.filter(
      (r) => String(MANIFEST.outOfScope[r] ?? "").trim().length < 20,
    );
    gate(
      "F1",
      "every Console route is mapped to a Figma frame or explicitly exempted with a reason",
      unaccounted.length === 0 && stale.length === 0 && unexplained.length === 0,
      `routes=${routes.length} mapped=${mapped.length} exempt=${outOfScope.length}` +
        `${unaccounted.length > 0 ? ` UNACCOUNTED=[${unaccounted.join(",")}]` : ""}` +
        `${stale.length > 0 ? ` STALE=[${stale.join(",")}]` : ""}` +
        `${unexplained.length > 0 ? ` UNEXPLAINED=[${unexplained.join(",")}]` : ""}`,
    );
  }

  // ── F4 — exempt screens stay on the design system ─────────────────────
  {
    const problems = [];
    const checked = [];
    for (const route of outOfScope) {
      const reason = String(MANIFEST.outOfScope[route] ?? "").trim();
      if (reason.length < 20) {
        problems.push(`${route}:missing-reason`);
        continue;
      }
      // Forward-declared exemptions (route not shipped yet) only need a reason.
      const live = routes.includes(route) || existsSync(routePagePath(route));
      if (!live) continue;
      checked.push(route);
      const pagePath = routePagePath(route);
      if (!existsSync(pagePath)) {
        problems.push(`${route}:missing-page`);
        continue;
      }
      const pageSource = readFileSync(pagePath, "utf8");
      if (!usesSharedShell(pageSource)) {
        problems.push(`${route}:shell`);
      }
      for (const file of exemptSourceFiles(route)) {
        const source = readFileSync(file, "utf8");
        const hits = designSystemViolations(source);
        if (hits.length > 0) {
          const rel = relative(ROOT, file);
          problems.push(`${route}:${rel}:${hits[0]}`);
        }
      }
    }
    gate(
      "F4",
      "exempt screens use the shared shell and design tokens (not just a prose reason)",
      problems.length === 0,
      problems.length === 0
        ? `exempt=${outOfScope.length} checked=${checked.length}`
        : `problems=[${problems.join(";")}]`,
    );
  }

  // ── Re-capture the implementation half against a real daemon ──────────
  const home = mkdtempSync(join(tmpdir(), "agentos-p6fid-home-"));
  cleanups.push(home);
  daemon = spawn(process.execPath, [DAEMON_BIN], {
    env: {
      ...process.env,
      AGENTOS_HOME: home,
      AGENTOS_PORT: String(PORT),
      AGENTOS_TMUX_SOCKET: TMUX_SOCKET,
      AGENTOS_FAKE_PI: "1",
      AGENTOS_FAKE_BRAIN: "1",
      AGENTOS_FAKE_GATE: "1",
      AGENTOS_FAKE_GIT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  {
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        up = (await fetch(`${BASE}/v1/health`)).ok;
      } catch {
        // not up
      }
      if (!up) await sleep(150);
    }
    if (!up) throw new Error("daemon did not start");
  }

  consoleServer = spawn(
    join(ROOT, "apps", "console", "node_modules", ".bin", "next"),
    ["start", "-p", String(CONSOLE_PORT), "-H", "127.0.0.1"],
    {
      cwd: join(ROOT, "apps", "console"),
      env: { ...process.env, AGENTOS_HOME: home, AGENTOS_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  {
    const deadline = Date.now() + 90_000;
    let up = false;
    while (Date.now() < deadline && !up) {
      try {
        up = (await fetch(`${CONSOLE}/fleet`)).status < 500;
      } catch {
        // not up
      }
      if (!up) await sleep(300);
    }
    if (!up) throw new Error("console did not start");
  }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: FRAME });

  /** Paths successfully written by THIS run — freshness without mtime races. */
  const writtenThisRun = new Set();
  const captured = [];
  for (const [route, entry] of Object.entries(MANIFEST.routes)) {
    const packDir = join(ROOT, "docs", "qa", "runs", entry.pack);
    const implPath = join(packDir, `${entry.slug}-impl.png`);
    try {
      const res = await page.goto(`${CONSOLE}${route}`, { waitUntil: "networkidle" });
      await sleep(700);
      // Frame-sized, not full-page: the comparison is against a 1440×1024 frame.
      await page.screenshot({ path: implPath });
      writtenThisRun.add(implPath);
      captured.push({ route, slug: entry.slug, path: implPath, status: res?.status() ?? 0 });
    } catch (error) {
      captured.push({
        route,
        slug: entry.slug,
        path: implPath,
        status: 0,
        error: String(error).slice(0, 80),
      });
    }
  }

  // ── F2 — both halves present ──────────────────────────────────────────
  {
    const missing = [];
    for (const [route, entry] of Object.entries(MANIFEST.routes)) {
      const packDir = join(ROOT, "docs", "qa", "runs", entry.pack);
      for (const side of ["figma", "impl"]) {
        const path = join(packDir, `${entry.slug}-${side}.png`);
        if (!existsSync(path) || statSync(path).size < 1000) {
          missing.push(`${route}:${side}`);
        }
      }
    }
    gate(
      "F2",
      "every mapped route has both a Figma frame and an implementation capture on disk",
      missing.length === 0,
      missing.length === 0
        ? `${mapped.length} side-by-sides present`
        : `missing=[${missing.join(",")}]`,
    );
  }

  // ── F3 — implementation halves are FRESH and frame-sized ──────────────
  {
    const stale = [];
    const badSize = [];
    for (const [route, entry] of Object.entries(MANIFEST.routes)) {
      const path = join(ROOT, "docs", "qa", "runs", entry.pack, `${entry.slug}-impl.png`);
      if (!writtenThisRun.has(path)) {
        stale.push(route);
        continue;
      }
      const size = pngSize(path);
      if (size === null || size.width !== FRAME.width || size.height !== FRAME.height) {
        badSize.push(
          `${route}:${size === null ? "unreadable" : `${size.width}x${size.height}`}`,
        );
      }
    }
    const failedRoutes = captured.filter((c) => c.status >= 400 || c.error !== undefined);
    gate(
      "F3",
      "implementation captures are regenerated from the current build at the Figma frame size",
      stale.length === 0 && badSize.length === 0 && failedRoutes.length === 0,
      `captured=${captured.length} at ${FRAME.width}×${FRAME.height}` +
        `${stale.length > 0 ? ` STALE=[${stale.join(",")}]` : ""}` +
        `${badSize.length > 0 ? ` BAD_SIZE=[${badSize.join(",")}]` : ""}` +
        `${failedRoutes.length > 0 ? ` FAILED=[${failedRoutes.map((f) => f.route).join(",")}]` : ""}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  process.exit(failed.length === 0 ? 0 : 1);
} catch (error) {
  console.error(error);
  process.exit(1);
} finally {
  try {
    await browser?.close();
  } catch {
    // ignore
  }
  for (const child of [consoleServer, daemon]) {
    try {
      child?.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  spawnSync("tmux", ["-L", TMUX_SOCKET, "kill-server"], { encoding: "utf8" });
  for (const path of cleanups) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
