/**
 * Cross-sectional consensus detector.
 *
 * Pure function. Takes a flat list of recent trades (annotated with the
 * wallet's "trust tier") and a config; returns consensus signals where ≥k
 * trusted wallets took the same direction on the same market within a
 * time window.
 *
 * This is the highest-value use of the scanner. An individual wallet can't
 * see what other top wallets are doing in real time; the platform can.
 * When 5+ independent high-PnL wallets all take the same side of a slow
 * market within 30 minutes, that's a signal — and it's actionable over
 * minutes-to-hours, not milliseconds.
 *
 * NOT a substitute for the safety pipeline. Consensus signals feed
 * research_notes / evolution_log; turning one into an order goes through
 * the venue router + capsule + stage gates like anything else.
 *
 * Cluster-aware: if the caller passes a `clusters` map (from
 * src/lib/wallets/clusters.ts), same-cluster wallets collapse into a single
 * "effective vote" in the output. This prevents a single bot operator running
 * 5 wallets from looking like 5 independent agreements.
 */

export type ConsensusTrade = {
  proxyWallet: string;
  /** Higher = more trustworthy. Set by the caller from tracked_wallets metadata. */
  trustTier: number;
  /** Market identity — typically conditionId or eventSlug. */
  marketKey: string;
  /** Display name for the market — used in the signal's summary. */
  marketTitle?: string;
  /** Outcome label ("Yes" / "No" / "Up" / "Down") OR "BUY"/"SELL" — anything that identifies direction within the market. */
  direction: string;
  /** USD size of the trade. */
  usd: number;
  /** Entry price (0..1). */
  price: number;
  /** ISO timestamp the trade was placed. */
  ts: string;
};

export type ConsensusOptions = {
  /** Trades older than this are ignored. */
  windowMinutes: number;
  /** Minimum number of distinct wallets agreeing for a signal to fire. */
  minWallets: number;
  /** Minimum sum of trustTier across agreeing wallets. */
  minCombinedTrust: number;
  /** Minimum total USD across agreeing wallets. Default 0 (no filter). */
  minCombinedUsd?: number;
  /** Optional cluster lookup: proxyWallet → clusterId. Same-cluster wallets
   *  collapse into one effective vote in the output (not in `minWallets` check). */
  clusters?: Map<string, string> | Record<string, string>;
  /** Optional: require at least this many DISTINCT clusters (effective wallets). */
  minEffectiveWallets?: number;
};

export type ConsensusSignal = {
  marketKey: string;
  marketTitle?: string;
  direction: string;
  wallets: Array<{ proxyWallet: string; trustTier: number; usd: number; ts: string; clusterId?: string }>;
  combinedTrust: number;
  combinedUsd: number;
  /** Distinct wallet count (raw). */
  walletCount: number;
  /** Distinct cluster count — equal to walletCount when clusters were not provided. */
  effectiveWallets: number;
  /** Cluster IDs that contributed (the wallet's own address when unclustered). */
  clusterIds: string[];
  avgPrice: number;
  windowStart: string;
  windowEnd: string;
};

function clusterIdFor(wallet: string, clusters: ConsensusOptions["clusters"]): string {
  if (!clusters) return wallet;
  if (clusters instanceof Map) return clusters.get(wallet) ?? wallet;
  return clusters[wallet] ?? wallet;
}

export function detectConsensus(trades: ConsensusTrade[], opts: ConsensusOptions): ConsensusSignal[] {
  const cutoffMs = Date.now() - opts.windowMinutes * 60_000;
  const minUsd = opts.minCombinedUsd ?? 0;
  const minEffective = opts.minEffectiveWallets ?? 0;

  // Bucket by marketKey → direction → trades. Nested Map avoids string-key
  // collisions if a marketKey ever contains a separator character.
  const byMarket = new Map<string, Map<string, ConsensusTrade[]>>();
  for (const t of trades) {
    const tsMs = Date.parse(t.ts);
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
    const direction = t.direction.toUpperCase();
    if (!byMarket.has(t.marketKey)) byMarket.set(t.marketKey, new Map());
    const byDir = byMarket.get(t.marketKey)!;
    if (!byDir.has(direction)) byDir.set(direction, []);
    byDir.get(direction)!.push(t);
  }

  const signals: ConsensusSignal[] = [];
  for (const [marketKey, byDir] of byMarket) {
    for (const [direction, ts] of byDir) {
      const byWallet = new Map<string, ConsensusTrade[]>();
      for (const t of ts) {
        if (!byWallet.has(t.proxyWallet)) byWallet.set(t.proxyWallet, []);
        byWallet.get(t.proxyWallet)!.push(t);
      }
      if (byWallet.size < opts.minWallets) continue;

      const walletRecords = [...byWallet.entries()].map(([wallet, walletTrades]) => {
        const usd = walletTrades.reduce((s, x) => s + x.usd, 0);
        const trustTier = Math.max(...walletTrades.map((x) => x.trustTier));
        const minTs = walletTrades.map((x) => x.ts).sort()[0];
        return {
          proxyWallet: wallet,
          trustTier,
          usd,
          ts: minTs,
          clusterId: opts.clusters ? clusterIdFor(wallet, opts.clusters) : undefined,
        };
      });

      const combinedTrust = walletRecords.reduce((s, r) => s + r.trustTier, 0);
      const combinedUsd = walletRecords.reduce((s, r) => s + r.usd, 0);
      if (combinedTrust < opts.minCombinedTrust) continue;
      if (combinedUsd < minUsd) continue;

      const clusterIdSet = new Set<string>();
      for (const r of walletRecords) clusterIdSet.add(r.clusterId ?? r.proxyWallet);
      const effectiveWallets = clusterIdSet.size;
      if (effectiveWallets < minEffective) continue;

      const prices = ts.map((t) => t.price).filter((p) => p > 0 && p < 1);
      const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
      const tss = ts.map((t) => t.ts).sort();

      signals.push({
        marketKey,
        marketTitle: ts.find((t) => t.marketTitle)?.marketTitle,
        direction,
        wallets: walletRecords.sort((a, b) => b.trustTier - a.trustTier),
        combinedTrust,
        combinedUsd,
        walletCount: walletRecords.length,
        effectiveWallets,
        clusterIds: [...clusterIdSet],
        avgPrice,
        windowStart: tss[0],
        windowEnd: tss[tss.length - 1],
      });
    }
  }

  return signals.sort(
    (a, b) =>
      b.effectiveWallets - a.effectiveWallets ||
      b.combinedTrust - a.combinedTrust ||
      b.combinedUsd - a.combinedUsd,
  );
}
