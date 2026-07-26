# Agent OS — Evaluation & Recommendations

Evaluation date: 2026-07-25. Read-only review; no code was changed. Verified locally: build 9/9, typecheck clean, lint 0 errors (19 warnings — unused vars in marketing), tests 13/13 packages passing (orchestrator: 161 tests).

## What this is

A local-first, single-user agent orchestration system: a Fastify daemon (`agentosd`) that spawns/supervises AI coding agents through the Pi harness in tmux windows, an LLM "Brain" that makes judgment calls through a typed tool surface, an append-only NDJSON event log with SQLite projection, a Next.js operator console, and a Next.js marketing site. A 1,566-line master plan drives development through executable phase gates, all enforced in CI.

## Overall verdict

This is an unusually disciplined codebase — the backend engineering is genuinely strong, and the "evidence, not prose" culture (kill-9 recovery proofs, HMAC-signed gate proofs, honesty-tier UI) is real, not decorative. The weak spots are concentrated and fixable: **event-loop blocking in the daemon**, **a telemetry-severing reconnect bug**, **unbounded in-memory growth**, and a **marketing site that lags the rest of the repo significantly**. Plan-vs-reality drift is also starting to show.

## Strengths worth protecting

- **Fail-closed design everywhere**: missing Pi → typed `PI_UNAVAILABLE`, never a silent stub; gate infra failure is never a RED verdict; done-state only via one choke point (`tool-surface.ts:2945-2968`).
- **Crash recovery is designed in**: durable RED proofs re-verified (never re-signed) on hydrate, handoff cooldowns survive restart, kill-9 tests with real SIGKILL'd writers (`event-store/test/kill9.test.ts`).
- **Security defaults as code**: loopback-locked bind, timing-safe bearer compare, origin checks, 0600/0700 on every secret, single-use PTY tickets, env allowlists for spawned agents. The console never exposes the daemon token to the browser.
- **Honest telemetry discipline**: null cost never renders as $0.00; truncation flags propagate to the UI. The QA evidence packs under `docs/qa/runs/` are substantive.
- **CI is comprehensive**: typecheck → lint → build → test → deprecated-dep scan → phase gates 1–6 + 8 with real daemon boots.
- Zero `any`, zero TODO/FIXME, zero lint suppressions repo-wide — verified.

## Recommendations

### High priority

1. **Move subprocess calls off the daemon event loop.** `GateRunner.run` uses `spawnSync` with a default 300s timeout (`apps/orchestrator/src/fleet/gate-runner.ts:338-351`) invoked synchronously from REST and extension-frame paths — one gate run freezes all REST, SSE, quota probes, and supervision for up to 5 minutes. Same pattern with tmux (10s), git worktree add (60s), and ~6 sequential git calls in `deliverTask` (`tool-surface.ts:2774-2815`). Convert to async spawn or a worker pool. This is the single biggest reliability risk.

2. **Fix the pi-extension reconnect death bug.** On a connected socket's close, one reconnect attempt is scheduled; if it fails, the `this.socket === socket` check at `packages/pi-extension/src/extension.ts:119-124` never matches and no further retry is scheduled — the session silently loses telemetry forever after a single >250ms daemon outage. Compounded by the unbounded `pending` buffer (`extension.ts:189-195`). Add a persistent retry loop and bound the buffer.

3. **Bound all in-memory growth.** Unbounded: `WakeWatcher.history`/`queue` (`watcher.ts:24-25`), idempotency maps (`tool-surface.ts:177-178`), `pendingToolResults` (`service.ts:104`), SSE `liveBuffer` (`app.ts:1088-1095`), and the SocketHub read buffer (no newline cap, `socket-hub.ts:160-165`). A long-running daemon will grow until it doesn't.

4. **Validate route params on the fusion endpoints.** `GET /v1/tasks/:id/fusion/:runId` passes raw params into a path join with no ULID validation (`app.ts:493-515` → `fusion-runs.ts:37-45`) — an arbitrary-read primitive for a token holder, and it violates the codebase's own validate-at-the-edge convention (the sibling tool inputs are ULID-validated).

5. **Scale debt in the event log.** Every boot JSON-parses the entire NDJSON log even when the projection is current (`event-store/src/store.ts:58`); each `/v1/analytics` request scans up to 100k events with no caching (`daemon.ts:242-272`); replay applies one transaction per event. Fine today, painful at 100k+ events. Also: nothing enforces single-writer on `events.ndjson` — a second daemon on the same home produces duplicates that get misclassified as "corrupt tail" and quarantined.

### Medium priority

