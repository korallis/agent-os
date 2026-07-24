# Phase 1 — Figma UI Replication Evidence

- **Date:** 2026-07-24
- **Branch:** `phase-1/daemon-console-shell`
- **Verdict:** PASS
- **Capture method:** Playwright (headless Chromium), 1440×1024 viewport (the Figma frame size), against the **production** console build (`next build` + `next start -H 127.0.0.1`) talking to a **real agentosd daemon** (`AGENTOS_HOME` pointed at a temp dir) through the token-guarded BFF. Figma references exported via the Figma MCP (`get_screenshot`).

## Acceptance source

Captain's directive: the product frontend must **exactly replicate** the Figma file
"AgentOS — AI Agent Orchestration Dashboard" (`Ria7UpyEPRd9jNlF9B6xgF`), with live
Phase 1 data wired wherever the design shows dynamic values, and all Phase 1
functionality intact (8 routes, SSE live feed, daemon status, effective-config
view, token-guarded BFF, SSE-under-500ms gate).

## Screen ↔ Figma node ↔ artifact

| Route | Figma screen (node) | Reference | Implementation | Live data |
| --- | --- | --- | --- | --- |
| `/fleet` | Home Dashboard (`10:11978`) | `fleet-dashboard-figma.png` | `fleet-dashboard-impl.png` | "Last updated" ← newest daemon event; bell dot ← daemon health |
| `/runs` | Live Log Stream (`41:3973`) | `runs-log-stream-figma.png` | `runs-log-stream-impl.png` | **Fully live**: rows are real SSE events (daemon.started, config.installed, config hot-reload); STREAMING pill = stream state; filters/pause/search/detail panel operate on live events |
| `/policies` | Settings modal layout (`41:6672`, adapted) | `policies-config-figma.png` | `policies-config-impl.png` | **Fully live**: `/v1/config/effective` — the screenshot shows `heartbeatSeconds: 19` with a green **global** source chip after a real hot-reload edit; other keys show **shipped** |
| `/settings` | Settings: Workspace (`41:6672`) | `settings-workspace-figma.png` | `settings-workspace-impl.png` | Real infra values (home, locked bind, token path); form static |
| `/providers` | Settings: API Providers (`41:6186`) | `providers-api-figma.png` | `providers-api-impl.png` | Static placeholder (provider wiring: Phase 2) |
| `/tasks` | Inference Jobs (`41:2412`) | `tasks-inference-jobs-figma.png` | `tasks-inference-jobs-impl.png` | Static placeholder (task engine: Phase 2) |
| `/analytics` | Token Usage (`37:2265`) | `analytics-token-usage-figma.png` | `analytics-token-usage-impl.png` | Static placeholder (quota probes: Phase 2) |
| `/projects` | Workflow List (`41:6896`) | `projects-workflows-figma.png` | `projects-workflows-impl.png` | Static placeholder (project registry: Phase 3) |

`/` redirects to `/fleet` (unchanged). The Figma file has no mobile frames, so
captures are desktop-only at the design's native 1440px width.

## Functional gates

- **SSE under 500 ms:** `tooling/gates/phase-1.mjs` G3 — *"state change reflects
  over SSE within 500 ms — **17ms**"* (9/9 gates green on this branch).
- **Live event feed:** `runs-log-stream-impl.png` shows the real
  `config hot-reloaded — supervision from global layer` event that the capture
  script triggered by editing `$AGENTOS_HOME/config/supervision.json5`, with the
  detail panel rendering the event's payload (layer `global`, contentHash).
- **Token-guarded BFF:** the console was served on `127.0.0.1:3111` with
  `AGENTOS_HOME` pointing at the temp daemon home; the browser only ever spoke to
  `/api/agentos/*` (bearer attached server-side; daemon rejects direct
  unauthenticated calls with 401).
- **All 33 vitest tests** and the no-deprecated scan pass on this branch.

## Assets and fidelity notes

- Every icon/image is the exact exported Figma asset, committed under
  `apps/console/public/figma/` (39 dashboard assets + screen-specific icons).
  Monochrome icons render through CSS masks so active/inactive states re-tint the
  exact exported geometry.
- Typography per the file: Inter (UI) + JetBrains Mono (logs/IDs) via
  `next/font/google`; the design's token set (#0a0a0a/#141414/#1a1a1a surfaces,
  #222/#333 lines, #f5f5f5/#999/#666/#4a4a4a text, #2dd4bf teal, status colors)
  added to `packages/ui` `theme.css`.
- Screens in the file without a Phase 1 product surface (auth, KB, GPU clusters,
  pricing/checkout, modals, agent detail, etc. — 45 frames total) are deferred to
  the phases that own those features; the 8 shipped routes cover every Phase 1
  surface.

## How to re-run

```sh
pnpm install && pnpm build
AGENTOS_HOME=$(mktemp -d) node apps/orchestrator/dist/bin/agentosd.js &
AGENTOS_HOME=<same dir> pnpm --filter @agent-os/console start   # 127.0.0.1:3111
# edit $AGENTOS_HOME/config/supervision.json5 to see live hot-reload events
# capture /fleet /runs /policies /settings /providers /tasks /analytics /projects at 1440×1024
```
