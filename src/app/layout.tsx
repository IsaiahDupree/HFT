import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import { SystemStatusBar } from "@/components/SystemStatusBar";
import { PolymarketStatusBar } from "@/components/PolymarketStatusBar";
import { NavMenu } from "@/components/NavMenu";
import { TradeTicker } from "@/components/TradeTicker";

export const metadata: Metadata = {
  title: "Polymarket Agents",
  description: "Local control plane for AI-agent Polymarket trading strategies and research",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const signer = process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS ?? "";
  return (
    <html lang="en" className="bg-ink-950 text-zinc-100">
      <body className="min-h-screen font-mono text-sm pb-12">
        {/* SystemStatusBar polls every 30s and is sticky atop the page. */}
        <div className="sticky top-0 z-20">
          <SystemStatusBar />
          <PolymarketStatusBar />
          <header className="border-b border-ink-700 bg-ink-900/80 backdrop-blur">
            <div className="mx-auto max-w-7xl px-6 py-3 flex items-center gap-6">
              <Link href="/" className="text-base font-semibold tracking-tight">
                poly<span className="text-accent-green">agents</span>
              </Link>
              <NavMenu />
              {signer && (
                <div className="ml-auto text-xs text-zinc-500">
                  signer: <span className="text-zinc-300">{signer.slice(0, 10)}…{signer.slice(-4)}</span>
                </div>
              )}
            </div>
          </header>
        </div>
        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
        {/* Sticky-bottom marquee of last N paper trades, polls every 30s. */}
        <TradeTicker />
      </body>
    </html>
  );
}
