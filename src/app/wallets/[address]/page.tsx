import Link from "next/link";
import { notFound } from "next/navigation";
import { poly } from "@/lib/polymarket/client";
import { fingerprintWallet, type WalletFingerprint } from "@/lib/wallets/fingerprint";
import { classifyIntent, type IntentTrade, type WalletIntent } from "@/lib/wallets/intent";
import { scoreCopyability, type CopyabilityReport } from "@/lib/wallets/copyability";
import { classifyWalletTypology, type WalletTypology } from "@/lib/wallets/typology";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

function fmtUsd(n: number | null | undefined): string {
  return `$${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtPct(n: number | null | undefined, digits = 0): string {
  return `${(Number(n ?? 0) * 100).toFixed(digits)}%`;
}

async function fetchWalletData(address: string) {
  const [trades, openPositions, closedPositions, value] = await Promise.all([
    poly.userTrades(address, { limit: 500 }).catch(() => []),
    poly.userPositions(address, { limit: 200 }).catch(() => []),
    fetch(`https://data-api.polymarket.com/closed-positions?user=${address}&limit=200`)
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []),
    poly.userValue(address).catch(() => null),
  ]);
  return {
    trades: Array.isArray(trades) ? trades : [],
    openPositions: Array.isArray(openPositions) ? openPositions : [],
    closedPositions: Array.isArray(closedPositions) ? (closedPositions as any[]) : [],
    value: value as any,
  };
}

function intentBadge(label: WalletIntent["label"]): { label: string; color: string } {
  switch (label) {
    case "accumulation":     return { label: "Accumulating", color: "text-accent-green" };
    case "distribution":     return { label: "Distributing", color: "text-accent-amber" };
    case "basket_rotation":  return { label: "Basket rotation", color: "text-accent-amber" };
    case "scalp":            return { label: "Scalping", color: "text-accent-blue" };
    case "news_fade":        return { label: "News fade", color: "text-accent-blue" };
    case "idle":             return { label: "Idle", color: "text-zinc-500" };
    default:                 return { label: "Mixed", color: "text-zinc-400" };
  }
}

function copyabilityColor(score: number): string {
  if (score >= 70) return "text-accent-green";
  if (score >= 40) return "text-accent-amber";
  return "text-accent-red";
}

function typologyBadge(t: WalletTypology): { label: string; color: string; sub: string; subColor: string } {
  const label = t.primaryBucket.replace(/_/g, " ");
  const sub = t.copyabilityClass.replace(/_/g, " ");
  const colorByClass: Record<string, string> = {
    potentially_copyable: "text-accent-green",
    un_copyable: "text-accent-red",
    flagged_high_risk: "text-accent-red",
    needs_verification: "text-accent-amber",
    needs_more_data: "text-zinc-500",
    uninteresting: "text-zinc-500",
  };
  const subColor = colorByClass[t.copyabilityClass] ?? "text-zinc-300";
  return { label, color: "text-zinc-100", sub, subColor };
}

function familyBadge(family: WalletFingerprint["strategyFamily"]): { label: string; color: string } {
  switch (family) {
    case "latency_arb":
      return { label: "Latency arb (bot)", color: "text-accent-red" };
    case "market_making":
      return { label: "Market making (bot)", color: "text-accent-amber" };
    case "correlated_basket":
      return { label: "Correlated basket bot", color: "text-accent-amber" };
    case "directional_crypto_intraday":
      return { label: "Directional crypto", color: "text-accent-blue" };
    case "longshot_hunter":
      return { label: "Longshot hunter", color: "text-accent-blue" };
    case "low_signal":
      return { label: "Low signal (too few trades)", color: "text-zinc-500" };
    default:
      return { label: "Generalist", color: "text-zinc-300" };
  }
}

