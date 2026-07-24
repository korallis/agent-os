import type { Metadata } from "next";
import { geistSans, geistMono } from "@agent-os/ui/fonts";
import { MicroLabel } from "@agent-os/ui";
import "./globals.css";
import { ConsoleNav } from "@/components/console/ConsoleNav";
import { HeaderStatus } from "@/components/console/HeaderStatus";

export const metadata: Metadata = {
  title: "Agent OS — Console",
  description: "Local operations console for the Agent OS orchestrator.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="font-sans bg-white text-ink antialiased overflow-x-hidden">
        <div className="flex min-h-screen">
          <aside className="w-56 shrink-0 border-r border-rule flex flex-col">
            <div className="h-14 border-b border-rule flex items-center px-5">
              <MicroLabel className="font-semibold">Agent OS</MicroLabel>
            </div>
            <ConsoleNav />
            <div className="border-t border-rule px-5 py-4">
              <MicroLabel className="text-black/40">agentosd · v0.1.0</MicroLabel>
            </div>
          </aside>
          <div className="flex-1 flex flex-col min-w-0">
            <HeaderStatus />
            <main className="flex-1">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