6. **Resolve the Phase 2 plan mismatch.** All 12 Phase 2 checkboxes in the master plan are unchecked, yet `tooling/gates/phase-2.mjs` exists with lighter gates and CI runs it. Either Phase 2 is genuinely incomplete (real OAuth probes, telemetry metering, wizard install) or the plan wasn't updated — pick one and reconcile, because every other phase carries a "shipped" annotation.

7. **Wire or delete the dead backend modules.** `PiAuthBroker`, `SecondmateRegistry`, `SelfUpdater`, `secret-canary` scrubbing, and several helpers have no production call sites. They carry tests and security-adjacent comments, which makes their deadness actively misleading.

8. **Decide and document the capability grants.** Brain-authored gates run as the user with full fs/network (env scrubbing is hygiene, not a sandbox — `gate-runner.ts`), and `SSH_AUTH_SOCK` is passed to every spawned crewmate (`env-scrub.ts:42`), giving every AI worker git-push capability. Both may be intended; neither is documented or configurable. Also add a loud startup warning when any `AGENTOS_FAKE_*` flag is set — `AGENTOS_FAKE_GIT=1` silently skips all clean-tree delivery checks.

9. **Console: share one SSE connection per page.** Task detail and analytics each open 3 `EventSource` connections to the same stream — half the browser's HTTP/1.1 per-host connection budget on duplicates. Add a context-shared stream. Also virtualize or memo `LogStream` (500 rows re-render per SSE frame, `LogStream.tsx:334-344`), and zod-validate REST responses the way SSE already is — the ~27 `as {…}` casts are a silent-drift boundary.

10. **Marketing site needs a remediation pass.** It's well behind the rest of the repo:
    - All 13 pages are `"use client"` → no per-page metadata, OG images, or sitemap. Split server wrappers so SEO exists.
    - 16.5 MB hero video with `preload="auto"`, autoplay, no poster (`page.tsx:225-233`) — compress it.
    - No `prefers-reduced-motion` support in Lenis or framer-motion; nested `<main>` landmarks; multiple `<h1>`s; FAQ/menu buttons missing `aria-expanded`; pervasive tiny low-opacity text that likely fails WCAG AA.
    - Dead surface area: `/privacy` and `/terms` footer links 404, newsletter/contact forms fake success, `ResourceCard` is inert. Notably, the marketing site presents **fabricated customer testimonials as real** (`lib/data/customers.ts:10-51`) — which contradicts the honesty discipline the product itself enforces.
    - Agent data is defined three times with mismatched slug schemes; ~15 dead exports/files (matches the 19 lint warnings).

11. **Sweep the security-claim docstrings.** Repeated doc-vs-code mismatches: protocol claims frames are "zod-validated both ways" (inbound isn't), `familyOfClaudeAgentSdkModel` claims "always anthropic" but isn't, `PROTOCOL_VERSION` says `"1.2.0-phase3"` at Phase 6e. These comments carry security weight — they should be true.

### Lower priority

12. **Add tests where they're missing**: **`protocol` suite — closed** (status owner: master plan Phase 13; code: `packages/protocol/test/`, fail-closed `familiesConflict` in `packages/protocol/src/providers.ts` §6.2). Still open at review time: pi-extension's reconnect/pending/inbound-dispatch paths (exactly where the bug lives); orchestrator's `OnboardingService` (579 lines) has no suite.

13. **Process hygiene**: commit or drop the staged `react-doctor.yml` (currently uncommitted and advisory-only); note that the product is macOS-only but CI runs Ubuntu, so launchd/Keychain paths are never exercised; the Phase 6 Figma-fidelity gate is still unchecked — side-by-sides exist only for the 8 Phase-1 routes; align `@types/node` versions across apps (20.x in marketing, 26.x in console).

14. **Minor bugs worth a quick pass**: identical ternary branches at `tool-surface.ts:748`; negative `limit` accepted at `app.ts:557`; lowercase `{{vars}}` silently pass through `fusion-core` templates contradicting its "never silently empty" contract; multi-byte UTF-8 split across socket chunks will corrupt frames in pi-extension (`extension.ts:125`); silent permanent eviction of event-store listeners that throw once (`store.ts:96-101`).

## Suggested order

Start with #1 and #2 — they're the only findings that can silently break a running system for a user. Then #3–#5 as one robustness pass on the daemon. The marketing remediation (#10) is independent and parallelizable. Everything else batches naturally into a "plan reconciliation + dead code + docs" cleanup PR.

Caveat: the build/test/lint state and repo structure were verified directly; the specific file:line findings come from focused code inspection per area, so spot-check before scheduling — but the pattern consistency across independent areas (unbounded buffers, doc drift, dead code) suggests they're reliable.
