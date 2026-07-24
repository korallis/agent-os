/** agentosd version — kept in lockstep with apps/orchestrator/package.json. */
export const AGENTOSD_VERSION = "0.1.0";

/** The canonical daemon port (master plan §2.1). Host is config-locked to loopback. */
export const DEFAULT_PORT = 4700;

/** Config-locked (§2.6 #13): the bind host is NEVER configurable. */
export const LOOPBACK_HOST = "127.0.0.1";
