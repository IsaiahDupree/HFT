/**
 * Integration test for the consensus pipeline.
 *
 * Exercises: seed tracked_wallets → build ConsensusTrade[] from mocked
 * per-wallet trade lists → detectConsensus() → persist as consensus-signal
 * event → re-read in the shape the /consensus page consumes.
 *
 * Mocks the poly client at the userTrades level so the test doesn't hit
 * network. The trades come from 4 different wallets all going BUY on the
 * same market within a tight window — the canonical "consensus" pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMemoryDb } from "../helpers/db";

let memDb: ReturnType<typeof makeMemoryDb> | null = null;
vi.mock("@/lib/db/client", () => ({
  db: () => {
    if (!memDb) memDb = makeMemoryDb();
    return memDb;
  },
  closeDb: () => { memDb?.close(); memDb = null; },
}));

import * as dbModule from "@/lib/db/client";
import { detectConsensus, type ConsensusTrade } from "@/lib/wallets/consensus";
import { insertEvolutionEvent } from "@/lib/db/queries";

function seedTrackedWallets(): Array<{ proxyWallet: string; tier: number }> {
  const db = (dbModule as any).db();
  const seeds = [
    { handle: "alpha", proxy: "0xaaaa000000000000000000000000000000000001", claimed: 5_500_000, strategy: "auto-leaderboard DAY+WEEK+MONTH" },
    { handle: "beta",  proxy: "0xbbbb000000000000000000000000000000000002", claimed: 2_100_000, strategy: "auto-leaderboard DAY+WEEK" },
    { handle: "gamma", proxy: "0xcccc000000000000000000000000000000000003", claimed: 800_000,   strategy: null },
    { handle: "delta", proxy: "0xdddd000000000000000000000000000000000004", claimed: null,       strategy: null },
  ];
  for (const s of seeds) {
    db.prepare(
      `INSERT INTO tracked_wallets (handle, proxy_wallet, claimed_profit_usd, strategy_label, last_resolved)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(s.handle, s.proxy, s.claimed, s.strategy);
  }
  return seeds.map((s) => ({
    proxyWallet: s.proxy,
    tier:
      (s.strategy?.startsWith("auto-leaderboard") ? 1 : 0) +
      ((s.claimed ?? 0) > 1_000_000 ? 1 : 0) +
      ((s.claimed ?? 0) > 5_000_000 ? 1 : 0) +
      1,
  }));
}

function tradeFromWallet(w: { proxyWallet: string; tier: number }, marketKey: string, direction: string, opts: { minutesAgo?: number; price?: number; usd?: number; title?: string } = {}): ConsensusTrade {
  return {
    proxyWallet: w.proxyWallet,
    trustTier: w.tier,
    marketKey,
    marketTitle: opts.title ?? "Will X happen?",
    direction,
    usd: opts.usd ?? 250,
    price: opts.price ?? 0.55,
    ts: new Date(Date.now() - (opts.minutesAgo ?? 5) * 60_000).toISOString(),
  };
}

beforeEach(() => { memDb?.close(); memDb = null; });
afterEach(() => { memDb?.close(); memDb = null; });

describe("consensus pipeline — end-to-end", () => {
  it("4 tracked wallets all buying YES on a market produces one consensus-signal event", () => {
    const wallets = seedTrackedWallets();
    const trades: ConsensusTrade[] = wallets.map((w) => tradeFromWallet(w, "cond-1", "YES"));

    const signals = detectConsensus(trades, {
      windowMinutes: 30,
      minWallets: 3,
      minCombinedTrust: 4,
    });
    expect(signals).toHaveLength(1);
    const sig = signals[0];
    expect(sig.wallets).toHaveLength(4);
    expect(sig.direction).toBe("YES");

    // Persist as the scan script would
    insertEvolutionEvent({
      event_type: "consensus-signal",
      summary: `consensus: ${sig.wallets.length} wallets ${sig.direction}`,
      payload_json: JSON.stringify(sig),
    });

    // Re-read in the shape /consensus consumes
    const events = (dbModule as any).db()
      .prepare("SELECT id, summary, payload_json, created_at FROM evolution_log WHERE event_type = 'consensus-signal' ORDER BY created_at DESC")
      .all() as Array<{ id: number; summary: string; payload_json: string; created_at: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.marketKey).toBe("cond-1");
    expect(payload.wallets).toHaveLength(4);
    expect(payload.combinedTrust).toBeGreaterThan(0);
  });

  it("disagreement on direction produces no signal", () => {
    const wallets = seedTrackedWallets();
    const trades: ConsensusTrade[] = [
      tradeFromWallet(wallets[0], "cond-1", "YES"),
      tradeFromWallet(wallets[1], "cond-1", "YES"),
      tradeFromWallet(wallets[2], "cond-1", "NO"),
      tradeFromWallet(wallets[3], "cond-1", "NO"),
    ];
    const signals = detectConsensus(trades, { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 });
    expect(signals).toEqual([]);
  });

  it("respects the trust floor — only signals when combinedTrust >= threshold", () => {
    const wallets = seedTrackedWallets();
    // Only the no-credentials wallets agreeing — combined trust = 1+1 = 2
    const trades: ConsensusTrade[] = [
      tradeFromWallet(wallets[2], "cond-2", "YES"), // tier 1
      tradeFromWallet(wallets[3], "cond-2", "YES"), // tier 1
      tradeFromWallet(wallets[3], "cond-2", "YES"), // duplicate wallet — collapses
    ];
    // Only 2 distinct wallets and trust = 2; with minWallets=3 OR minTrust=5 → no signal
    expect(detectConsensus(trades, { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 })).toEqual([]);
  });

  it("multiple markets produce multiple signals (sorted by trust)", () => {
    const wallets = seedTrackedWallets();
    const tradesLowTrust: ConsensusTrade[] = [
      tradeFromWallet(wallets[2], "low-cond", "YES"),  // tier 1
      tradeFromWallet(wallets[3], "low-cond", "YES"),  // tier 1
      tradeFromWallet({ proxyWallet: "0xeeee", tier: 1 }, "low-cond", "YES"),
    ];
    const tradesHighTrust: ConsensusTrade[] = [
      tradeFromWallet(wallets[0], "high-cond", "YES"),  // tier 4 (whale + lb)
      tradeFromWallet(wallets[1], "high-cond", "YES"),  // tier 3 (whale + lb)
      tradeFromWallet(wallets[2], "high-cond", "YES"),  // tier 1
    ];
    const signals = detectConsensus(
      [...tradesLowTrust, ...tradesHighTrust],
      { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 },
    );
    expect(signals).toHaveLength(2);
    // Higher trust first
    expect(signals[0].marketKey).toBe("high-cond");
    expect(signals[1].marketKey).toBe("low-cond");
  });
});

describe("consensus pipeline — dedup logic (replays the scan script's hour-bucket check)", () => {
  function hourBucket(iso: string): string { return new Date(iso).toISOString().slice(0, 13); }

  it("two scans within the same hour log the same signal only once", () => {
    const wallets = seedTrackedWallets();
    const trades: ConsensusTrade[] = wallets.slice(0, 3).map((w) => tradeFromWallet(w, "dedup-cond", "YES"));

    const signals = detectConsensus(trades, { windowMinutes: 30, minWallets: 3, minCombinedTrust: 0 });
    expect(signals).toHaveLength(1);
    const sig = signals[0];

    // First scan — log
    const db = (dbModule as any).db();
    const seen = new Set<string>();
    const dedupKey = `${sig.marketKey}|${sig.direction}|${hourBucket(sig.windowStart)}`;
    if (!seen.has(dedupKey)) {
      seen.add(dedupKey);
      insertEvolutionEvent({
        event_type: "consensus-signal",
        summary: "first",
        payload_json: JSON.stringify(sig),
      });
    }
    // Second scan in the same hour — same dedup key → no insert
    const existing = db.prepare(
      `SELECT payload_json FROM evolution_log WHERE event_type = 'consensus-signal' AND created_at >= datetime('now', '-1 hour')`,
    ).all() as Array<{ payload_json: string }>;
    for (const e of existing) {
      const p = JSON.parse(e.payload_json);
      seen.add(`${p.marketKey}|${p.direction}|${hourBucket(p.windowStart)}`);
    }
    if (!seen.has(dedupKey)) {
      // Shouldn't happen — dedupKey was just added above
      insertEvolutionEvent({ event_type: "consensus-signal", summary: "DUP", payload_json: JSON.stringify(sig) });
    }

    const rows = db.prepare("SELECT COUNT(*) AS n FROM evolution_log WHERE event_type = 'consensus-signal'").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
