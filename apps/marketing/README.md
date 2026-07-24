# Agent OS

Marketing website for Agent OS -- an AI agent platform for building, deploying, and orchestrating intelligent agent teams.

Built with Next.js 16, Tailwind CSS v4, and Framer Motion.

## Prerequisites

- **Node.js** 18.18 or later
- **npm** 9 or later

## Getting Started

1. **Install dependencies**

```bash
npm install
```

2. **Run the development server**

```bash
npm run dev
```

3. **Open in your browser**

```
http://localhost:3000
```

The site hot-reloads as you edit files.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with Turbopack |
| `npm run build` | Create production build |
| `npm start` | Serve production build |
| `npm run lint` | Run ESLint |

## Project Structure

```
src/
  app/                    # Next.js App Router pages
    page.tsx              # Homepage
    agents/page.tsx       # Agents page
    platform/page.tsx     # Platform page
    workflows/page.tsx    # Workflows page
    use-cases/page.tsx    # Use Cases page
    pricing/page.tsx      # Pricing page
    contact/page.tsx      # Contact page
    security/page.tsx     # Security page
    integrations/page.tsx # Integrations page
    customers/page.tsx    # Customers page
    resources/page.tsx    # Resources page
    layout.tsx            # Root layout
    globals.css           # Global styles + Tailwind theme
    fonts/                # Geist font files
  components/
    layout/               # Header, Footer, LenisProvider, PageTransition
    sections/             # Shared section components (PageHero, FeatureVisuals, etc.)
    ui/                   # Reusable UI components (TextAnimations, GlassCard, etc.)
  lib/
    animations/           # Framer Motion variants
    data/                 # Static data (agents, pricing, integrations, etc.)
    utils/                # Utility functions (cn)
public/                   # Static assets (images, videos)
```

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Styling**: Tailwind CSS v4
- **Animations**: Framer Motion
- **Smooth Scroll**: Lenis
- **Typography**: Geist Sans + Geist Mono
- **Language**: TypeScript

## Deployment

Build for production:

```bash
npm run build
npm start
```

Or deploy directly to [Vercel](https://vercel.com):

```bash
npx vercel
```
