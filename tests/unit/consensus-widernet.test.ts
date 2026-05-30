/**
 * Wider-net sensitivity test for `npm run consensus:backtest -- --window N --min K`.
 *
 * Validates the loop the user wants to run: looser CLI parameters should
 * surface ≥ as many consensus signals (never fewer) on the same underlying
 * trades. Catches accidental param-direction swaps and broken filters.
 *
 * Models the sliding-window logic from scripts/consensus-backtest.ts using
 * the same `detectConsensus()` core.
 */
import { describe, expect, it } from "vitest";
import { detectConsensus, type ConsensusTrade } from "../../src/lib/wallets/consensus";

// detectConsensus filters by "trade within the last `windowMinutes` from
// Date.now()" — not within a relative window of each other. So our test
// trades must be timestamped recently, not in some fixed historical era.
const baseTime = Date.now();
const isoMinAgo = (m: number) => new Date(baseTime - m * 60_000).toISOString();

function trade(over: Partial<ConsensusTrade>): ConsensusTrade {
  return {
    proxyWallet: "0xw1",
    trustTier: 1,
    marketKey: "0xc1",
    direction: "Yes",
    usd: 100,
    price: 0.5,
    ts: isoMinAgo(5),
    ...over,
  };
}

describe("Wider-net consensus sensitivity", () => {
  // Three wallets agreeing on "Yes" across 25 minutes inside the recent past.
  const baseTrades: ConsensusTrade[] = [
    trade({ proxyWallet: "0xw1", direction: "Yes", marketKey: "0xc1", ts: isoMinAgo(25) }),
    trade({ proxyWallet: "0xw2", direction: "Yes", marketKey: "0xc1", ts: isoMinAgo(15) }),
    trade({ proxyWallet: "0xw3", direction: "Yes", marketKey: "0xc1", ts: isoMinAgo(2) }),
  ];

  it("looser --min K produces ≥ as many signals as stricter K (monotonic in K)", () => {
    const opts = { windowMinutes: 60, minCombinedTrust: 1 };
    const strict = detectConsensus(baseTrades, { ...opts, minWallets: 3 }).length;
    const loose = detectConsensus(baseTrades, { ...opts, minWallets: 2 }).length;
    const looser = detectConsensus(baseTrades, { ...opts, minWallets: 1 }).length;
    expect(loose).toBeGreaterThanOrEqual(strict);
    expect(looser).toBeGreaterThanOrEqual(loose);
  });

  it("looser --window M produces ≥ as many signals as stricter M (monotonic in window)", () => {
    // Trades span 25 minutes. window=10 cuts them in half; window=60 catches all.
    const opts = { minWallets: 2, minCombinedTrust: 1 };
    const tight = detectConsensus(baseTrades, { ...opts, windowMinutes: 10 }).length;
    const wide = detectConsensus(baseTrades, { ...opts, windowMinutes: 60 }).length;
    expect(wide).toBeGreaterThanOrEqual(tight);
  });

  it("the CLI's recommended wider params (--min 2 --window 120) only fires on the agreeing side", () => {
    // Same wallets, but they disagree → only the side with ≥2 wallets fires.
    // detectConsensus uppercases `direction`, so check for "YES" / "NO".
    const disagree: ConsensusTrade[] = [
      trade({ proxyWallet: "0xw1", direction: "Yes", marketKey: "0xc1", ts: isoMinAgo(20) }),
      trade({ proxyWallet: "0xw2", direction: "No", marketKey: "0xc1", ts: isoMinAgo(15) }),
      trade({ proxyWallet: "0xw3", direction: "Yes", marketKey: "0xc1", ts: isoMinAgo(5) }),
    ];
    const sigs = detectConsensus(disagree, { windowMinutes: 120, minWallets: 2, minCombinedTrust: 1 });
    const yesSig = sigs.find((s) => s.direction === "YES");
    const noSig = sigs.find((s) => s.direction === "NO");
    expect(yesSig).toBeDefined();
    expect(yesSig!.walletCount).toBe(2);
    expect(noSig).toBeUndefined(); // only 1 wallet → below min=2
  });

  it("sliding-window step (the CLI's --step) reaches more starting points without missing earlier signals", () => {
    // Simulate the CLI's slide: 4-hour history of recent trades, window=60min.
    // Smaller step should never miss a signal that a larger step finds.
    // Use a "wide enough" windowMinutes inside detectConsensus so the inner
    // filter doesn't reject trades that are valid in the SLICE-relative
    // window. The slicing is what gates here; detectConsensus then sees only
    // trades inside the slice anyway.
    const t0 = baseTime - 4 * 3600_000;
    const trades: ConsensusTrade[] = [];
    for (let h = 0; h < 4; h++) {
      const ts = new Date(t0 + h * 3600_000 + 5 * 60_000).toISOString();
      trades.push(trade({ proxyWallet: "0xw1", marketKey: `0xc${h}`, direction: "Yes", ts }));
      trades.push(trade({ proxyWallet: "0xw2", marketKey: `0xc${h}`, direction: "Yes", ts }));
    }

    const slide = (stepMin: number) => {
      const seen = new Set<string>();
      // windowMinutes=480 (8h) >> our slide window, so the inner filter accepts
      // every trade in the slice — matches the CLI's outer-slicing behavior.
      const opts = { windowMinutes: 480, minWallets: 2, minCombinedTrust: 1 };
      const horizon = 4 * 3600_000;
      for (let s = t0; s + 60 * 60_000 <= t0 + horizon; s += stepMin * 60_000) {
        const slice = trades.filter((t) => {
          const ms = Date.parse(t.ts);
          return ms >= s && ms <= s + 60 * 60_000;
        });
        if (slice.length < 2) continue;
        for (const sig of detectConsensus(slice, opts)) {
          const hourBucket = Math.floor(Date.parse(sig.windowStart) / 3600_000);
          seen.add(`${sig.marketKey}|${sig.direction.toLowerCase()}|${hourBucket}`);
        }
      }
      return seen.size;
    };
    expect(slide(15)).toBeGreaterThanOrEqual(slide(60));
  });
});
