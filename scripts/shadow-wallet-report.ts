/**
 * shadow-wallet-report — judge the forward shadow (scripts/shadow-wallet.ts)
 * against the pre-registered criteria in COPY-BACKTEST-2026-06-11.md.
 *
 * Per wallet it computes:
 *   - fills + logical bets shadowed (1h collapse, same convention as the backtest),
 *   - median detection latency (non-stale fills),
 *   - copy-entry slippage vs the leader's fill at detection / +60s / +300s
 *     (BUY fills: recorded best ask − leader price; achieved offsets shown),
 *   - for RESOLVED markets: shadow-copy ROI vs the leader's ROI on the SAME
 *     bets ($100 equal-weight, entry at the recorded best ask per offset,
 *     leader early-exits mirrored at the SELL's recorded best bid), with the
 *     ≥$1k clip subset broken out (alwaysfade's load-bearing filter).
 *
 * Resolution comes from Gamma via poly.marketsByCondition — which passes
 * condition_ids as REPEATED params (comma-joined silently returns []; fixed
 * client, see src/lib/polymarket/client.ts:79) — and is cached in the shadow
 * DB's shadow_resolutions table.
 *
 *   npm run shadow:report
 */
import "./_env.ts";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { poly } from "../src/lib/polymarket/client.ts";
import { parseGammaResolvedMarket } from "../src/lib/wallets/copy-backtest.ts";
import {
  collapseFills,
  copyEntrySlippage,
  median,
  mean,
  settleCopyTrade,
  tokenWon,
  type FillForCollapse,
} from "../src/lib/wallets/shadow.ts";

// Same passport-first resolution as scripts/shadow-wallet.ts (not imported —
// that module starts the daemon loop on import).
const DB_PATH =
  process.env.SHADOW_WALLET_DB_PATH ??
  (existsSync("/Volumes/My Passport")
    ? "/Volumes/My Passport/hft-data/shadow-wallet.db"
    : resolve(process.cwd(), "data", "shadow-wallet.db"));

if (!existsSync(DB_PATH)) {
  console.error(`no shadow DB at ${DB_PATH} — run \`npm run shadow:run\` first`);
  process.exit(1);
}
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const OFFSETS = [0, 60, 300] as const;
const MIN_CLIP_USD = 1000; // alwaysfade's pre-registered filter

type TradeRow = {
  id: number; wallet: string; token_id: string; condition_id: string | null;
  question: string | null; side: "BUY" | "SELL"; leader_price: number;
  leader_usd: number; leader_ts_ms: number; detection_latency_ms: number; stale: number;
};
type SampleRow = {
  trade_id: number; offset_sec: number; sampled_ts_ms: number | null;
  best_bid: number | null; best_ask: number | null; spread: number | null;
};

// ── 1. refresh the resolution cache via Gamma ───────────────────────────────

async function refreshResolutions(): Promise<void> {
  const pending = (db.prepare(`
    SELECT DISTINCT condition_id FROM shadow_trades
     WHERE condition_id IS NOT NULL
       AND condition_id NOT IN (SELECT condition_id FROM shadow_resolutions WHERE resolved = 1)
  `).all() as Array<{ condition_id: string }>).map((r) => r.condition_id);
  if (!pending.length) return;

  const upsert = db.prepare(`
    INSERT INTO shadow_resolutions (condition_id, resolved, winning_index, clob_token_ids, closed_time, checked_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(condition_id) DO UPDATE SET
      resolved = excluded.resolved, winning_index = excluded.winning_index,
      clob_token_ids = excluded.clob_token_ids, closed_time = excluded.closed_time,
      checked_at = excluded.checked_at
  `);
  let resolved = 0;
  for (let i = 0; i < pending.length; i += 20) {
    const chunk = pending.slice(i, i + 20);
    let rows: any[] = [];
    try {
      rows = await poly.marketsByCondition(chunk); // REPEATED condition_ids params
    } catch (err) {
      console.warn(`  gamma chunk failed: ${(err as Error).message.slice(0, 120)}`);
      continue;
    }
    const byCondition = new Map<string, any>(rows.map((r) => [String(r.conditionId ?? ""), r]));
    for (const cid of chunk) {
      const parsed = parseGammaResolvedMarket(byCondition.get(cid));
      if (parsed) {
        upsert.run(cid, 1, parsed.winningIndex, JSON.stringify(parsed.clobTokenIds), parsed.closedTime ?? null);
        resolved++;
      } else {
        upsert.run(cid, 0, null, null, null);
      }
    }
  }
  console.log(`resolutions: ${pending.length} checked, ${resolved} newly resolved\n`);
}

// ── 2. report ───────────────────────────────────────────────────────────────

