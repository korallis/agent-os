#!/usr/bin/env node
/** agentos — thin CLI for daemon lifecycle + doctor (master plan piece #4). */
import { main } from "../cli.js";
main(process.argv.slice(2)).catch((error) => {
    console.error("agentos:", error);
    process.exit(1);
});
