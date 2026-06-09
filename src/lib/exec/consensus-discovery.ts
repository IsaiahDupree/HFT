/**
 * consensus-discovery — find the COPYABLE humans the PnL leaderboard buries. The leaderboard ranks by profit,
 * so it surfaces HFT/MM machines first; the slow, mirrorable position-traders rank far below. This flips the
 * discovery: instead of "who made the most money," ask "who is CO-HOLDING the same coin, same direction, right
 * now." A coin where many independent wallets sit on the same side is a conviction cluster — and a wallet
 * carrying a real resting position is structurally more likely to be a holder than a scalper (a scalper rarely
 * leaves size on the book). The wallets in those clusters become the SEED set for the tracker, which then runs
 * the full strategy profile to confirm (or reject) trade-copyability. Discovery widens the net; the profile is
 * still the honest gate — co-holding biases toward holders, it does not prove low turnover.
 *
 * Pure + deterministic. The script fetches open positions; this finds the clusters and the seed wallets.
 */
import type { WalletPosition } from "./smart-money.ts";

export type ConsensusCluster = {
  coin: string; side: "long" | "short"; wallets: string[]; nWallets: number;
  netNotional: number; convictionUsd: number;   // notional on the consensus side
  conviction: number;                            // rank score = nWallets weighted by notional
};

export type DiscoverOpts = {
  minWallets: number;       // a cluster needs at least this many co-holders to count as consensus
  minNotionalUsd: number;   // ignore dust positions (a wallet's stake must be real)
  minAccountValue: number;  // skin-in-the-game filter on the holder
};
export const DEFAULT_DISCOVER: DiscoverOpts = { minWallets: 3, minNotionalUsd: 10_000, minAccountValue: 25_000 };

/**
 * Group the open positions into per-coin, per-direction conviction clusters. A cluster qualifies as consensus
 * only if `minWallets` independent wallets co-hold the same side with real notional. Ranked by conviction =
 * wallet count × log-scaled notional, so a wide cluster (many wallets) outranks one whale.
 */
export function consensusCoins(positions: readonly WalletPosition[], opts: DiscoverOpts = DEFAULT_DISCOVER): ConsensusCluster[] {
  const groups = new Map<string, Map<string, number>>(); // `${coin}:${side}` -> wallet -> notional
  for (const p of positions) {
    if (p.szi === 0 || Math.abs(p.notionalUsd) < opts.minNotionalUsd || p.accountValue < opts.minAccountValue) continue;
    const side = p.szi > 0 ? "long" : "short";
    const key = `${p.coin}:${side}`;
    const m = groups.get(key) ?? new Map<string, number>();
    m.set(p.wallet, (m.get(p.wallet) ?? 0) + Math.abs(p.notionalUsd));
    groups.set(key, m);
  }
  const out: ConsensusCluster[] = [];
  for (const [key, m] of groups) {
    if (m.size < opts.minWallets) continue;
    const [coin, side] = key.split(":") as [string, "long" | "short"];
    const convictionUsd = [...m.values()].reduce((a, b) => a + b, 0);
    const wallets = [...m.keys()];
    out.push({ coin, side, wallets, nWallets: m.size, netNotional: side === "long" ? convictionUsd : -convictionUsd, convictionUsd, conviction: m.size * Math.log10(Math.max(convictionUsd, 10)) });
  }
  return out.sort((a, b) => b.conviction - a.conviction);
}

export type SeedWallet = { wallet: string; clusters: number; coins: string[]; convictionUsd: number };

/**
 * Flatten the consensus clusters into a ranked SEED list. A wallet that appears in MULTIPLE conviction clusters
 * (co-holding several consensus coins) is a stronger seed than one appearing once — it is repeatedly aligned
 * with the crowd's holders. These addresses feed the tracker; the strategy profile then accepts or rejects them.
 */
export function seedFromConsensus(clusters: readonly ConsensusCluster[]): SeedWallet[] {
  const m = new Map<string, { coins: Set<string>; usd: number }>();
  for (const c of clusters) {
    for (const w of c.wallets) {
      const e = m.get(w) ?? { coins: new Set<string>(), usd: 0 };
      e.coins.add(`${c.coin}:${c.side}`);
      e.usd += c.convictionUsd / c.nWallets; // this wallet's rough share
      m.set(w, e);
    }
  }
  return [...m.entries()]
    .map(([wallet, e]) => ({ wallet, clusters: e.coins.size, coins: [...e.coins], convictionUsd: e.usd }))
    .sort((a, b) => b.clusters - a.clusters || b.convictionUsd - a.convictionUsd);
}
