/**
 * Polymarket leaderboard scanner — auto-discover high-performing wallets and
 * add them to `tracked_wallets` so the existing backfill / analyze pipeline
 * picks them up.
 *
 *   npm run scan:leaderboard                  # one-shot pass
 *   npm run scan:leaderboard -- --dry          # don't write to DB, just print
 *
 * Strategy: pull the leaderboard across (DAY, WEEK, MONTH) × (PNL, VOL) and
 * upsert every wallet that meets the sustained-performance filter:
 *   - Appears in ≥ 2 of the 3 time windows (DAY/WEEK/MONTH) ordered by PnL
 *   - All-time PnL > MIN_PNL_USD
 *   - Volume > MIN_VOL_USD
 *
 * The goal isn't "copy these trades" — it's "have these wallets in our
 * watchlist so the next analyze-tracked-wallet / scan-wallet-stream pass
 * fingerprints them and we can spot consensus signals."
 *
 * Idempotent: tracked_wallets has a UNIQUE(handle) constraint; re-runs
 * upsert rather than duplicate.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";

const DRY = process.argv.includes("--dry");
const MIN_PNL_USD = Number(process.env.SCAN_MIN_PNL_USD ?? "5000");
const MIN_VOL_USD = Number(process.env.SCAN_MIN_VOL_USD ?? "10000");
const TOP_N_PER_WINDOW = Number(process.env.SCAN_TOP_N ?? "50");

type LeaderboardRow = { proxyWallet: string; userName?: string; pnl: number; vol: number };

const WINDOWS: Array<"DAY" | "WEEK" | "MONTH"> = ["DAY", "WEEK", "MONTH"];

(async () => {
  console.log(`[scan-leaderboard] starting (dry=${DRY}) — min_pnl=$${MIN_PNL_USD} min_vol=$${MIN_VOL_USD} top_n=${TOP_N_PER_WINDOW}`);

  // Pull leaderboards in parallel
  const pulls = WINDOWS.map(async (timePeriod) => {
    try {
      const rows = await poly.traderLeaderboard({
        category: "OVERALL",
        timePeriod,
        orderBy: "PNL",
        limit: TOP_N_PER_WINDOW,
      });
      return { timePeriod, rows: (rows as LeaderboardRow[]) ?? [] };
    } catch (err) {
      console.error(`[scan-leaderboard] ${timePeriod} fetch failed:`, (err as Error).message);
      return { timePeriod, rows: [] as LeaderboardRow[] };
    }
  });
  const results = await Promise.all(pulls);

  // Aggregate appearances + best stats
  type Agg = {
    proxyWallet: string;
    userName?: string;
    appearances: Set<string>;
    bestPnl: number;
    bestVol: number;
  };
  const byWallet = new Map<string, Agg>();
  for (const { timePeriod, rows } of results) {
    console.log(`[scan-leaderboard] ${timePeriod}: ${rows.length} rows`);
    for (const r of rows) {
      if (!r?.proxyWallet) continue;
      const k = r.proxyWallet.toLowerCase();
      const existing = byWallet.get(k) ?? {
        proxyWallet: r.proxyWallet,
        userName: r.userName,
        appearances: new Set<string>(),
        bestPnl: 0,
        bestVol: 0,
      };
      existing.appearances.add(timePeriod);
      if (Number(r.pnl) > existing.bestPnl) existing.bestPnl = Number(r.pnl);
      if (Number(r.vol) > existing.bestVol) existing.bestVol = Number(r.vol);
      if (!existing.userName && r.userName) existing.userName = r.userName;
      byWallet.set(k, existing);
    }
  }

  // Filter for sustained performers
  const candidates = [...byWallet.values()]
    .filter((w) => w.appearances.size >= 2)
    .filter((w) => w.bestPnl >= MIN_PNL_USD)
    .filter((w) => w.bestVol >= MIN_VOL_USD)
    .sort((a, b) => b.bestPnl - a.bestPnl);

  console.log(`[scan-leaderboard] ${candidates.length} sustained performers passed the filter`);

  if (candidates.length === 0) {
    console.log("[scan-leaderboard] nothing to add. Bye.");
    return;
  }

  const handle = db();
  const existingHandles = new Set(
    (handle.prepare("SELECT handle FROM tracked_wallets").all() as Array<{ handle: string }>).map((r) => r.handle.toLowerCase()),
  );
  const existingWallets = new Set(
    (handle
      .prepare("SELECT proxy_wallet FROM tracked_wallets WHERE proxy_wallet IS NOT NULL")
      .all() as Array<{ proxy_wallet: string }>).map((r) => r.proxy_wallet.toLowerCase()),
  );

  let inserted = 0;
  let updated = 0;
  for (const c of candidates) {
    const handleKey = (c.userName ?? c.proxyWallet).toLowerCase();
    const note = `auto-added by scan-leaderboard: appearances=${[...c.appearances].join(",")}, bestPnl=$${Math.round(c.bestPnl).toLocaleString()}, bestVol=$${Math.round(c.bestVol).toLocaleString()}`;
    const strategyLabel = `auto-leaderboard ${[...c.appearances].sort().join("+")}`;
    if (existingHandles.has(handleKey) || existingWallets.has(c.proxyWallet.toLowerCase())) {
      if (!DRY) {
        handle
          .prepare(
            `UPDATE tracked_wallets
                SET proxy_wallet = COALESCE(proxy_wallet, ?),
                    claimed_profit_usd = MAX(COALESCE(claimed_profit_usd, 0), ?),
                    strategy_label = COALESCE(strategy_label, ?),
                    note = COALESCE(note, ?),
                    last_resolved = datetime('now')
              WHERE handle = ? OR proxy_wallet = ?`,
          )
          .run(c.proxyWallet, c.bestPnl, strategyLabel, note, handleKey, c.proxyWallet);
      }
      updated++;
    } else {
      if (!DRY) {
        handle
          .prepare(
            `INSERT INTO tracked_wallets (handle, proxy_wallet, note, claimed_profit_usd, strategy_label, last_resolved)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
          )
          .run(handleKey, c.proxyWallet, note, c.bestPnl, strategyLabel);
      }
      inserted++;
    }
  }

  console.log(`[scan-leaderboard] ${DRY ? "DRY: would have " : ""}inserted=${inserted} updated=${updated}`);

  // Audit event (skipped on dry runs)
  if (!DRY && (inserted > 0 || updated > 0)) {
    insertEvolutionEvent({
      event_type: "scan-leaderboard",
      summary: `scan-leaderboard: +${inserted} new, ${updated} updated (filter pnl>=$${MIN_PNL_USD} vol>=$${MIN_VOL_USD})`,
      payload_json: JSON.stringify({
        inserted,
        updated,
        filter: { minPnlUsd: MIN_PNL_USD, minVolUsd: MIN_VOL_USD, topN: TOP_N_PER_WINDOW },
        topCandidates: candidates.slice(0, 10).map((c) => ({
          proxyWallet: c.proxyWallet,
          userName: c.userName,
          appearances: [...c.appearances],
          bestPnl: c.bestPnl,
          bestVol: c.bestVol,
        })),
      }),
    });
  }

  console.log("[scan-leaderboard] done.");
})().catch((err) => {
  console.error("[scan-leaderboard] FAILED:", err);
  process.exit(1);
});
