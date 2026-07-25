/**
 * Env hygiene at spawn (master plan §4.8).
 * Allowlist-built env, ≤1 provider key matching the cast, shell: false.
 */
/** Provider API key env names Pi / SDKs may honor. */
export const PROVIDER_KEY_ENV_NAMES = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "XAI_API_KEY",
    "GROQ_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "MOONSHOT_API_KEY",
    "KIMI_API_KEY",
    "VERCEL_AI_GATEWAY_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AZURE_OPENAI_API_KEY",
];
/** Base env keys always allowed through to a spawned Pi. */
const BASE_ALLOWLIST = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "SHELL",
    "SSH_AUTH_SOCK",
    // Path fence vars (AGENTOS_HOME, AGENTOS_SEAT_WORKSPACE, AGENTOS_GATE_WORKSPACE)
    // and session dirs are granted only via extraAllow — never ambient parent env.
    // Signing keys are never env values.
    "AGENTOS_SESSION_ID",
    "AGENTOS_SOCKET",
    "AGENTOS_ROLE",
    "PI_CONFIG_DIR",
    "PI_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
]);
/**
 * Builds a spawn env from the parent process env + explicit grants.
 * Strips all provider keys except the single granted one (if any).
 */
export function scrubEnv(parent, options = {}) {
    const env = {};
    for (const [key, value] of Object.entries(parent)) {
        if (value === undefined)
            continue;
        if (BASE_ALLOWLIST.has(key)) {
            env[key] = value;
        }
    }
    if (options.extraAllow !== undefined) {
        for (const [key, value] of Object.entries(options.extraAllow)) {
            env[key] = value;
        }
    }
    // Explicitly strip every provider key, then re-grant at most one.
    for (const name of PROVIDER_KEY_ENV_NAMES) {
        delete env[name];
    }
    const grant = options.grantProviderKey ?? null;
    if (grant !== null) {
        env[grant.name] = grant.value;
    }
    const providerKeysPresent = PROVIDER_KEY_ENV_NAMES.filter((name) => env[name] !== undefined);
    if (options.assertSingle !== false && providerKeysPresent.length > 1) {
        throw new EnvHygieneError(`assertSingleProviderKey failed: found ${providerKeysPresent.join(", ")}`, providerKeysPresent);
    }
    return {
        env,
        envKeys: Object.keys(env).sort(),
        providerKeysPresent: [...providerKeysPresent],
    };
}
export class EnvHygieneError extends Error {
    providerKeys;
    code = "ENV_HYGIENE";
    constructor(message, providerKeys) {
        super(message);
        this.providerKeys = providerKeys;
        this.name = "EnvHygieneError";
    }
}
/**
 * Subscription-sdk path: ambient ANTHROPIC_API_KEY must be absent (§4.10 Step 2a).
 */
export function assertNoAmbientAnthropicKey(env = process.env) {
    if (env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY.length > 0) {
        throw new EnvHygieneError("ANTHROPIC_API_KEY is set — subscription-sdk path would silently switch to API billing", ["ANTHROPIC_API_KEY"]);
    }
}
