#!/usr/bin/env node
/**
 * Fails (exit 1) if ANY installed dependency, at any depth, is deprecated.
 *
 * How it works:
 *  1. Enumerates every package instance pnpm has installed by reading the
 *     virtual-store directory names under node_modules/.pnpm — this covers
 *     the full transitive closure at exact resolved versions (pnpm stores
 *     every package, at every depth, as <name>@<version>[(peer-suffix)]).
 *  2. Fetches the abbreviated packument for each unique package name from
 *     the npm registry and checks the `deprecated` field of the exact
 *     installed version.
 *
 * Deterministic: results depend only on the lockfile-driven install and the
 * registry's deprecation metadata; output is sorted; any lookup failure is a
 * hard error (never silently skipped).
 */

import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VIRTUAL_STORE = join(ROOT, "node_modules", ".pnpm");
const REGISTRY = process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org";
const CONCURRENCY = 16;
const RETRIES = 3;

if (!existsSync(VIRTUAL_STORE)) {
  console.error(
    `error: ${VIRTUAL_STORE} not found — run \`pnpm install\` first.`,
  );
  process.exit(2);
}

/** @returns {Map<string, Set<string>>} name -> set of installed versions */
function collectInstalledPackages() {
  /** @type {Map<string, Set<string>>} */
  const packages = new Map();
  for (const entry of readdirSync(VIRTUAL_STORE)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    // Entries look like "<name>@<version>" plus optional peer-dependency
    // suffixes, e.g. "eslint@9.39.4_jiti@2.7.0" or "next@16.2.6(react@19.2.4)".
    // Scoped names are encoded with "+": "@scope+name@1.2.3".
    // The version always starts with a digit and ends at "_" or "(".
    const match = entry.match(/^(.+?)@(\d[^_()]*)/);
    if (!match) continue; // not a package dir (defensive)
    const name = match[1].replace("+", "/");
    const version = match[2];
    if (!packages.has(name)) packages.set(name, new Set());
    packages.get(name).add(version);
  }
  return packages;
}

async function fetchPackument(name) {
  const url = `${REGISTRY}/${name.replace("/", "%2F")}`;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/vnd.npm.install-v1+json" },
      });
      if (res.ok) return await res.json();
      if (res.status === 404) {
        throw new Error(`not found on registry (404)`);
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      if (String(err).includes("404")) throw err;
    }
    await new Promise((r) => setTimeout(r, attempt * 500));
  }
  throw lastError;
}

const installed = collectInstalledPackages();
const names = [...installed.keys()].sort();
console.log(
  `Checking ${[...installed.values()].reduce((n, s) => n + s.size, 0)} installed package versions (${names.length} unique packages) for deprecation...`,
);

/** @type {{name: string, version: string, message: string}[]} */
const deprecated = [];
/** @type {{name: string, error: string}[]} */
const failures = [];

let cursor = 0;
async function worker() {
  while (cursor < names.length) {
    const name = names[cursor++];
    try {
      const packument = await fetchPackument(name);
      for (const version of [...installed.get(name)].sort()) {
        const meta = packument.versions?.[version];
        if (!meta) {
          failures.push({
            name,
            error: `installed version ${version} missing from registry packument`,
          });
          continue;
        }
        // npm encodes deprecation as a non-empty string message.
        if (typeof meta.deprecated === "string" && meta.deprecated.length > 0) {
          deprecated.push({ name, version, message: meta.deprecated });
        }
      }
    } catch (err) {
      failures.push({ name, error: String(err?.message ?? err) });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

deprecated.sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);
failures.sort((a, b) => a.name.localeCompare(b.name));

if (failures.length > 0) {
  console.error(`\nregistry lookup failures (${failures.length}):`);
  for (const f of failures) console.error(`  ${f.name}: ${f.error}`);
}

if (deprecated.length > 0) {
  console.error(`\nDEPRECATED packages found (${deprecated.length}):`);
  for (const d of deprecated) {
    console.error(`  ${d.name}@${d.version} — ${d.message}`);
  }
}

if (deprecated.length > 0 || failures.length > 0) {
  console.error("\nFAIL: zero-deprecated gate not satisfied.");
  process.exit(1);
}

console.log("PASS: no deprecated packages at any depth.");
