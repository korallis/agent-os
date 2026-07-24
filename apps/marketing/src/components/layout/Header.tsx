'use client';

import { SiteHeader } from '@agent-os/ui';

const primaryLinks = [
  { label: 'Agents', href: '/agents' },
  { label: 'Platform', href: '/platform' },
  { label: 'Workflows', href: '/workflows' },
  { label: 'Use Cases', href: '/use-cases' },
  { label: 'Pricing', href: '/pricing' },
];

const navLinks = [
  { label: 'Home', href: '/' },
  { label: 'Agents', href: '/agents' },
  { label: 'Platform', href: '/platform' },
  { label: 'Workflows', href: '/workflows' },
  { label: 'Use Cases', href: '/use-cases' },
  { label: 'Integrations', href: '/integrations' },
  { label: 'Security', href: '/security' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Resources', href: '/resources' },
  { label: 'Contact', href: '/contact' },
];

export default function Header() {
  return (
    <SiteHeader
      primaryLinks={primaryLinks}
      menuLinks={navLinks}
      cta={{ label: 'Contact', href: '/contact' }}
      menuFooter={
        <div className="space-y-6">
          <div>
            <p className="text-[10px] font-mono text-ink/30 uppercase tracking-[0.2em] mb-2">Platform</p>
            <p className="text-sm text-ink/60 leading-relaxed">
              The future interface for AI agents. Design, deploy, and orchestrate autonomous systems.
            </p>
          </div>
          <div>
            <p className="text-[10px] font-mono text-ink/30 uppercase tracking-[0.2em] mb-2">Contact</p>
            <a href="mailto:hello@agentos.ai" className="text-sm text-ink hover:text-electric-dark transition-colors">
              hello@agentos.ai
            </a>
          </div>
        </div>
      }
    />
  );
}
