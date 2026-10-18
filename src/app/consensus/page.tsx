import Link from "next/link";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Row = {
  id: number;
  summary: string;
  payload_json: string;
  created_at: string;
};

type ConsensusPayload = {
  marketKey: string;
  marketTitle?: string;
  direction: string;
  wallets: Array<{ proxyWallet: string; trustTier: number; usd: number; ts: string }>;
  combinedTrust: number;
  combinedUsd: number;
  avgPrice: number;
  windowStart: string;
  windowEnd: string;
};

function safeParse(s: string): ConsensusPayload | null {
  try { return JSON.parse(s) as ConsensusPayload; } catch { return null; }
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default async function ConsensusPage() {
  const rows = db()
    .prepare(
      `SELECT id, summary, payload_json, created_at
         FROM evolution_log
         WHERE event_type = 'consensus-signal'
         ORDER BY created_at DESC
         LIMIT 100`,
    )
    .all() as Row[];

  // Map proxy_wallet → handle for nicer display
  const wallets = db()
    .prepare("SELECT proxy_wallet, handle FROM tracked_wallets WHERE proxy_wallet IS NOT NULL")
    .all() as Array<{ proxy_wallet: string; handle: string }>;
  const handleByProxy = new Map(wallets.map((w) => [w.proxy_wallet.toLowerCase(), w.handle]));

  // Last empty-scan event so the page can show "last scan ran X ago"
  const lastScan = db()
    .prepare(
      `SELECT created_at, payload_json FROM evolution_log
         WHERE event_type IN ('consensus-signal','consensus-scan-empty')
         ORDER BY created_at DESC LIMIT 1`,
    )
    .get() as { created_at: string; payload_json: string } | undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Cross-wallet consensus</h1>
        <p className="text-zinc-400 text-sm mt-1 max-w-3xl">
          When ≥3 tracked wallets take the same direction on the same market within a 30-minute window, that's a
          signal. This page tails the <code>consensus-signal</code> events from <code>evolution_log</code>.
          Refresh by running <code>npm run scan:consensus</code> (or the docker-compose <code>consensus</code> sidecar
          if added). Acting on these signals goes through the venue router + capsule + stage gates like anything else —
          this page is read-only.
        </p>
        {lastScan && (
          <div className="text-xs text-zinc-500 mt-2">
            Last scan: <span className="text-zinc-300">{new Date(lastScan.created_at).toISOString().replace("T", " ").slice(0, 19)}Z</span>
          </div>
        )}
      </div>

      <ConsensusThesisPanel />
      <RetroactiveConsensusPanel />


      {rows.length === 0 ? (
        <div className="card">
          <p className="text-sm text-zinc-400">
            No consensus signals logged yet. Run <code>npm run scan:consensus</code> to scan, or
            <code> npm run resolve:tracked</code> first if no proxy_wallets have been resolved.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const p = safeParse(row.payload_json);
            if (!p) return null;
            return (
              <div key={row.id} className="card">
                <div className="flex items-baseline justify-between mb-2">
                  <div>
                    <div className="text-sm text-zinc-300">
                      <span className="text-accent-blue tabular-nums">{p.wallets.length} wallets</span>{" "}
                      <span className={p.direction === "YES" || p.direction === "BUY" || p.direction === "UP" ? "text-accent-green" : "text-accent-red"}>
                        {p.direction}
                      </span>
                      {" "}{p.marketTitle?.slice(0, 80) ?? p.marketKey.slice(0, 12) + "…"}
                    </div>
                    <div className="text-xs text-zinc-500 mt-0.5">
                      avg price <span className="tabular-nums text-zinc-300">{p.avgPrice.toFixed(3)}</span>
                      {" · "}combined trust <span className="tabular-nums text-zinc-300">{p.combinedTrust}</span>
                      {" · "}combined size <span className="tabular-nums text-zinc-300">{fmtUsd(p.combinedUsd)}</span>
                      {" · "}window <span className="tabular-nums text-zinc-300">{new Date(p.windowStart).toISOString().slice(11, 16)} → {new Date(p.windowEnd).toISOString().slice(11, 16)}Z</span>
                    </div>
                  </div>
                  <div className="text-xs text-zinc-500">{new Date(row.created_at).toISOString().slice(11, 19)}Z</div>
                </div>
                <table className="list w-full text-xs">
                  <thead>
                    <tr><th>Wallet</th><th>Trust</th><th className="text-right">USD</th><th>Entered</th></tr>
                  </thead>
                  <tbody>
                    {p.wallets.map((w) => {
                      const h = handleByProxy.get(w.proxyWallet.toLowerCase());
                      return (
                        <tr key={w.proxyWallet}>
                          <td>
                            <Link href={`/wallets/${w.proxyWallet}`} className="font-mono text-accent-blue hover:underline">
                              {h ? `@${h}` : `${w.proxyWallet.slice(0, 8)}…${w.proxyWallet.slice(-4)}`}
                            </Link>
                          </td>
                          <td className="tabular-nums">{w.trustTier}</td>
                          <td className="text-right tabular-nums">{fmtUsd(w.usd)}</td>
                          <td className="text-zinc-500 text-[11px]">{new Date(w.ts).toISOString().slice(11, 19)}Z</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}

      <div className="card text-xs text-zinc-500">
        <strong className="text-zinc-300">How to use this.</strong> Don't treat any single signal as a buy order. Validate by:
        clicking through to each wallet's fingerprint (<code>/wallets/[address]</code>) and confirming they're not
        all bots running the same strategy, then either submit through <code>/api/venue/submit</code> with a capsuleId
        attached, or write a research-note via the Oracle LLM agent so a human can decide.
      </div>
    </div>
  );
}

/**
 * Surfaces the latest `npm run consensus:backtest` run — the platform's
 * own answer to "does the consensus signal actually pay off post-resolution?"
 * Tests the breadth-not-speed thesis on historical data.
 */
function ConsensusThesisPanel() {
  type Row = {
    run_id: string; slippage_bps: number; n_signals: number; win_rate: number;
    pnl_usd: number; pnl_pct: number; avg_winner_multiple: number; size_usd: number;
    signals_seen: number; signals_used: number; signals_skipped_unresolved: number;
    verdict_rating: string | null; verdict_reason: string | null;
    n_distinct_signals: number | null; config_json: string | null;
  };
  const latest = db().prepare(
    `SELECT run_id FROM consensus_backtest_results ORDER BY run_id DESC LIMIT 1`,
  ).get() as { run_id: string } | undefined;
  if (!latest) {
    return (
      <section className="card border-ink-800">
        <h2 className="card-title">Platform thesis test — consensus PnL</h2>
        <p className="text-xs text-zinc-500">
          No consensus backtest yet. Run{" "}
          <code className="text-zinc-300">npm run consensus:backtest -- --days 60 --window 60 --min 2</code>{" "}
          to settle every historical consensus signal against the resolved outcome of its market.
          The verdict tells you whether following the platform's breadth-not-speed signal pays off
          (after slippage) — not just whether any single whale is copyable.
        </p>
      </section>
    );
  }
  const rows = db().prepare(
    `SELECT run_id, slippage_bps, n_signals, win_rate, pnl_usd, pnl_pct,
            avg_winner_multiple, size_usd, signals_seen, signals_used,
            signals_skipped_unresolved, verdict_rating, verdict_reason,
            n_distinct_signals, config_json
       FROM consensus_backtest_results
      WHERE run_id = ? ORDER BY slippage_bps ASC`,
  ).all(latest.run_id) as Row[];
  if (rows.length === 0) return null;
  const sample = rows[0];
  let cfg: any = {};
  try { cfg = sample.config_json ? JSON.parse(sample.config_json) : {}; } catch {}
  const verdictColor = sample.verdict_rating === "profitable" ? "text-accent-green bg-accent-green/10 border-accent-green/30"
    : sample.verdict_rating === "marginal" ? "text-accent-amber bg-accent-amber/10 border-accent-amber/30"
    : sample.verdict_rating === "loss" ? "text-accent-red bg-accent-red/10 border-accent-red/30"
    : "text-zinc-400 bg-ink-900/50 border-ink-700";
  const verdictLabel = sample.verdict_rating?.replace(/_/g, " ").toUpperCase() ?? "—";

  return (
    <section className="card border-accent-blue/30">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="card-title m-0">Platform thesis test — does consensus pay off?</h2>
        <span className="text-[10px] text-zinc-500">
          run {new Date(latest.run_id).toLocaleString()} ·
          {cfg.days}d window · ≥{cfg.min_wallets} wallets / {cfg.window_min}min ·
          {sample.signals_used}/{sample.signals_seen} signals scorable
          {sample.signals_skipped_unresolved > 0 && `, ${sample.signals_skipped_unresolved} unresolved`}
        </span>
      </div>
      {sample.verdict_rating && (
        <div className={`mb-3 border rounded px-3 py-2 text-xs ${verdictColor}`}>
          <span className="font-semibold mr-2">{verdictLabel}</span>
          <span className="opacity-80">— {sample.verdict_reason}</span>
        </div>
      )}
      <p className="text-[11px] text-zinc-500 mb-3">
        For each historical consensus signal whose market has since resolved, we settle the implied
        bet at multiple slippage tiers. Bullish copy at $p winning pays (1−p)/p per dollar; losing
        pays −1. Read-only — re-run with{" "}
        <code className="text-zinc-300">npm run consensus:backtest -- --days N --window M --min K</code>.
      </p>
      <table className="list text-xs">
        <thead>
          <tr>
            <th>Slippage</th>
            <th className="text-right">Signals scored</th>
            <th className="text-right">Win rate</th>
            <th className="text-right">Total PnL</th>
            <th className="text-right">Per-signal PnL%</th>
            <th className="text-right">Avg winner ×</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = r.pnl_usd >= 0 ? "text-accent-green" : "text-accent-red";
            return (
              <tr key={r.slippage_bps}>
                <td className="text-zinc-300">{r.slippage_bps}bps</td>
                <td className="text-right tabular-nums text-zinc-400">{r.n_signals}</td>
                <td className="text-right tabular-nums text-zinc-400">{(r.win_rate * 100).toFixed(0)}%</td>
                <td className={`text-right tabular-nums ${color}`}>${r.pnl_usd.toFixed(2)}</td>
                <td className={`text-right tabular-nums ${color}`}>{(r.pnl_pct * 100).toFixed(1)}%</td>
                <td className="text-right tabular-nums text-zinc-400">{r.avg_winner_multiple.toFixed(2)}×</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Retroactive consensus — the platform thesis test done on resolved closed
 * positions instead of recent trades. Every signal here is by definition on
 * a settled market, so the verdict updates immediately without waiting for
 * future markets to resolve. Populated by `npm run consensus:retro`.
 */
function RetroactiveConsensusPanel() {
  type Bucket = {
    run_id: string; slippage_bps: number; n_signals: number; n_wins: number;
    win_rate: number; pnl_usd: number; pnl_pct: number; avg_winner_multiple: number;
    size_usd: number; verdict_rating: string | null; verdict_reason: string | null;
    n_distinct_signals: number | null; config_json: string | null;
  };
  type Signal = {
    condition_id: string; market_title: string | null; outcome: string | null;
    won: number; wallet_count: number; combined_trust: number; combined_usd: number;
    consensus_avg_price: number;
  };
  const latest = db().prepare(
    `SELECT run_id FROM retroactive_consensus_buckets ORDER BY run_id DESC LIMIT 1`,
  ).get() as { run_id: string } | undefined;
  if (!latest) {
    return (
      <section className="card border-ink-800">
        <h2 className="card-title">Retroactive consensus (closed positions)</h2>
        <p className="text-xs text-zinc-500">
          No retroactive run yet. Run <code className="text-zinc-300">npm run consensus:retro</code>{" "}
          to detect agreements across tracked wallets' <em>closed positions</em> (resolved by
          definition) and settle the implied copy-bet immediately. Bypasses the active-market
          bias that left the forward-looking thesis test at insufficient_data.
        </p>
      </section>
    );
  }
  const buckets = db().prepare(
    `SELECT run_id, slippage_bps, n_signals, n_wins, win_rate, pnl_usd, pnl_pct,
            avg_winner_multiple, size_usd,
            verdict_rating, verdict_reason, n_distinct_signals, config_json
       FROM retroactive_consensus_buckets
      WHERE run_id = ? ORDER BY slippage_bps ASC`,
  ).all(latest.run_id) as Bucket[];
  if (buckets.length === 0) return null;
  const sample = buckets[0];
  let cfg: any = {};
  try { cfg = sample.config_json ? JSON.parse(sample.config_json) : {}; } catch {}
  const topWinners = db().prepare(
    `SELECT condition_id, market_title, outcome, won, wallet_count, combined_trust,
            combined_usd, consensus_avg_price
       FROM retroactive_consensus_signals
      WHERE run_id = ?
      ORDER BY combined_usd DESC
      LIMIT 6`,
  ).all(latest.run_id) as Signal[];
  const losers = db().prepare(
    `SELECT condition_id, market_title, outcome, won, wallet_count, combined_trust,
            combined_usd, consensus_avg_price
       FROM retroactive_consensus_signals
      WHERE run_id = ? AND won = 0
      ORDER BY combined_usd DESC
      LIMIT 6`,
  ).all(latest.run_id) as Signal[];

  const verdictColor = sample.verdict_rating === "profitable" ? "text-accent-green bg-accent-green/10 border-accent-green/30"
    : sample.verdict_rating === "marginal" ? "text-accent-amber bg-accent-amber/10 border-accent-amber/30"
    : sample.verdict_rating === "loss" ? "text-accent-red bg-accent-red/10 border-accent-red/30"
    : "text-zinc-400 bg-ink-900/50 border-ink-700";
  const verdictLabel = sample.verdict_rating?.replace(/_/g, " ").toUpperCase() ?? "—";

  return (
    <section className="card border-accent-blue/30">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="card-title m-0">Retroactive consensus — settled signals only</h2>
        <span className="text-[10px] text-zinc-500">
          run {new Date(latest.run_id).toLocaleString()} · ≥{cfg.min_wallets} wallets / trust ≥{cfg.min_trust} ·
          {cfg.wallets_scanned} wallets scanned · {sample.n_distinct_signals} resolved signals
        </span>
      </div>
      {sample.verdict_rating && (
        <div className={`mb-3 border rounded px-3 py-2 text-xs ${verdictColor}`}>
          <span className="font-semibold mr-2">{verdictLabel}</span>
          <span className="opacity-80">— {sample.verdict_reason}</span>
        </div>
      )}
      <p className="text-[11px] text-zinc-500 mb-3">
        Built from <code>/closed-positions</code> across tracked wallets — every signal here is on a
        market that has <em>already resolved</em>. <strong className="text-zinc-300">Wallet-cohort
        caveat:</strong> if the cohort is heavily leaderboard-sourced (auto-discovered top-PnL
        traders), the test answers "do these wallets' agreements pay off" — which is exactly the
        copy-trade question, but expect a high baseline win rate by construction.
      </p>
      <table className="list text-xs">
        <thead>
          <tr>
            <th>Slippage</th>
            <th className="text-right">Signals</th>
            <th className="text-right">Win rate</th>
            <th className="text-right">Total PnL</th>
            <th className="text-right">Per-signal PnL%</th>
            <th className="text-right">Avg winner ×</th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => {
            const color = b.pnl_usd >= 0 ? "text-accent-green" : "text-accent-red";
            return (
              <tr key={b.slippage_bps}>
                <td className="text-zinc-300">{b.slippage_bps}bps</td>
                <td className="text-right tabular-nums text-zinc-400">{b.n_signals}</td>
                <td className="text-right tabular-nums text-zinc-400">{(b.win_rate * 100).toFixed(0)}%</td>
                <td className={`text-right tabular-nums ${color}`}>${b.pnl_usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                <td className={`text-right tabular-nums ${color}`}>{(b.pnl_pct * 100).toFixed(1)}%</td>
                <td className="text-right tabular-nums text-zinc-400">{b.avg_winner_multiple.toFixed(2)}×</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <div>
          <h3 className="text-xs text-zinc-400 mb-1">Top winners (by cohort USD)</h3>
          <table className="list text-[11px]">
            <thead><tr><th>Market</th><th className="text-right">Wallets</th><th className="text-right">Cohort $</th><th className="text-right">Entry</th></tr></thead>
            <tbody>
              {topWinners.map((s) => (
                <tr key={s.condition_id}>
                  <td className="text-zinc-300 truncate max-w-[28ch]" title={s.market_title ?? ""}>{s.outcome ? `${s.outcome}: ` : ""}{s.market_title ?? s.condition_id.slice(0, 10)}</td>
                  <td className="text-right tabular-nums text-zinc-400">{s.wallet_count}</td>
                  <td className="text-right tabular-nums text-zinc-400">${(s.combined_usd / 1000).toFixed(0)}k</td>
                  <td className="text-right tabular-nums text-zinc-400">${s.consensus_avg_price.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="text-xs text-zinc-400 mb-1">Losers ({losers.length})</h3>
          {losers.length === 0 ? (
            <p className="text-[11px] text-zinc-500 italic">No losing signals in this run.</p>
          ) : (
            <table className="list text-[11px]">
              <thead><tr><th>Market</th><th className="text-right">Wallets</th><th className="text-right">Cohort $</th><th className="text-right">Entry</th></tr></thead>
              <tbody>
                {losers.map((s) => (
                  <tr key={s.condition_id}>
                    <td className="text-accent-red truncate max-w-[28ch]" title={s.market_title ?? ""}>{s.outcome ? `${s.outcome}: ` : ""}{s.market_title ?? s.condition_id.slice(0, 10)}</td>
                    <td className="text-right tabular-nums text-zinc-400">{s.wallet_count}</td>
                    <td className="text-right tabular-nums text-zinc-400">${(s.combined_usd / 1000).toFixed(0)}k</td>
                    <td className="text-right tabular-nums text-zinc-400">${s.consensus_avg_price.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
