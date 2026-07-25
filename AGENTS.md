<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `apps/marketing/node_modules/next/dist/docs/` or `apps/console/node_modules/next/dist/docs/` (or the Next.js package docs under the app that depends on Next) before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Learned User Preferences

- Product UI must exactly replicate the Captain's Figma file (`fileKey` `Ria7UpyEPRd9jNlF9B6xgF`); that file is the canonical UI specification.
- Every build phase ships through a no-mistakes-validated pull request.
- Merge phase PRs when CI is green using a merge commit (not squash).
- Use parallel subagents when safe; prefer Grok 4.5 for worker subagents.
- TypeScript `any` is forbidden; do not introduce deprecated packages or dependencies at any level.
- Build worker execution around Pi as the **default** backend harness; use Pi hooks so the user always has live visibility. **Superseded 2026-07-26 [R8]:** the harness is now the Captain's choice per model — Claude Code, Codex CLI, Kimi CLI, OpenCode or Pi — scoped as Phase 12 in the master plan. Pi stays the default and the capability baseline; every other adapter must DECLARE what it cannot do (cost telemetry, session-dir isolation and the byte-identical clean-room proof all degrade off Pi) so absence renders as a stated absence rather than a blank that reads like zero.

## Learned Workspace Facts

- Public GitHub repo: [github.com/korallis/agent-os](https://github.com/korallis/agent-os).
- Workspace is a pnpm + Turborepo monorepo (`apps/marketing`, `apps/console`, `apps/orchestrator`, shared `packages/*`).
- Product build source of truth: `docs/plans/agent-os-master-plan.md`.