const fmtPct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
const fmtCents = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(2)}¢`);

function reportWallet(wallet: string, trades: TradeRow[], samplesByTrade: Map<number, Map<number, SampleRow>>): void {
  const resolutions = new Map<string, { winningIndex: number; clobTokenIds: string[] }>();
  for (const r of db.prepare(`SELECT condition_id, winning_index, clob_token_ids FROM shadow_resolutions WHERE resolved = 1`)
    .all() as Array<{ condition_id: string; winning_index: number; clob_token_ids: string }>) {
    try {
      resolutions.set(r.condition_id, { winningIndex: r.winning_index, clobTokenIds: JSON.parse(r.clob_token_ids) });
    } catch { /* skip malformed */ }
  }

  const live = trades.filter((t) => !t.stale);
  const buys = trades.filter((t) => t.side === "BUY");
  console.log(`\n━━ ${wallet} ━━`);
  console.log(`fills shadowed: ${trades.length} (${buys.length} BUY / ${trades.length - buys.length} SELL, ${trades.length - live.length} stale)`);
  const latS = median(live.map((t) => t.detection_latency_ms / 1000));
  console.log(`median detection latency: ${latS === null ? "—" : `${latS.toFixed(1)}s`} (live fills only)`);

  // slippage per offset, BUY fills, live only
  for (const off of OFFSETS) {
    const slips: number[] = [];
    const achieved: number[] = [];
    const spreads: number[] = [];
    for (const t of buys.filter((b) => !b.stale)) {
      const s = samplesByTrade.get(t.id)?.get(off);
      if (!s || s.sampled_ts_ms === null) continue;
      const slip = copyEntrySlippage("BUY", t.leader_price, { bestBid: s.best_bid, bestAsk: s.best_ask });
      if (slip !== null) {
        slips.push(slip);
        achieved.push((s.sampled_ts_ms - t.leader_ts_ms) / 1000);
        if (s.spread !== null) spreads.push(s.spread);
      }
    }
    const label = off === 0 ? "at detection" : `+${off}s`;
    console.log(
      `copy-entry slippage ${label.padEnd(12)}: median ${fmtCents(median(slips))}, mean ${fmtCents(mean(slips))}, ` +
      `spread med ${fmtCents(median(spreads))} (n=${slips.length}, achieved offset med ${median(achieved)?.toFixed(0) ?? "—"}s)`,
    );
  }

  // ── settled PnL on logical bets (1h collapse, $100 equal-weight) ──
  const tokenMeta = new Map<number, TradeRow>(trades.map((t) => [t.id, t]));
  const toFill = (t: TradeRow): FillForCollapse => ({
    id: t.id, tokenId: t.token_id, side: t.side, price: t.leader_price, usd: t.leader_usd, leaderTsMs: t.leader_ts_ms,
  });
  const buyBets = collapseFills(buys.map(toFill));
  const sells = trades.filter((t) => t.side === "SELL").sort((a, b) => a.leader_ts_ms - b.leader_ts_ms);

  for (const subset of [
    { name: "all bets", bets: buyBets },
    { name: `clips ≥$${MIN_CLIP_USD}`, bets: buyBets.filter((b) => b.usd >= MIN_CLIP_USD) },
  ]) {
    console.log(`\n  settled copy PnL — ${subset.name} (${subset.bets.length} logical bets):`);
    for (const off of OFFSETS) {
      let n = 0, wins = 0, copySum = 0, leaderSum = 0, pendingN = 0, unpriced = 0;
      for (const bet of subset.bets) {
        const first = tokenMeta.get(bet.firstFillId)!;
        const entrySample = samplesByTrade.get(bet.firstFillId)?.get(off);
        const res = first.condition_id ? resolutions.get(first.condition_id) : undefined;
        // mirror the leader's early exit: first SELL on the same token after the buy
        const exitFill = sells.find((s) => s.token_id === bet.tokenId && s.leader_ts_ms > bet.leaderTsMs);
        const exitSample = exitFill ? samplesByTrade.get(exitFill.id)?.get(off) : undefined;
        const won = res ? tokenWon(bet.tokenId, res) : null;
        if (won === null && !exitFill) { pendingN++; continue; }
        const settled = settleCopyTrade({
          copyEntry: entrySample?.best_ask ?? null,
          leaderEntry: bet.leaderVwap,
          won: won ?? false,
          exit: exitFill
            ? { copyExit: exitSample?.best_bid ?? null, leaderExit: exitFill.leader_price }
            : null,
        });
        if (!settled) { unpriced++; continue; }
        n++;
        if (settled.copyRoi > 0) wins++;
        copySum += settled.copyRoi;
        leaderSum += settled.leaderRoi;
      }
      const label = off === 0 ? "detect" : `+${off}s`;
      console.log(
        `    ${label.padEnd(7)}: n=${n} copy ROI ${fmtPct(n ? copySum / n : null)} ` +
        `vs leader ${fmtPct(n ? leaderSum / n : null)} (win ${fmtPct(n ? wins / n : null)}, ` +
        `${pendingN} unresolved, ${unpriced} unpriced)`,
      );
    }
  }
}

(async () => {
  await refreshResolutions();

  const trades = db.prepare(`SELECT * FROM shadow_trades ORDER BY leader_ts_ms`).all() as TradeRow[];
  const samples = db.prepare(`SELECT * FROM shadow_samples`).all() as SampleRow[];
  const samplesByTrade = new Map<number, Map<number, SampleRow>>();
  for (const s of samples) {
    if (!samplesByTrade.has(s.trade_id)) samplesByTrade.set(s.trade_id, new Map());
    samplesByTrade.get(s.trade_id)!.set(s.offset_sec, s);
  }

  console.log(`shadow-wallet report — db ${DB_PATH}`);
  console.log(`${trades.length} fills recorded across ${new Set(trades.map((t) => t.wallet)).size} wallets`);
  const wallets = [...new Set(trades.map((t) => t.wallet))];
  if (!wallets.length) {
    console.log("nothing shadowed yet — leaders are live-sports traders, mostly active during US game hours.");
  }
  for (const w of wallets) {
    reportWallet(w, trades.filter((t) => t.wallet === w), samplesByTrade);
  }

  console.log(`\npre-registered criteria (COPY-BACKTEST-2026-06-11.md — do not move):`);
  console.log(`  0x418d51e1…: shadow-copy ROI at recorded-latency entry > +5% over ≥25 new bets`);
  console.log(`  alwaysfade 0xe5b70fd8…: ≥$${MIN_CLIP_USD}-clip follow-edge > 0 over ≥20 positions`);
  console.log(`  kill on the data, either way.`);
  db.close();
})().catch((err) => {
  console.error("[shadow-wallet-report] FATAL:", err);
  process.exit(1);
});
