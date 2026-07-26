#!/usr/bin/env node
/**
 * Every gate must exit AFTER its cleanup has run, never from inside the `try`.
 *
 * Node does not unwind a `finally` block across `process.exit()`. A gate that
 * calls `process.exit()` while still inside `try { … } finally { … }` therefore
 * skips the block that kills its daemon, its tmux server and its temp home — on
 * every run, including the ones that pass. The orphans accumulate silently and
 * starve later gates of CPU and ports, which does not surface as "the machine is
 * loaded"; it surfaces as an unrelated gate reporting a plausible-looking
 * failure. That is the worst possible failure mode for evidence infrastructure:
 * a red result that points at the wrong thing.
 *
 * We hit exactly this — 43 orphaned daemons made `phase-6.mjs` report 7/14, and
 * a rerun on a clean machine gave 14/14. Fixing the six affected gates does not
 * stop the seventh from being written the same way, so the rule is enforced
 * here rather than remembered.
 *
 * The rule: in a gate that has a top-level `finally`, no `process.exit()` may
 * appear before that `finally` closes. Set an `exitCode` variable and call
 * `process.exit(exitCode)` after the block instead (see any gate in
 * tooling/gates for the shape).
 *
 * Usage: node scripts/verify-gate-cleanup.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_DIR = join(ROOT, "tooling", "gates");

/**
 * Strip the contents of template literals, quoted strings and comments.
 *
 * Gates legitimately embed `process.exit(1)` inside gate-source strings that are
 * written to disk and run as a CHILD process — that child exiting is the point,
 * and it has no bearing on the parent's cleanup. Blanking those regions (rather
 * than deleting them) keeps every line number intact so the diagnostic below
 * points at the real line in the real file.
 */
function blankNonCode(source) {
  const out = source.split("");
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      let end = source.indexOf("\n", i);
      if (end === -1) end = source.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const violations = [];
const checked = [];

for (const name of readdirSync(GATE_DIR).sort()) {
  if (!name.endsWith(".mjs")) continue;
  const path = join(GATE_DIR, name);
  const code = blankNonCode(readFileSync(path, "utf8"));
  const lines = code.split("\n");

  // A top-level `finally` — column 0, so not one nested inside a function.
  const finallyLine = lines.findIndex((line) => /^\}\s*finally\s*\{/.test(line));
  if (finallyLine === -1) {
    checked.push(`${name} (no top-level finally)`);
    continue;
  }
  // Where that block closes: the next column-0 `}`.
  let closeLine = lines.length - 1;
  for (let n = finallyLine + 1; n < lines.length; n += 1) {
    if (/^\}/.test(lines[n])) {
      closeLine = n;
      break;
    }
  }

  for (let n = 0; n <= closeLine; n += 1) {
    if (/process\.exit\s*\(/.test(lines[n])) {
      violations.push(
        `${name}:${n + 1} — process.exit() before the finally block closes ` +
          `(line ${closeLine + 1}); cleanup is skipped and the daemon leaks`,
      );
    }
  }
  checked.push(`${name} (exits after cleanup)`);
}

for (const line of checked) console.log(`  ok  ${line}`);

if (violations.length > 0) {
  console.error(`\n${violations.length} gate(s) exit before cleanup runs:\n`);
  for (const violation of violations) console.error(`  FAIL  ${violation}`);
  console.error(
    "\nSet `let exitCode = 0`, assign it in try/catch, and call " +
      "`process.exit(exitCode)` AFTER the try/finally.\n",
  );
  process.exit(1);
}

console.log(`\n${checked.length} gates checked, all exit after cleanup`);
