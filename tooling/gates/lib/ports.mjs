/**
 * Safe random port selection for gates.
 *
 * Chromium refuses to navigate to a set of "restricted" ports and fails the
 * request with `net::ERR_UNSAFE_PORT` before it ever reaches the server. Gates
 * pick their daemon and console ports at random, so any run could land on one
 * and fail for a reason that has nothing to do with the product.
 *
 * This is not hypothetical. `phase-8.mjs` drew console port **4045** (`lockd`)
 * from its 4000–4059 range and G9 failed with:
 *
 *     page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:4045/fleet
 *
 * CI had been green only because it kept drawing safe ports. That is the same
 * class of defect as the daemon leak `scripts/verify-gate-cleanup.mjs` guards
 * against: gate infrastructure producing a red that points at the wrong thing,
 * which is worse than no signal because it sends someone hunting a bug that
 * does not exist.
 *
 * Rather than nudge the one offending range, `pickPort` rejects blocked ports
 * outright. A future gate choosing some other range is protected without its
 * author needing to know this list exists.
 */

/**
 * Ports Chromium blocks outright.
 *
 * Mirrors the `kRestrictedPorts` table in Chromium's `net/base/port_util.cc`.
 * Ports below 1024 are unusable for a gate anyway, but they are kept here so
 * the list can be checked against upstream without a diff full of omissions.
 */
export const CHROMIUM_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
  10080,
]);

/** True when Chromium will refuse to navigate to this port. */
export function isBlockedPort(port) {
  return CHROMIUM_BLOCKED_PORTS.has(port);
}

/**
 * Pick a random port in `[base, base + span)`, skipping any Chromium blocks.
 *
 * Throws rather than returning a blocked port if the whole range is
 * unusable — a gate that silently fell back to a blocked port would
 * reintroduce exactly the failure this exists to prevent.
 */
export function pickPort(base, span) {
  if (!Number.isInteger(base) || !Number.isInteger(span) || span < 1) {
    throw new Error(`pickPort needs an integer base and a span >= 1, got ${base}/${span}`);
  }
  const candidates = [];
  for (let port = base; port < base + span; port += 1) {
    if (!isBlockedPort(port)) candidates.push(port);
  }
  if (candidates.length === 0) {
    throw new Error(
      `every port in [${base}, ${base + span}) is blocked by Chromium; pick another range`,
    );
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}
