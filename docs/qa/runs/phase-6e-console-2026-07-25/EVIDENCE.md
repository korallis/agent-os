# Phase 6e evidence — Console remainder (2026-07-25)

Captured by `tooling/evidence/capture-console.mjs` and `capture-escalations.mjs` against a
**real `agentosd`**, with state seeded through the product's own REST + Brain tool surface.
Only the model is simulated; the event log, projection, SSE, tool surface, gate runner,
worktree leasing, tmux and quota probes are all shipped code paths.

`tooling/gates/phase-6.mjs`: **14/14**.

## What this slice closes

| Criterion | Proof | Artifact |
| --- | --- | --- |
| Network I/O Detail (Figma `41:4815`) | A **real** `GET https://openrouter.ai/api/v1/key` → `401` in 21 ms with the actual response body | `network-io-detail.png` |
| Credentials never enter the durable log | The Authorization row reads `Bearer ****1234`; G12 asserts the canary key is absent from the recorded frame **and** the rendered page | `network-io-detail.png` |
| Per-phase timings are not fabricated | DNS/TCP/TLS/processing/transfer render `—` with the reason stated, because `fetch` does not expose them | `network-io-detail.png` |
| ◆ diff-from-default is accurate | Compares effective vs **shipped** value — a layer that restates a default is not marked | `policies.png` |
| Safety writes need confirmation | Daemon refuses an unconfirmed write with **428**; confirmed write returns 200 (G13) | `policies.png` |
| Weakened safety stays visible | A disabled policy raises a **persistent** badge, not a toast | `policies.png` |
| Three-way prompt diff | Shipped-at-install (hash only — install text is deliberately not retained), shipped-now, your copy | `policies.png` |
| Four quota archetypes | weekly-window, limit-reached, best-effort, balance-split all render distinctly | `providers.png` |
| LIMIT REACHED states its reason | Pill plus "Excluded from casts — weekly plan window exhausted" | `providers.png` |
| Usage strip is live | Reflects `quota.updated` over SSE in **12 ms** (was a 30 s poll) | `analytics.png` |
| Escalations surface everywhere | Alerts, needs-you queue, dashboard tile, task banner | `panel-escalation-*.png` |

## Honesty notes

- The Network I/O timeline shows five unmeasured phases as `—`. Showing five plausible numbers
  that sum to the measured total would be invented data — the exact failure this Console is
  built to avoid.
- The three-way diff renders the install-time side as a **hash**, because the install bytes are
  not retained. Reconstructing them would be a fabrication dressed as evidence.
- Empty states in this pack are the real empty states of a young fleet, kept deliberately.
