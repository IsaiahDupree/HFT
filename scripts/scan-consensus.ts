/**
 * Consensus signal detector — periodic.
 *
 *   npm run scan:consensus              # one-shot pass
 *   npm run scan:consensus -- --window 30 --min 3
 *
 * For each tracked_wallet with a resolved proxy_wallet, pulls the last
 * `--window` minutes of trades from the Data API, annotates with a trust
 * tier, and runs `detectConsensus()`. When ≥ `--min` wallets agree on a
 * (market, direction) within the window, emits a `consensus-signal` event
 * to evolution_log.
 *
 * Idempotent dedup: each signal is keyed by (marketKey, direction, windowStart-hour).
 * Re-running within the same hour on the same signal is a no-op.
 *
 * Trust tier is conservative:
 *   - 1 base
 *   - +1 if strategy_label starts with 'auto-leaderboard' (sustained performer)
 *   - +1 if claimed_profit_usd > $1M (high-PnL whale)
 *   - capped at 4
 *
 * Doesn't auto-trade. The signal lives in evolution_log and the /consensus
 * UI page; turning one into an order goes through the venue router + capsule
 * + stage pipeline like anything else.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";
import { detectConsensus, type ConsensusTrade } from "../src/lib/wallets/consensus.ts";

const args = process.argv.slice(2);
function flag(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  return fallback;
}

const WINDOW_MINUTES = flag("window", 30);
const MIN_WALLETS = flag("min", 3);
const MIN_TRUST = flag("trust", 3);
const MIN_USD = flag("usd", 0);
const PER_WALLET_LIMIT = flag("limit", 25);

function trustTierFor(row: { strategy_label: string | null; claimed_profit_usd: number | null }): number {
  let t = 1;
  if (row.strategy_label?.startsWith("auto-leaderboard")) t += 1;
  if ((row.claimed_profit_usd ?? 0) > 1_000_000) t += 1;
  if ((row.claimed_profit_usd ?? 0) > 5_000_000) t += 1;
  return Math.min(4, t);
}

(async () => {
  console.log(`[scan-consensus] window=${WINDOW_MINUTES}min minWallets=${MIN_WALLETS} minTrust=${MIN_TRUST} minUsd=$${MIN_USD}`);

  const handle = db();
  const wallets = handle.prepare(
    `SELECT proxy_wallet, handle, claimed_profit_usd, strategy_label
       FROM tracked_wallets
      WHERE proxy_wallet IS NOT NULL`,
  ).all() as Array<{ proxy_wallet: string; handle: string; claimed_profit_usd: number | null; strategy_label: string | null }>;
  console.log(`[scan-consensus] ${wallets.length} resolved wallets to scan`);

  if (wallets.length < MIN_WALLETS) {
    console.log(`[scan-consensus] fewer resolved wallets (${wallets.length}) than minWallets (${MIN_WALLETS}). Nothing to do.`);
    return;
  }

  // Pull recent trades per wallet in parallel (limited concurrency).
  const cutoffMs = Date.now() - WINDOW_MINUTES * 60_000;
  const allTrades: ConsensusTrade[] = [];

  const concurrent = 5;
  for (let i = 0; i < wallets.length; i += concurrent) {
    const batch = wallets.slice(i, i + concurrent);
    const results = await Promise.all(batch.map(async (w) => {
      try {
        const raw = await poly.userTrades(w.proxy_wallet, { limit: PER_WALLET_LIMIT });
        if (!Array.isArray(raw)) return [];
        const tier = trustTierFor(w);
        return (raw as any[])
          .filter((t) => {
            const tsRaw = Number(t.timestamp ?? 0);
            const ts = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
            return ts >= cutoffMs;
          })
          .map((t) => ({
            proxyWallet: w.proxy_wallet,
            trustTier: tier,
            marketKey: String(t.conditionId ?? t.eventSlug ?? "unknown"),
            marketTitle: t.title ?? t.slug,
            direction: String(t.outcome ?? t.side ?? "").toUpperCase(),
            usd: Number(t.usdcSize ?? Number(t.size ?? 0) * Number(t.price ?? 0)),
            price: Number(t.price ?? 0),
            ts: new Date((Number(t.timestamp ?? 0) > 1e12 ? Number(t.timestamp) : Number(t.timestamp) * 1000)).toISOString(),
          }) as ConsensusTrade)
          .filter((t) => t.marketKey !== "unknown" && t.direction && t.ts);
      } catch (err) {
        console.warn(`[scan-consensus] ${w.handle}: ${(err as Error).message}`);
        return [];
      }
    }));
    for (const r of results) allTrades.push(...r);
  }
  console.log(`[scan-consensus] ingested ${allTrades.length} recent trades across ${wallets.length} wallets`);

  const signals = detectConsensus(allTrades, {
    windowMinutes: WINDOW_MINUTES,
    minWallets: MIN_WALLETS,
    minCombinedTrust: MIN_TRUST,
    minCombinedUsd: MIN_USD,
  });

  console.log(`[scan-consensus] ${signals.length} consensus signal(s) detected`);
  if (signals.length === 0) {
    insertEvolutionEvent({
      event_type: "consensus-scan-empty",
      summary: `scan-consensus: no signals in last ${WINDOW_MINUTES}min across ${wallets.length} wallets`,
      payload_json: JSON.stringify({ window: WINDOW_MINUTES, minWallets: MIN_WALLETS, walletsScanned: wallets.length, tradesIngested: allTrades.length }),
    });
    return;
  }

  // Dedup window: signals are keyed on (marketKey, direction, windowStart hour).
  // If the same key was already logged this hour, skip.
  const hourBucket = (iso: string) => new Date(iso).toISOString().slice(0, 13); // yyyy-mm-ddThh
  const existing = handle.prepare(
    `SELECT payload_json FROM evolution_log
      WHERE event_type = 'consensus-signal' AND created_at >= datetime('now', '-1 hour')`,
  ).all() as Array<{ payload_json: string }>;
  const seen = new Set<string>();
  for (const e of existing) {
    try {
      const p = JSON.parse(e.payload_json);
      seen.add(`${p.marketKey}|${p.direction}|${hourBucket(p.windowStart ?? "")}`);
    } catch { /* ignore */ }
  }

  let logged = 0;
  for (const s of signals) {
    const dedupKey = `${s.marketKey}|${s.direction}|${hourBucket(s.windowStart)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    insertEvolutionEvent({
      event_type: "consensus-signal",
      summary: `consensus: ${s.wallets.length} wallets ${s.direction} "${(s.marketTitle ?? s.marketKey).slice(0, 60)}" @ ${s.avgPrice.toFixed(3)} (trust ${s.combinedTrust}, $${s.combinedUsd.toFixed(0)})`,
      payload_json: JSON.stringify(s),
    });
    logged++;
    console.log(`  ↳ ${s.wallets.length} wallets ${s.direction} ${(s.marketTitle ?? s.marketKey).slice(0, 50)} @ ${s.avgPrice.toFixed(3)}`);
  }
  console.log(`[scan-consensus] logged ${logged} new signals (${signals.length - logged} deduped within current hour)`);
})().catch((err) => { console.error("[scan-consensus] FAILED:", err); process.exit(1); });
