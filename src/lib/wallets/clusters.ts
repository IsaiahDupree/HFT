/**
 * Wallet clustering — detect wallets that act in coordination.
 *
 * When 5 wallets all bet YES on a market, are they 5 INDEPENDENT actors
 * agreeing, or 5 instances of the same bot operator? The latter is one
 * signal counted five times. Consensus signals should weight independent
 * agreements above same-cluster agreements.
 *
 * Algorithm:
 *   1. For each wallet, build a set of (market, direction, time-bucket)
 *      signatures across the input trade history.
 *   2. Pairwise Jaccard similarity between wallet sets.
 *   3. If similarity ≥ minSimilarity, add an edge.
 *   4. Union-find to merge edge components into clusters.
 *
 * Time-bucketed: two wallets buying YES on the same market at the same
 * 5-minute boundary is strong evidence of coordination. Different
 * 5-minute boundaries is much weaker.
 *
 * Pure function. Caller supplies trades + opts; returns clusters and
 * (via `clusterMap`) a wallet → clusterId Map for use by detectConsensus.
 */

export type ClusterTrade = {
  proxyWallet: string;
  marketKey: string;
  direction: string;
  ts: string;
};

export type ClusterOptions = {
  /** Jaccard similarity threshold to declare two wallets coordinated (0..1). */
  minSimilarity?: number;
  /** Bucket width for time matching. Smaller = stricter. Default 5min. */
  bucketMinutes?: number;
  /** Minimum signature count per wallet to be eligible for clustering. */
  minSignatures?: number;
};

export type WalletCluster = {
  /** Canonical cluster ID — sorted-first wallet address. */
  id: string;
  members: string[];
  size: number;
  /** Avg pairwise Jaccard similarity inside the cluster (0..1). */
  cohesion: number;
};

const DEFAULT_OPTS: Required<ClusterOptions> = {
  minSimilarity: 0.4,
  bucketMinutes: 5,
  minSignatures: 5,
};

export function detectClusters(trades: ClusterTrade[], opts: ClusterOptions = {}): WalletCluster[] {
  const cfg = { ...DEFAULT_OPTS, ...opts };
  const bucketMs = cfg.bucketMinutes * 60_000;

  // Build signature sets per wallet
  const walletSets = new Map<string, Set<string>>();
  for (const t of trades) {
    const ms = Date.parse(t.ts);
    if (!Number.isFinite(ms)) continue;
    const bucket = Math.floor(ms / bucketMs);
    const sig = `${t.marketKey}|${t.direction.toUpperCase()}|${bucket}`;
    if (!walletSets.has(t.proxyWallet)) walletSets.set(t.proxyWallet, new Set());
    walletSets.get(t.proxyWallet)!.add(sig);
  }

  // Pairwise Jaccard
  const wallets = [...walletSets.keys()];
  const edges: Array<[string, string, number]> = [];
  for (let i = 0; i < wallets.length; i++) {
    const a = walletSets.get(wallets[i])!;
    if (a.size < cfg.minSignatures) continue;
    for (let j = i + 1; j < wallets.length; j++) {
      const b = walletSets.get(wallets[j])!;
      if (b.size < cfg.minSignatures) continue;
      // Iterate the smaller set when computing intersection
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      let inter = 0;
      for (const k of small) if (big.has(k)) inter++;
      if (inter === 0) continue;
      const union = a.size + b.size - inter;
      const sim = union > 0 ? inter / union : 0;
      if (sim >= cfg.minSimilarity) edges.push([wallets[i], wallets[j], sim]);
    }
  }

  if (edges.length === 0) return [];

  // Union-find
  const parent = new Map<string, string>();
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x);
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      const nextNext = parent.get(next)!;
      parent.set(cur, nextNext);
      cur = nextNext;
    }
    return cur;
  }
  function uni(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const [a, b] of edges) uni(a, b);

  // Collect members per root (deduplicated)
  const memberRoots = new Map<string, Set<string>>();
  for (const [a, b] of edges) {
    const rootA = find(a);
    if (!memberRoots.has(rootA)) memberRoots.set(rootA, new Set());
    memberRoots.get(rootA)!.add(a);
    memberRoots.get(rootA)!.add(b);
  }

  // Compute cohesion per cluster
  const clusters: WalletCluster[] = [];
  for (const memberSet of memberRoots.values()) {
    const members = [...memberSet];
    if (members.length < 2) continue;
    const sorted = [...members].sort();
    let simSum = 0;
    let pairs = 0;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const edge = edges.find(
          ([a, b]) =>
            (a === members[i] && b === members[j]) ||
            (a === members[j] && b === members[i]),
        );
        if (edge) {
          simSum += edge[2];
          pairs++;
        }
      }
    }
    const cohesion = pairs > 0 ? simSum / pairs : 0;
    clusters.push({
      id: sorted[0],
      members: sorted,
      size: members.length,
      cohesion,
    });
  }

  return clusters.sort((a, b) => b.size - a.size || b.cohesion - a.cohesion);
}

/** Helper: build a wallet → clusterId map for detectConsensus. */
export function clusterMap(clusters: WalletCluster[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of clusters) {
    for (const w of c.members) m.set(w, c.id);
  }
  return m;
}

export function clusterOf(wallet: string, clusters: WalletCluster[]): WalletCluster | null {
  return clusters.find((c) => c.members.includes(wallet)) ?? null;
}