export default async function WalletPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) notFound();
  const { trades, openPositions, closedPositions, value } = await fetchWalletData(address);
  const fp = fingerprintWallet({
    proxyWallet: address,
    trades,
    openPositions,
    closedPositions,
  });
  const badge = familyBadge(fp.strategyFamily);

  // Intent classification — current-window view (last 60min by default)
  const intentTrades: IntentTrade[] = trades
    .filter((t: any) => t.side && t.conditionId && t.timestamp != null)
    .map((t: any) => {
      const tsRaw = Number(t.timestamp);
      const ms = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
      return {
        marketKey: String(t.conditionId),
        side: String(t.side).toUpperCase() === "SELL" ? "SELL" : "BUY",
        outcome: t.outcome,
        price: Number(t.price ?? 0),
        usd: Number(t.usdcSize ?? Number(t.size ?? 0) * Number(t.price ?? 0)),
        ts: new Date(ms).toISOString(),
      } as IntentTrade;
    });
  const intent60 = classifyIntent(intentTrades, { windowMinutes: 60 });
  const intent240 = classifyIntent(intentTrades, { windowMinutes: 240 });
  const intentBadge60 = intentBadge(intent60.label);

  // Copyability — uses closed positions PnL distribution
  const copy: CopyabilityReport = scoreCopyability({
    wallet: address,
    closedPositions: closedPositions as any[],
    trades: trades as any[],
  });

  // Typology — the "is this wallet copyable" decision layer
  const typology = classifyWalletTypology({
    wallet: address,
    fingerprint: fp,
    copyability: copy,
    portfolioValueUsd: value?.value ?? null,
  });
  const tBadge = typologyBadge(typology);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/tracked" className="text-xs text-zinc-500 hover:text-zinc-300">← all tracked wallets</Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1 font-mono">{address}</h1>
        <div className="flex gap-4 text-xs text-zinc-500 mt-2">
          <span>portfolio value: <span className="text-zinc-300 tabular-nums">{value?.value != null ? fmtUsd(value.value) : "—"}</span></span>
          <span>sampled trades: <span className="text-zinc-300 tabular-nums">{fp.sampledTrades}</span></span>
          <span>window: <span className="text-zinc-300 tabular-nums">{fp.windowDays != null ? `${fp.windowDays.toFixed(1)} days` : "—"}</span></span>
          <a href={`https://polymarket.com/profile/${address}`} target="_blank" rel="noopener noreferrer" className="text-accent-blue hover:underline">polymarket profile ↗</a>
          <a href={`https://polygonscan.com/address/${address}`} target="_blank" rel="noopener noreferrer" className="text-accent-blue hover:underline">polygonscan ↗</a>
          <Link href={`/wallets/${address}/timeline`} className="text-accent-blue hover:underline">classified timeline →</Link>
          <Link href={`/onchain/leverage/${address}`} className="text-accent-blue hover:underline">Aave advisor →</Link>
        </div>
      </div>

      <section className="card border-accent-blue/20">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title">Typology</h2>
          <div className="flex items-baseline gap-3">
            <span className={`text-sm font-medium ${tBadge.color}`}>{tBadge.label}</span>
            <span className={`text-xs uppercase tracking-wide ${tBadge.subColor}`}>{tBadge.sub}</span>
            <span className="text-xs text-zinc-500 tabular-nums">{(typology.confidence * 100).toFixed(0)}%</span>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3 text-xs mt-3">
          <div>
            <div className="text-zinc-500">Trades / day</div>
            <div className="tabular-nums text-zinc-300">{typology.features.tradesPerDay.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-zinc-500">Avg trade</div>
            <div className="tabular-nums text-zinc-300">{fmtUsd(typology.features.avgTradeUsd)}</div>
          </div>
          <div>
            <div className="text-zinc-500">MTM / |Realized|</div>
            <div className="tabular-nums text-zinc-300">
              {typology.features.mtmToRealizedRatio == null
                ? "—"
                : !Number.isFinite(typology.features.mtmToRealizedRatio)
                ? "∞"
                : typology.features.mtmToRealizedRatio.toFixed(1) + "×"}
            </div>
          </div>
          <div>
            <div className="text-zinc-500">≥$1k trade share</div>
            <div className="tabular-nums text-zinc-300">{(typology.features.largeTradeShare * 100).toFixed(0)}%</div>
          </div>
        </div>
        {typology.candidates.length > 1 && (
          <div className="mt-3 text-xs">
            <div className="text-zinc-500 mb-1">All candidates:</div>
            <ul className="space-y-0.5">
              {typology.candidates.slice(0, 4).map((c, i) => (
                <li key={i} className="text-zinc-400">
                  <span className="tabular-nums text-zinc-500">[{c.weight.toFixed(2)}]</span>{" "}
                  <span className="text-zinc-300">{c.bucket.replace(/_/g, " ")}</span> — {c.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {typology.resolutionPlan.length > 0 && (
          <div className="mt-3 text-xs">
            <div className="text-zinc-500 mb-1">To resolve uncertainty:</div>
            <ul className="list-disc pl-5 space-y-0.5 text-zinc-400">
              {typology.resolutionPlan.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}
        {typology.caveats.length > 0 && (
          <div className="mt-3 text-xs text-accent-amber">
            ⚠ {typology.caveats.join(" • ")}
          </div>
        )}
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title">Strategy fingerprint</h2>
          <span className={`text-sm font-medium ${badge.color}`}>{badge.label}</span>
        </div>
        <ul className="text-sm text-zinc-300 list-disc pl-5 space-y-1">
          {fp.classificationReasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
        {fp.caveats.length > 0 && (
          <div className="mt-3 text-xs text-accent-amber">
            ⚠ {fp.caveats.join(" • ")}
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div className="card">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="card-title">Current intent</h2>
            <span className={`text-sm font-medium ${intentBadge60.color}`}>{intentBadge60.label}</span>
          </div>
          <table className="list text-xs">
            <tbody>
              <tr><td className="text-zinc-500">Window</td><td className="tabular-nums">last 60 min ({intent60.tradesObserved} trades)</td></tr>
              <tr><td className="text-zinc-500">Confidence</td><td className="tabular-nums">{(intent60.confidence * 100).toFixed(0)}%</td></tr>
              <tr><td className="text-zinc-500">Buy / Sell</td><td className="tabular-nums">{(intent60.buyShare * 100).toFixed(0)}% / {(intent60.sellShare * 100).toFixed(0)}%</td></tr>
              <tr><td className="text-zinc-500">Distinct markets</td><td className="tabular-nums">{intent60.distinctMarkets}</td></tr>
              <tr><td className="text-zinc-500">USD deployed</td><td className="tabular-nums">{fmtUsd(intent60.totalUsd)}</td></tr>
              <tr><td className="text-zinc-500">4-hour label</td><td>{intentBadge(intent240.label).label} ({intent240.tradesObserved} trades)</td></tr>
            </tbody>
          </table>
          {intent60.reasons.length > 0 && (
            <ul className="mt-2 text-xs text-zinc-400 list-disc pl-5 space-y-1">
              {intent60.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
        </div>

        <div className="card">
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="card-title">Copyability</h2>
            <span className={`text-sm font-medium ${copyabilityColor(copy.copyabilityScore)}`}>
              {copy.copyabilityScore}/100
            </span>
          </div>
          <table className="list text-xs">
            <tbody>
              <tr><td className="text-zinc-500">Closed positions</td><td className="tabular-nums">{copy.observedClosed}</td></tr>
              <tr><td className="text-zinc-500">Win rate</td><td className="tabular-nums">{copy.winRate != null ? fmtPct(copy.winRate, 1) : "—"}</td></tr>
              <tr><td className="text-zinc-500">Avg PnL / close</td><td className={`tabular-nums ${(copy.avgPnlUsd ?? 0) >= 0 ? "text-accent-green" : "text-accent-red"}`}>{copy.avgPnlUsd != null ? fmtUsd(copy.avgPnlUsd) : "—"}</td></tr>
              <tr><td className="text-zinc-500">Median PnL</td><td className="tabular-nums">{copy.medianPnlUsd != null ? fmtUsd(copy.medianPnlUsd) : "—"}</td></tr>
              <tr><td className="text-zinc-500">PnL stdev</td><td className="tabular-nums">{copy.pnlStdevUsd != null ? fmtUsd(copy.pnlStdevUsd) : "—"}</td></tr>
              <tr><td className="text-zinc-500">Largest win / loss</td><td className="tabular-nums">{fmtUsd(copy.largestWinUsd)} / {fmtUsd(copy.largestLossUsd)}</td></tr>
              <tr><td className="text-zinc-500">Median hold</td><td className="tabular-nums">{copy.medianHoldMinutes != null ? `${copy.medianHoldMinutes.toFixed(0)} min` : "—"}</td></tr>
            </tbody>
          </table>
          {copy.caveats.length > 0 && (
            <div className="mt-2 text-xs text-accent-amber">
              ⚠ {copy.caveats.join(" • ")}
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div className="card">
          <h2 className="card-title mb-2">Cadence</h2>
          <table className="list text-xs">
            <tbody>
              <tr><td className="text-zinc-500">Bot-cadence score</td><td className={`tabular-nums ${fp.cadenceBotScore > 0.7 ? "text-accent-red" : fp.cadenceBotScore > 0.4 ? "text-accent-amber" : "text-accent-green"}`}>{(fp.cadenceBotScore * 100).toFixed(0)}%</td></tr>
              <tr><td className="text-zinc-500">Trades / hour</td><td className="tabular-nums">{fp.tradesPerHourMean.toFixed(2)}</td></tr>
              <tr><td className="text-zinc-500">Median interval</td><td className="tabular-nums">{fp.interTradeMedianSec.toFixed(1)}s</td></tr>
              <tr><td className="text-zinc-500">Interval stdev</td><td className="tabular-nums">{fp.interTradeStdevSec.toFixed(1)}s</td></tr>
              <tr><td className="text-zinc-500">Peak UTC hour</td><td className="tabular-nums">{fp.peakHourUtc}:00 ({fmtPct(fp.peakHourConcentrationPct)} within ±2h)</td></tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2 className="card-title mb-2">Sizing + categories</h2>
          <table className="list text-xs">
            <tbody>
              <tr><td className="text-zinc-500">Avg trade</td><td className="tabular-nums">{fmtUsd(fp.avgTradeUsd)}</td></tr>
              <tr><td className="text-zinc-500">Median trade</td><td className="tabular-nums">{fmtUsd(fp.medianTradeUsd)}</td></tr>
              <tr><td className="text-zinc-500">Largest trade</td><td className="tabular-nums">{fmtUsd(fp.maxTradeUsd)}</td></tr>
              <tr><td className="text-zinc-500">Crypto markets</td><td className="tabular-nums">{fmtPct(fp.cryptoPct)}</td></tr>
              <tr><td className="text-zinc-500">Top-category share</td><td className="tabular-nums">{fmtPct(fp.concentrationPct)}</td></tr>
              <tr><td className="text-zinc-500">Avg entry price</td><td className="tabular-nums">{fp.avgEntryPrice.toFixed(3)}</td></tr>
              <tr><td className="text-zinc-500">Midpoint entries</td><td className="tabular-nums">{fmtPct(fp.midpointEntryPct)}</td></tr>
              <tr><td className="text-zinc-500">Tail entries</td><td className="tabular-nums">{fmtPct(fp.tailEntryPct)}</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      {fp.correlatedBasketCohorts > 0 && (
        <section className="card border-accent-amber/30">
          <h2 className="card-title text-accent-amber mb-2">⚠ Correlated-basket cohorts: {fp.correlatedBasketCohorts}</h2>
          <p className="text-xs text-zinc-400 mb-2">
            Time windows where the wallet placed trades on ≥3 different crypto assets in the same direction.
            These look like independent bets but they're really one macro call — divide "effective independent bets" by ~the number of correlated assets.
          </p>
          <table className="list w-full text-xs">
            <thead><tr><th>Window start (UTC)</th><th>Direction</th><th>Assets</th><th className="text-right">Trades</th></tr></thead>
            <tbody>
              {fp.correlatedBasketExamples.map((e, i) => (
                <tr key={i}>
                  <td className="tabular-nums">{e.windowStart.slice(0, 16).replace("T", " ")}</td>
                  <td>{e.side}</td>
                  <td>{e.assets.join(", ")}</td>
                  <td className="text-right tabular-nums">{e.tradeCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2 className="card-title mb-2">Top markets ({fp.topTitles.length})</h2>
        {fp.topTitles.length === 0 ? (
          <p className="text-xs text-zinc-500">(no titled trades sampled)</p>
        ) : (
          <table className="list w-full text-xs">
            <thead><tr><th>#</th><th>Market</th><th className="text-right">Trades</th><th className="text-right">% of sample</th></tr></thead>
            <tbody>
              {fp.topTitles.map((t, i) => (
                <tr key={i}>
                  <td className="text-zinc-500">{i + 1}</td>
                  <td className="text-zinc-300">{t.title.slice(0, 100)}</td>
                  <td className="text-right tabular-nums">{t.count}</td>
                  <td className="text-right tabular-nums">{fmtPct(t.pct, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {(fp.realizedPnlUsd != null || fp.winRate != null) && (
        <section className="card">
          <h2 className="card-title mb-2">Realized performance (closed positions)</h2>
          <div className="grid grid-cols-3 gap-6 text-sm">
            <div>
              <div className="text-zinc-500 text-xs">Realized PnL</div>
              <div className={`tabular-nums text-lg ${(fp.realizedPnlUsd ?? 0) >= 0 ? "text-accent-green" : "text-accent-red"}`}>{fmtUsd(fp.realizedPnlUsd)}</div>
            </div>
            <div>
              <div className="text-zinc-500 text-xs">Win rate</div>
              <div className="tabular-nums text-lg">{fmtPct(fp.winRate, 1)}</div>
            </div>
            <div>
              <div className="text-zinc-500 text-xs">Closed positions</div>
              <div className="tabular-nums text-lg">{fp.sampledClosedPositions}</div>
            </div>
          </div>
        </section>
      )}

      <ResolvedBacktestPanel address={address} />
      <CopyBacktestPanel address={address} />

      <section className="card text-xs text-zinc-500">
        <p>
          <strong className="text-zinc-300">How to use this.</strong> Don't auto-copy any single wallet — by the time we see a trade,
          the edge they captured is gone (we'd pay a worse price). The right use is <em>cross-sectional</em>: run{" "}
          <code>npm run scan:leaderboard</code> + <code>npm run scan:wallets</code> across many wallets, then use the consensus
          detector (<code>src/lib/wallets/consensus.ts</code>) to surface markets where multiple high-trust wallets agree.
          Those signals are actionable over minutes-to-hours, not milliseconds.
        </p>
      </section>
    </div>
  );
}

/**
 * Shows the latest copy-trade backtest matrix for the wallet (lag × hold buckets,
 * win-rate and PnL per bucket). Sourced from `copy_backtest_results`; if no run
 * exists yet the panel surfaces a CLI hint instead of an empty table.
 */
function CopyBacktestPanel({ address }: { address: string }) {
  type Row = {
    run_id: string; lag_sec: number; hold_min: number;
    n_trades: number; win_rate: number; pnl_usd: number; pnl_pct: number;
    avg_drift_bps: number; size_usd: number; slippage_bps: number;
    trades_seen: number; trades_used: number;
  };
  const latestRun = db().prepare(
    `SELECT run_id FROM copy_backtest_results WHERE wallet_address = ?
       ORDER BY run_id DESC LIMIT 1`,
  ).get(address) as { run_id: string } | undefined;
  if (!latestRun) {
    return (
      <section className="card border-ink-800">
        <h2 className="card-title">Copy-trade backtest</h2>
        <p className="text-xs text-zinc-500">
          No backtest yet. Run <code className="text-zinc-300">npm run copy:backtest -- --wallet {address}</code>{" "}
          to compute the lag × hold matrix for this wallet. The backtester pulls the wallet's recent trades
          and the per-token Polymarket midpoint history, simulates copying at +10s / +1m / +5m / +15m lag,
          and reports PnL after slippage at multiple hold horizons.
        </p>
      </section>
    );
  }
  const rows = db().prepare(
    `SELECT run_id, lag_sec, hold_min, n_trades, win_rate, pnl_usd, pnl_pct,
            avg_drift_bps, size_usd, slippage_bps, trades_seen, trades_used
       FROM copy_backtest_results
      WHERE wallet_address = ? AND run_id = ?
      ORDER BY lag_sec ASC, hold_min ASC`,
  ).all(address, latestRun.run_id) as Row[];
  if (rows.length === 0) return null;

  const lags = Array.from(new Set(rows.map((r) => r.lag_sec))).sort((a, b) => a - b);
  const holds = Array.from(new Set(rows.map((r) => r.hold_min))).sort((a, b) => a - b);
  const byKey = new Map(rows.map((r) => [`${r.lag_sec}|${r.hold_min}`, r]));
  const sample = rows[0];
  const best = rows
    .filter((r) => r.n_trades >= 3)
    .sort((a, b) => b.pnl_usd - a.pnl_usd)[0];

  return (
    <section className="card">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="card-title m-0">Copy-trade backtest matrix</h2>
        <span className="text-[10px] text-zinc-500">
          run {new Date(latestRun.run_id).toLocaleString()} ·
          size ${sample.size_usd.toFixed(0)} · slippage {sample.slippage_bps}bps ·
          {sample.trades_used}/{sample.trades_seen} trades scorable
        </span>
      </div>
      <p className="text-[11px] text-zinc-500 mb-3">
        Cells = net PnL in USD per copied trade after slippage. Win% in parens. Cells with ≥3 trades are highlighted.
        {best && (
          <span className="ml-1 text-zinc-300">
            Best: lag {best.lag_sec}s / hold {best.hold_min}min →{" "}
            <span className={best.pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"}>
              ${best.pnl_usd.toFixed(2)}
            </span>{" "}
            on {best.n_trades} trades ({(best.win_rate * 100).toFixed(0)}% wins).
          </span>
        )}
      </p>
      <table className="list text-xs">
        <thead>
          <tr>
            <th className="text-zinc-500">lag ↓ / hold →</th>
            {holds.map((h) => (
              <th key={h} className="text-right">{h === -1 ? "natural" : h < 60 ? `${h}m` : `${(h / 60).toFixed(0)}h`}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lags.map((lag) => (
            <tr key={lag}>
              <td className="text-zinc-300">{lag < 60 ? `${lag}s` : `${Math.round(lag / 60)}m`}</td>
              {holds.map((h) => {
                const r = byKey.get(`${lag}|${h}`);
                if (!r || r.n_trades === 0) return <td key={h} className="text-right text-zinc-700">—</td>;
                const color = r.pnl_usd >= 0 ? "text-accent-green" : "text-accent-red";
                const dim = r.n_trades < 3 ? "opacity-50" : "";
                return (
                  <td key={h} className={`text-right tabular-nums ${color} ${dim}`}>
                    ${r.pnl_usd.toFixed(2)}
                    <span className="text-zinc-500 ml-1">({(r.win_rate * 100).toFixed(0)}%, n={r.n_trades})</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Resolved-outcome backtest: copy each trade and settle against the binary
 * market result. Unlike the midpoint matrix, this works on every wallet trade
 * whose market has resolved — slippage is the only free parameter.
 */
function ResolvedBacktestPanel({ address }: { address: string }) {
  type Row = {
    run_id: string; slippage_bps: number; n_trades: number; n_wins: number;
    win_rate: number; pnl_usd: number; pnl_pct: number; avg_winner_multiple: number;
    size_usd: number; trades_seen: number; trades_used: number;
    trades_skipped_unresolved: number; trades_after_dedup: number | null;
    distinct_markets_used: number | null; verdict_rating: string | null; verdict_reason: string | null;
  };
  const latestRun = db().prepare(
    `SELECT run_id FROM copy_backtest_resolved WHERE wallet_address = ?
       ORDER BY run_id DESC LIMIT 1`,
  ).get(address) as { run_id: string } | undefined;
  if (!latestRun) {
    return (
      <section className="card border-ink-800">
        <h2 className="card-title">Resolved-outcome backtest</h2>
        <p className="text-xs text-zinc-500">
          No resolved backtest yet. Run{" "}
          <code className="text-zinc-300">npm run copy:backtest -- --wallet {address} --skip-midpoint</code>{" "}
          to settle each trade against the binary outcome of its (now-resolved) market.
          Bullish copy at price p winning → payout (1−p)/p per dollar. Losing → −1.
        </p>
      </section>
    );
  }
  const rows = db().prepare(
    `SELECT run_id, slippage_bps, n_trades, n_wins, win_rate, pnl_usd, pnl_pct,
            avg_winner_multiple, size_usd, trades_seen, trades_used, trades_skipped_unresolved,
            trades_after_dedup, distinct_markets_used, verdict_rating, verdict_reason
       FROM copy_backtest_resolved
      WHERE wallet_address = ? AND run_id = ?
      ORDER BY slippage_bps ASC`,
  ).all(address, latestRun.run_id) as Row[];
  if (rows.length === 0) return null;
  const sample = rows[0];
  const verdictColor = sample.verdict_rating === "profitable" ? "text-accent-green bg-accent-green/10 border-accent-green/30"
    : sample.verdict_rating === "marginal" ? "text-accent-amber bg-accent-amber/10 border-accent-amber/30"
    : sample.verdict_rating === "loss" ? "text-accent-red bg-accent-red/10 border-accent-red/30"
    : "text-zinc-400 bg-ink-900/50 border-ink-700";
  const verdictLabel = sample.verdict_rating?.replace(/_/g, " ").toUpperCase() ?? "—";

  return (
    <section className="card border-accent-blue/30">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="card-title m-0">Resolved-outcome backtest</h2>
        <span className="text-[10px] text-zinc-500">
          run {new Date(latestRun.run_id).toLocaleString()} · size ${sample.size_usd.toFixed(0)} ·
          {sample.trades_after_dedup != null
            ? ` ${sample.trades_used}/${sample.trades_after_dedup} (${sample.trades_seen} raw → ${sample.trades_after_dedup} after slug-dedup)`
            : ` ${sample.trades_used}/${sample.trades_seen} trades`}
          {sample.trades_skipped_unresolved > 0 && `, ${sample.trades_skipped_unresolved} unresolved`}
          {sample.distinct_markets_used != null && `, ${sample.distinct_markets_used} distinct markets`}
        </span>
      </div>
      {sample.verdict_rating && (
        <div className={`mb-3 border rounded px-3 py-2 text-xs ${verdictColor}`}>
          <span className="font-semibold mr-2">{verdictLabel}</span>
          <span className="opacity-80">— {sample.verdict_reason}</span>
        </div>
      )}
      <p className="text-[11px] text-zinc-500 mb-3">
        Each trade settled against the binary outcome of its resolved market. Per-dollar PnL is highly
        asymmetric: bullish copy at $p winning pays (1−p)/p, losing pays −1. Slugged orders on the same
        (market, side) within 1h are collapsed into one logical bet before scoring.
      </p>
      <table className="list text-xs">
        <thead>
          <tr>
            <th>Slippage</th>
            <th className="text-right">Trades</th>
            <th className="text-right">Win rate</th>
            <th className="text-right">Total PnL</th>
            <th className="text-right">Per-copy PnL%</th>
            <th className="text-right">Avg winner ×</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = r.pnl_usd >= 0 ? "text-accent-green" : "text-accent-red";
            return (
              <tr key={r.slippage_bps}>
                <td className="text-zinc-300">{r.slippage_bps}bps</td>
                <td className="text-right tabular-nums text-zinc-400">{r.n_trades}</td>
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
