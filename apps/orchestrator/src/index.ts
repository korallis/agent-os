/** apps/orchestrator — agentosd: deterministic substrate + policy enforcer. */
export { startDaemon, SHIPPED_DEFAULTS_DIR, type DaemonOptions, type RunningDaemon } from "./daemon.js";
export { buildServer, type ServerDeps } from "./server/app.js";
export { ConfigService, ConfigWriteError } from "./config/service.js";
export {
  resolveAll,
  resolveDomain,
  loadLayerFile,
  leafPaths,
  sha256,
  type ResolveAllOptions,
  type ResolveAllResult,
  type ResolvedDomain,
  type LayerRejection,
} from "./config/resolver.js";
export { ensureHome, homePaths, readToken, resolveHome, type HomePaths } from "./home.js";
export { runDoctor, formatDoctorReport, type DoctorCheck } from "./doctor.js";
export { AGENTOSD_VERSION, DEFAULT_PORT, LOOPBACK_HOST } from "./version.js";
