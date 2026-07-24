# Phase 0 Monorepo Foundation — Browser Evidence

- **Date:** 2026-07-24
- **Branch:** `phase-0/monorepo-foundation` (PR #1)
- **Verdict:** PASS
- **Capture method:** Playwright (headless Chromium) against the production build — `pnpm --filter @agent-os/marketing build` then `next start` on port 3111, from a clean checkout of the PR head.

## Acceptance source

Master plan Phase 0 (`docs/plans/agent-os-master-plan.md`, Revision 6.1): the existing
marketing site is migrated **verbatim** into `apps/marketing` inside the new pnpm +
Turborepo monorepo, with the design system extracted to `packages/ui`. Acceptance
criterion: the site builds and renders with visual/content parity after the move —
no redesign.

## Criterion ↔ assertion ↔ artifact

| Criterion (from plan) | Assertion | Artifact |
| --- | --- | --- |
| Site builds and serves from `apps/marketing` in the monorepo | Production build + `next start` returns HTTP 200 on all captured routes | all screenshots (each capture asserted `status=200`) |
| Homepage renders with parity (hero, nav, CTAs) | Hero headline "Next-Gen AI Agents", nav, Get started/Explore CTAs, hero media visible at 1440px | `home-desktop.png` |
| Agents index renders (incl. design-system typography from `packages/ui`) | "Meet the Agents That Move Work Forward" hero, gradient display type, CTAs | `agents-desktop.png` |
| Pricing renders (data-driven cards) | Starter $29 / Pro $99 (Popular) / Enterprise Custom cards with feature lists | `pricing-desktop.png` |
| Platform route renders | Platform page hero and content at 1440px | `platform-desktop.png` |
| Responsive layout intact at mobile width | Homepage and pricing render correctly at 390px (stacked hero, menu button, full-width CTAs) | `home-mobile.png`, `pricing-mobile.png` |

## Known gaps (deliberate, reported)

- Footer Privacy/Terms links point to `/privacy` and `/terms`, which have no routes and
  404. These links exist in the source site; adding legal pages or removing the links
  would violate the verbatim-migration criterion. Flagged by the no-mistakes review
  (finding `footer-privacy-terms-404`) and deferred to a later content pass.

## How to re-run

```sh
pnpm install
pnpm --filter @agent-os/marketing build
PORT=3111 pnpm --filter @agent-os/marketing start
# capture /, /agents, /pricing, /platform at 1440x900 and /, /pricing at 390x844
```
