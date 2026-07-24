'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { motion, useInView } from 'framer-motion';

const footerColumns = [
  {
    code: 'AGNTS.01',
    title: 'Platform',
    links: [
      { label: 'Agents', href: '/agents' },
      { label: 'Platform', href: '/platform' },
      { label: 'Workflows', href: '/workflows' },
      { label: 'Integrations', href: '/integrations' },
    ],
  },
  {
    code: 'AGNTS.02',
    title: 'Solutions',
    links: [
      { label: 'Use Cases', href: '/use-cases' },
      { label: 'Security', href: '/security' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Customers', href: '/customers' },
    ],
  },
  {
    code: 'AGNTS.03',
    title: 'Company',
    links: [
      { label: 'Resources', href: '/resources' },
      { label: 'Contact', href: '/contact' },
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
];

export default function Footer() {
  const [email, setEmail] = useState('');
  const brandRef = useRef(null);
  const brandInView = useInView(brandRef, { once: true, margin: '0px' });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setEmail('');
  };

  return (
    <footer
      className="relative overflow-hidden"
      style={{
        background: '#0a0a0a',
      }}
    >
      {/* Top row: Logo + newsletter + columns */}
      <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr_1fr_1fr] border-b border-white/10">
        {/* Logo + newsletter */}
        <div className="p-8 md:p-10 border-b md:border-b-0 md:border-r border-white/10">
          <Link href="/" className="text-lg font-bold text-white tracking-tight inline-block mb-6">
            Agent OS<span className="text-white/60">.</span>
          </Link>
          <p className="text-xs text-white/50 leading-relaxed mb-6">
            The future interface for AI agents. Design, deploy, and orchestrate autonomous systems.
          </p>
          <form onSubmit={handleSubmit} className="flex">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@email.com"
              required
              className="flex-1 min-w-0 px-4 py-2.5 rounded-l-2xl text-sm text-white placeholder:text-white/30 bg-white/[0.08] border border-white/[0.12] focus:outline-none focus:border-white/30 transition-colors duration-300"
            />
            <button
              type="submit"
              className="px-4 py-2.5 rounded-r-2xl bg-white text-ink text-sm font-medium hover:bg-white/90 transition-colors flex-shrink-0 flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </button>
          </form>
        </div>

        {/* Nav columns */}
        {footerColumns.map((column, i) => (
          <div
            key={column.title}
            className={`p-8 md:p-10 ${i < footerColumns.length - 1 ? 'border-b md:border-b-0 md:border-r border-white/10' : ''}`}
          >
            <span className="text-[10px] font-mono text-white/30 uppercase tracking-[0.2em] block mb-1">
              {column.code}
            </span>
            <h3 className="text-xs font-mono text-white/60 uppercase tracking-[0.2em] mb-6">
              {column.title}
            </h3>
            <ul className="space-y-3">
              {column.links.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-white/60 hover:text-white transition-colors duration-300"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* Giant brand text */}
      <div ref={brandRef} className="relative px-6 md:px-10 pt-12 pb-6 overflow-hidden">
        <motion.div
          initial={{ y: 60, opacity: 0 }}
          animate={brandInView ? { y: 0, opacity: 1 } : {}}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
        >
          <h2
            className="text-white/[0.08] font-bold leading-[0.85] tracking-tighter select-none whitespace-nowrap"
            style={{ fontSize: 'clamp(5rem, 18vw, 22rem)' }}
          >
            Agent OS
          </h2>
        </motion.div>
      </div>

      {/* Bottom bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-8 md:px-10 py-6 border-t border-white/10">
        <p className="text-xs text-white/30">
          &copy; 2025 Agent OS. All rights reserved.
        </p>
        <div className="flex items-center gap-6">
          {['Twitter', 'GitHub', 'LinkedIn'].map((label) => (
            <a
              key={label}
              href="#"
              className="text-xs text-white/30 hover:text-white transition-colors duration-300"
            >
              {label}
            </a>
          ))}
        </div>
      </div>

      {/* Decorative grid lines */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-px h-full bg-white/[0.04]" />
        <div className="absolute top-0 left-1/2 w-px h-full bg-white/[0.04]" />
        <div className="absolute top-0 left-3/4 w-px h-full bg-white/[0.04]" />
      </div>
    </footer>
  );
}
