import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import { geistSans, geistMono } from '@agent-os/ui/fonts';
import './globals.css';
import LenisProvider from '@/components/layout/LenisProvider';
import Header from '@/components/layout/Header';

const Footer = dynamic(() => import('@/components/layout/Footer'));

export const metadata: Metadata = {
  title: 'Agent OS — The Future Interface for AI Agents',
  description:
    'Agent OS is the premium platform for deploying, managing, and orchestrating autonomous AI agents. Build intelligent workflows, integrate seamlessly, and scale with confidence.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="font-sans bg-white text-ink antialiased overflow-x-hidden">
        <LenisProvider>
          <Header />
          <main className="min-h-screen">{children}</main>
          <Footer />
        </LenisProvider>
      </body>
    </html>
  );
}
