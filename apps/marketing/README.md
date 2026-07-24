# @agent-os/marketing

Marketing website for Agent OS — an AI agent platform for building, deploying, and orchestrating intelligent agent teams.

This package lives in the Agent OS monorepo (`apps/marketing`). It depends on workspace packages (e.g. `@agent-os/ui`) and must be installed and run from the repository root.

Built with Next.js 16, Tailwind CSS v4, and Framer Motion.

## Prerequisites

- **Node.js** ≥ 24
- **pnpm** 10 (see root `packageManager` field)

## Getting Started

From the **repository root** (not this directory alone):

1. **Install dependencies**

```bash
pnpm install
```

2. **Run the marketing dev server**

```bash
pnpm --filter @agent-os/marketing dev
```

Or via Turborepo for all workspace `dev` tasks:

```bash
pnpm dev
```

3. **Open in your browser**

```
http://localhost:3000
```

The site hot-reloads as you edit files.

## Scripts

Run from the repo root with `pnpm --filter @agent-os/marketing <script>`, or use turbo (`pnpm lint`, `pnpm typecheck`, `pnpm build`).

| Command | Description |
|---------|-------------|
| `dev` | Start Next.js dev server |
| `build` | Create production build |
| `start` | Serve production build |
| `lint` | Run ESLint on this package |
| `typecheck` | Generate Next types (`next typegen`) then `tsc --noEmit` |

## Project Structure

```
apps/marketing/
  src/
    app/                    # Next.js App Router pages
      page.tsx              # Homepage
      agents/               # Agents list + [slug] detail
      platform/             # Platform page
      workflows/            # Workflows page
      use-cases/            # Use Cases page
      pricing/              # Pricing page
      contact/              # Contact page
      security/             # Security page
      integrations/         # Integrations page
      customers/            # Customers page
      resources/            # Resources page
      layout.tsx            # Root layout
      globals.css           # Global styles (Tailwind v4 + design tokens)
    components/
      layout/               # Header, Footer, LenisProvider, PageTransition
      sections/             # Shared section components
      ui/                   # Marketing-local UI components
    lib/
      data/                 # Static data (agents, pricing, integrations, etc.)
  public/                   # Static assets (images, videos)
  next.config.ts
  package.json
```

Shared design system (fonts, theme CSS, motion variants, shared UI) lives in `packages/ui` and is imported as `@agent-os/ui`.

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Styling**: Tailwind CSS v4 (tokens via `@agent-os/ui`)
- **Animations**: Framer Motion
- **Smooth Scroll**: Lenis
- **Typography**: Geist Sans + Geist Mono (`@agent-os/ui/fonts`)
- **Language**: TypeScript
- **Monorepo**: pnpm workspaces + Turborepo

## Deployment

From the repository root:

```bash
pnpm --filter @agent-os/marketing build
pnpm --filter @agent-os/marketing start
```

Or deploy the marketing app to [Vercel](https://vercel.com) with the monorepo root as the project root and `apps/marketing` as the app directory.
