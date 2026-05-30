/**
 * Deep-dive analysis of a single tracked wallet — what categories they trade,
 * average size, win/loss, hold durations, recent activity. Writes a research
 * note summarising the pattern so our agents can learn from (not copy) it.
 *
 *   npx tsx scripts/analyze-tracked-wallet.ts <handle-or-proxy-wallet>
 *
 * If a handle (no 0x address) is passed, looks up the wallet via Gamma leaderboard.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { insertResearchNote } from "../src/lib/db/queries.ts";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: tsx scripts/analyze-tracked-wallet.ts <handle|0xaddress>");
  process.exit(2);
}

(async () => {
  let proxyWallet = arg;
  let userName: string | undefined;
  let claimedPnl: number | undefined;

  if (!/^0x[0-9a-fA-F]{40}$/.test(arg)) {
    const r = await fetch(`https://data-api.polymarket.com/v1/leaderboard?category=OVERALL&timePeriod=ALL&orderBy=PNL&limit=1&userName=${encodeURIComponent(arg)}`);
    const arr = (await r.json()) as Array<{ proxyWallet: string; userName: string; pnl: number; vol: number }>;
    if (!arr?.[0]?.proxyWallet) {
      console.error(`no leaderboard hit for handle "${arg}"`);
      process.exit(1);
    }
    proxyWallet = arr[0].proxyWallet;
    userName = arr[0].userName;
    claimedPnl = arr[0].pnl;
    console.log(`resolved "${arg}" → ${proxyWallet} (PnL all-time $${arr[0].pnl.toFixed(0)}, vol $${arr[0].vol.toFixed(0)})`);
  }

  // Pull broader data sets in parallel.
  const [trades, positions, closed, value, activity] = await Promise.all([
    poly.userTrades(proxyWallet, { limit: 500 }).catch(() => []),
    poly.userPositions(proxyWallet, { limit: 200 }).catch(() => []),
    fetch(`https://data-api.polymarket.com/closed-positions?user=${proxyWallet}&limit=200`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    poly.userValue(proxyWallet).catch(() => null),
    poly.userActivity(proxyWallet, { limit: 200 }).catch(() => []),
  ]);

  // --- Analysis ---
  const tradeArr = Array.isArray(trades) ? trades : [];
  const positionArr = Array.isArray(positions) ? positions : [];
  const closedArr = Array.isArray(closed) ? (closed as any[]) : [];

  const sizeBuckets = { lt10: 0, lt100: 0, lt1000: 0, gt1000: 0 };
  const sideTally = { BUY: 0, SELL: 0 };
  const titleTally = new Map<string, number>();
  const slugTally = new Map<string, number>();
  let totalUsdc = 0;
  let priceSum = 0;
  let priceN = 0;
  let firstTs = Infinity;
  let lastTs = 0;

  for (const t of tradeArr) {
    const t_any = t as any;
    const usd = Number(t_any.usdcSize ?? (t_any.size ?? 0) * (t_any.price ?? 0));
    totalUsdc += usd;
    if (usd < 10) sizeBuckets.lt10++;
    else if (usd < 100) sizeBuckets.lt100++;
    else if (usd < 1000) sizeBuckets.lt1000++;
    else sizeBuckets.gt1000++;
    const side = String(t_any.side ?? "").toUpperCase();
    if (side === "BUY" || side === "SELL") sideTally[side]++;
    if (t_any.title) titleTally.set(t_any.title, (titleTally.get(t_any.title) ?? 0) + 1);
    if (t_any.eventSlug) slugTally.set(t_any.eventSlug, (slugTally.get(t_any.eventSlug) ?? 0) + 1);
    if (t_any.price) { priceSum += Number(t_any.price); priceN++; }
    const ts = Number(t_any.timestamp ?? 0);
    if (ts > 0) { firstTs = Math.min(firstTs, ts); lastTs = Math.max(lastTs, ts); }
  }

  const topTitles = [...titleTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topSlugs = [...slugTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  // --- Pattern summary ---
  const summary = {
    proxyWallet,
    userName,
    claimedPnl,
    portfolioValue: value && typeof value === "object" ? (value as any).value : null,
    sampledTrades: tradeArr.length,
    sideTally,
    sizeBuckets,
    avgTradeUsd: tradeArr.length > 0 ? totalUsdc / tradeArr.length : 0,
    totalTradedUsd: totalUsdc,
    avgPricePerShare: priceN > 0 ? priceSum / priceN : 0,
    timeWindowDays: firstTs && lastTs ? (lastTs - firstTs) / 86400 : null,
    activeOpenPositions: positionArr.length,
    closedPositions: closedArr.length,
    topMarketsByFrequency: topTitles,
    topEventSlugsByFrequency: topSlugs,
  };

  console.log("\n=== Pattern summary ===");
  console.log(JSON.stringify(summary, null, 2));

  // --- Persist a research note ---
  const noteTitle = `Wallet study: @${userName ?? proxyWallet.slice(0, 8)}`;
  const body = `**Proxy wallet:** \`${proxyWallet}\`${userName ? `  •  **Handle:** @${userName}` : ""}${claimedPnl ? `  •  **PnL all-time:** $${Math.round(claimedPnl).toLocaleString()}` : ""}

**What they trade.** Sampled the most recent ${tradeArr.length} trades. Top markets by frequency:
${topTitles.length === 0 ? "(no trades returned)" : topTitles.map(([t, n], i) => `${i + 1}. **${n}×** ${t.slice(0, 100)}`).join("\n")}

**Size distribution (USDC):**
- < $10:    ${sizeBuckets.lt10}
- $10–100:  ${sizeBuckets.lt100}
- $100–1K:  ${sizeBuckets.lt1000}
- > $1K:    ${sizeBuckets.gt1000}
- mean trade: $${summary.avgTradeUsd.toFixed(2)}
- total traded across window: $${summary.totalTradedUsd.toLocaleString()}

**Side mix:** BUY ${sideTally.BUY} / SELL ${sideTally.SELL}.
**Avg entry price:** ${summary.avgPricePerShare.toFixed(3)} (close to 0.5 → market-making / latency; close to 0 or 1 → directional / longshot).
**Open positions:** ${summary.activeOpenPositions}  •  **Closed positions:** ${summary.closedPositions}

**How to use this in our algorithms** (per the source article + our own architecture):

1. **Do NOT auto-copy.** On-chain confirmation lag means by the time we see a trade, the edge they captured is gone — we'd pay a worse price.
2. **Use the *category distribution* to inform Quant-Arb's market filters.** If they live in 15-minute Ethereum Up/Down markets, that signals where the active arb is — but it also signals where dynamic fees apply and where competition is fiercest.
3. **Cross-reference their entries with our price-history feed.** For each trade, look up the 1m-fidelity history around the timestamp and compute the edge they realized vs the priced odds at entry. That's training data.
4. **Time-of-day pattern matters.** If 80% of their trades cluster in specific hours (e.g. US equity open), that's a microstructure signal worth replicating timing-wise.

(Source: 0x_Discover article 2026-04-17 + arxiv:2508.03474 Probabilistic Forest paper.)`;

  insertResearchNote({
    topic: noteTitle,
    body,
    source_urls_json: JSON.stringify([
      `https://polymarket.com/@${userName ?? proxyWallet}?tab=activity`,
      `https://polygonscan.com/address/${proxyWallet}`,
      "https://arxiv.org/abs/2508.03474",
    ]),
    confidence: 0.75,
    tags_json: JSON.stringify(["tracked-wallet", "wallet-study", "pattern-analysis"]),
  });
  console.log(`\nResearch note written: "${noteTitle}"`);

  // Also update tracked_wallets with the resolved proxy if it wasn't already.
  db().prepare(`UPDATE tracked_wallets SET proxy_wallet = ?, last_resolved = datetime('now') WHERE handle = ? AND proxy_wallet IS NULL`)
    .run(proxyWallet, arg);
})().catch((e) => { console.error(e); process.exit(1); });
