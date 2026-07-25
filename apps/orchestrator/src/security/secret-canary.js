/**
 * Secret canary helpers (master plan §11 Phase 2 + §12 security).
 * Seeded canary tokens must never appear in durable logs, events, or SSE.
 */
export const SECRET_CANARY = "agentos-canary-secret-DO-NOT-LEAK-7f3a9c";
const CANARY_PATTERNS = [
    /sk-[a-zA-Z0-9]{20,}/g,
    /sk-ant-[a-zA-Z0-9\-_]{20,}/g,
    /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi,
    new RegExp(SECRET_CANARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
];
/** Returns true if any secret-like material is found in the text. */
export function containsSecretMaterial(text) {
    for (const pattern of CANARY_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(text))
            return true;
    }
    return false;
}
/** Redact known secret patterns for defensive log scrubbing. */
export function scrubSecrets(text) {
    let out = text;
    for (const pattern of CANARY_PATTERNS) {
        out = out.replace(pattern, "[REDACTED]");
    }
    return out;
}
/** Scan an object graph (JSON-serializable) for canary / token material. */
export function scanForSecrets(value, path = "") {
    const hits = [];
    if (typeof value === "string") {
        if (containsSecretMaterial(value))
            hits.push(path || "(root)");
        return hits;
    }
    if (Array.isArray(value)) {
        value.forEach((item, i) => hits.push(...scanForSecrets(item, `${path}[${i}]`)));
        return hits;
    }
    if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) {
            const childPath = path.length > 0 ? `${path}.${key}` : key;
            hits.push(...scanForSecrets(child, childPath));
        }
    }
    return hits;
}
