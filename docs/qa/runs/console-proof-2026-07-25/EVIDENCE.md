# Console proof pack — 2026-07-25

Screenshots of the shipped Console running against a **real `agentosd`**, captured by
[`tooling/evidence/capture-console.mjs`](../../../../tooling/evidence/capture-console.mjs).

## Capture method

The harness boots a real daemon on a throwaway `AGENTOS_HOME`, seeds state **through the
product's own REST and Brain tool surface** (never by writing fixtures to disk), starts the
**production Console build** (`next start`) against it, and screenshots each page.

Only the model is simulated (`AGENTOS_FAKE_PI` / `AGENTOS_FAKE_BRAIN` / `AGENTOS_FAKE_GATE`).
Everything else is the shipped code path: the append-only event log, the SQLite projection,
SSE, the typed tool surface, transition legality, the gate runner, worktree leasing, tmux
windows, quota probes, and the analytics derivation.

Every seeding tool call is **checked** — a call that comes back not-ok aborts the capture, so
a screenshot of an empty state can never be passed off as a working screen. The one deliberate
exception is the `GATE_ERROR` run, which is *expected* to fail and is captured precisely to
show that the Console distinguishes it from a RED verdict.

## What was seeded

| Task | Purpose |
| --- | --- |
| "Add retry budget to the fetch client" | Cross-family cast, RED baseline proved, then a real `FAIL` and a real `GATE_ERROR` |
| "Choose the cache eviction strategy" | Clean-room `/opinion` fusion across two families |
| "Document the daemon event contract" | Delivered to `DONE`, so throughput and success rate are real |

Plus a registered project on a real git repo, a provider connection with a live quota probe,
and a Captain escalation so the wake queue and alerts have real rows.

## Screens

### Fleet & tasks

| Screen | What it proves |
| --- | --- |
| `fleet-dashboard.png` | Brain `running`, live counts, recent tasks from the projection |
| `tasks.png` | Task list with shape, phase and timestamps |
| `task-detail-validation.png` | **`EXPECTED_RED` → `FAIL` → `GATE_ERROR`**, with `GATE_ERROR` labelled "no attempt consumed"; Brain decision lane showing 7 tool calls, 1 refused by the substrate |
| `task-detail-fusion.png` | **`CLEAN-ROOM ✓ identical prompts`** with the *same* prompt hash (`7daeb64b764c`) on both sides, separate sessions, cross-family |
| `session-detail.png` | Seat model, tmux pane, display-only attach command, agent log |
| `projects.png` | Registered project and trust state |

### Usage, cost, and honesty

| Screen | What it proves |
| --- | --- |
| `analytics.png` | 768 tokens / 4 requests derived from the log; **Total Spend renders "—  not reported by providers"** rather than `$0.00`; Billing Surface & Brain Overhead card shows **`reconciles ±0`** with surfaces summing to the totals (576 + 192 = 768) |
| `analytics-models.png` | Measured per-model telemetry only — not a quality leaderboard |
| `providers.png` | Quota cards with honesty tiers (`≈ ESTIMATE`) and stated reasons (`probe HTTP 401`, `no readable credential for probe`) |
| `settings-billing.png` | Billing surfaces, measured spend, budget ceilings — no invoice or plan fiction |

### Operations

| Screen | What it proves |
| --- | --- |
| `runs.png` | Live event stream |
| `runs-history.png` | Run history counting `FAIL` and `GATE_ERROR` apart |
| `alerts.png` | Actionable alerts from type-filtered event replay |
| `notifications.png` | Brain wake queue including zero-token `ABSORBED` wakes |
| `policies.png` | Layered config with per-key source and diff-from-default marks |
| `settings.png`, `onboarding.png` | Workspace settings; first-run wizard against real Pi detection |

### Responsive

`fleet-mobile.png`, `notifications-mobile.png` at 390×844.

## Honesty note

Several panels render empty states in this capture (for example "No agent telemetry yet"
before crewmates report usage). Those are the **real** empty states of a young fleet, kept in
the pack deliberately — a screenshot that only ever shows a full dashboard would hide how the
product behaves on day one.

`manifest.json` records the seeded ids and the HTTP status of every captured page.
