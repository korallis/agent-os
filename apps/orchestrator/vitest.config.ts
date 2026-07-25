import { defineConfig } from "vitest/config";

/**
 * These suites boot real daemons (event store replay, socket listeners, config
 * watchers) rather than mocking them, so setup/teardown is I/O-bound. The
 * default 10 s hook budget is tight when CI runs the Next builds concurrently.
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
