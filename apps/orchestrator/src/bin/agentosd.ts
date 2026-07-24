#!/usr/bin/env node
/** agentosd — the Agent OS daemon (foreground). */
import { runStart } from "../cli.js";

runStart().catch((error: unknown) => {
  console.error("agentosd failed to start:", error);
  process.exit(1);
});
