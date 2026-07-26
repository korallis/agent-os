#!/usr/bin/env node
/**
 * Gates must choose ports through `pickPort`, never by raw random arithmetic.
 *
 * Chromium refuses to navigate to a set of restricted ports, failing with
 * `net::ERR_UNSAFE_PORT` before the request reaches the server. A gate that
 * picks a port with `base + Math.floor(Math.random() * span)` can land on one,
 * and then fails for a reason that has nothing to do with the product.
 *
 * We hit this: `phase-8.mjs` drew console port 4045 (`lockd`) out of its
 * 4000–4059 range and G9 failed with `ERR_UNSAFE_PORT`. CI had been green only
 * because it kept drawing safe ports — which is the worst shape for a flake,
 * because it looks like a real regression on the run where it finally bites.
 *
 * Same reasoning as `verify-gate-cleanup.mjs`: fixing the offending ranges
 * does nothing to stop the next gate being written the same way, so the rule
 * is enforced here rather than remembered.
 *
 * Usage: node scripts/verify-gate-ports.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHROMIUM_BLOCKED_PORTS } from "../tooling/gates/lib/ports.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_DIR = join(ROOT, "tooling", "gates");

/** `const PORT = 4700 + Math.floor(Math.random() * 60)` and friends. */
const RAW_RANDOM_PORT = /(?:PORT|Port)\s*=\s*[^;\n]*Math\.random\(\)/;

/** A literal port assignment we can range-check directly. */
const LITERAL_PORT = /(?:PORT|Port)\s*=\s*(?:Number\([^)]*\?\?\s*)?(\d{2,5})/;

const violations = [];
const checked = [];

for (const name of readdirSync(GATE_DIR).sort()) {
  if (!name.endsWith(".mjs")) continue;
  const source = readFileSync(join(GATE_DIR, name), "utf8");
  const lines = source.split("\n");
  let clean = true;

  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;

    if (RAW_RANDOM_PORT.test(line)) {
      violations.push(
        `${name}:${index + 1} — port chosen by raw Math.random(); use pickPort() from ` +
          `tooling/gates/lib/ports.mjs so Chromium-blocked ports are skipped`,
      );
      clean = false;
      return;
    }

    const literal = LITERAL_PORT.exec(line);
    if (literal !== null) {
      const port = Number(literal[1]);
      if (CHROMIUM_BLOCKED_PORTS.has(port)) {
        violations.push(
          `${name}:${index + 1} — port ${port} is on Chromium's restricted list; ` +
            `navigation to it fails with ERR_UNSAFE_PORT`,
        );
        clean = false;
      }
    }
  });

  checked.push(`${name}${clean ? "" : " (VIOLATION)"}`);
}

for (const line of checked) console.log(`  ok  ${line}`);

if (violations.length > 0) {
  console.error(`\n${violations.length} gate port problem(s):\n`);
  for (const violation of violations) console.error(`  FAIL  ${violation}`);
  console.error(
    "\nImport { pickPort } from \"./lib/ports.mjs\" and call pickPort(base, span).\n",
  );
  process.exit(1);
}

console.log(`\n${checked.length} gates checked, all ports Chromium-safe`);
