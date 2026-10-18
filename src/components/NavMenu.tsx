"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

type NavItem = { href: string; label: string; description?: string };
type NavGroup = { label: string; matches: string[]; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    label: "Markets",
    matches: ["/markets", "/live", "/arb", "/coinbase", "/onchain", "/tracked", "/crypto", "/binaries", "/hft"],
    items: [
      { href: "/hft", label: "HFT vs Polymarket ★", description: "Venue matrix + edge calculator + BTC binary ranker" },
      { href: "/hft/dydx", label: " · dYdX live", description: "Markets, account, testnet market-maker" },
      { href: "/binaries", label: "Binaries (5m/15m) ★", description: "Polymarket short-duration crypto Up/Down events" },
      { href: "/crypto", label: "Crypto live", description: "Coinbase spot + momentum × Polymarket crypto markets" },
      { href: "/markets", label: "Polymarket", description: "Sampling markets, events, orderbook" },
      { href: "/live", label: "Live WebSocket", description: "Real-time top-of-book" },
      { href: "/coinbase", label: "Coinbase", description: "Spot, futures, accounts" },
      { href: "/coinbase/products", label: " · Products", description: "Top SPOT by 24h vol" },
      { href: "/coinbase/orders", label: " · Orders", description: "Open / filled / cancelled" },
      { href: "/arb", label: "Arb (single)", description: "Single-market YES+NO baskets" },
      { href: "/arb/comb", label: "Arb (combinatorial)", description: "LP-based multi-market" },
      { href: "/onchain", label: "On-chain", description: "CTF V2 fill stream" },
      { href: "/onchain/aave", label: " · Aave liquidation risk", description: "HF watcher over tracked wallets" },
      { href: "/tracked", label: "Tracked wallets", description: "Watched accounts" },
      { href: "/consensus", label: "Consensus signals", description: "Cross-wallet agreement" },
      { href: "/opportunities", label: "Strategy opportunities ★", description: "NRS + cross-timeframe + orderbook imbalance" },
    ],
  },
  {
    label: "Arena",
    matches: ["/arena"],
    items: [
      { href: "/arena", label: "Leaderboard", description: "Alive paper agents by fitness" },
      { href: "/arena/generations", label: "Generations", description: "Evolution timeline" },
      { href: "/arena/mutations", label: "Mutation cohorts", description: "Programmatic vs LLM" },
    ],
  },
  {
    label: "Capsules",
    matches: ["/capsules", "/safety", "/deposit", "/decisions", "/portfolio", "/calibration"],
    items: [
      { href: "/capsules", label: "Capsules", description: "Real-money envelopes + activation" },
      { href: "/portfolio", label: "Portfolio governance ★", description: "Reserve + correlations + loss-overlap" },
      { href: "/decisions", label: "Decision journal ★", description: "Per-trade gate audit (pipeline shadow + active)" },
      { href: "/calibration", label: "Calibration ★", description: "Does the pipeline tell the truth? (per-bucket win-rate)" },
      { href: "/safety", label: "Safety control plane", description: "All gates + halt + freshness" },
      { href: "/deposit", label: "Polymarket deposit ★", description: "Generate QR for funding from Coinbase Base App" },
    ],
  },
  {
    label: "Manage",
    matches: ["/agents", "/strategies", "/trades", "/research", "/evolution", "/settings"],
    items: [
      { href: "/agents", label: "Agents", description: "Charters + risk budgets" },
      { href: "/strategies", label: "Strategies", description: "Versioned specs" },
      { href: "/trades", label: "Trades", description: "Local + on-chain" },
      { href: "/research", label: "Research notes", description: "Theses + sources" },
      { href: "/evolution", label: "Evolution log", description: "Append-only event stream" },
      { href: "/settings", label: "Settings + state ★", description: "Thresholds, heartbeats, learnings, cheat-sheet" },
    ],
  },
];

export function NavMenu() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState<string | null>(null);

  return (
    <nav className="flex gap-4 text-zinc-400 text-sm relative">
      <Link
        href="/"
        className={`hover:text-zinc-100 transition-colors ${pathname === "/" ? "text-zinc-100" : ""}`}
      >
        Overview
      </Link>
      {GROUPS.map((g) => {
        const active = g.matches.some((m) => pathname === m || pathname.startsWith(m + "/"));
        const isOpen = open === g.label;
        return (
          <div
            key={g.label}
            className="relative"
            onMouseEnter={() => setOpen(g.label)}
            onMouseLeave={() => setOpen(null)}
          >
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : g.label)}
              className={`hover:text-zinc-100 transition-colors flex items-center gap-1 ${active ? "text-zinc-100" : ""}`}
              aria-haspopup="true"
              aria-expanded={isOpen}
            >
              {g.label}
              <span className="text-[8px] opacity-60">▼</span>
            </button>
            {isOpen && (
              <div className="absolute left-0 top-full pt-1 z-30">
                <div className="bg-ink-900 border border-ink-700 rounded-md shadow-lg py-1 min-w-[220px]">
                  {g.items.map((item) => {
                    const itemActive = pathname === item.href;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setOpen(null)}
                        className={`block px-3 py-1.5 hover:bg-ink-800 ${itemActive ? "text-accent-blue" : "text-zinc-200"}`}
                      >
                        <div className="text-xs">{item.label}</div>
                        {item.description && (
                          <div className="text-[10px] text-zinc-500">{item.description}</div>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
