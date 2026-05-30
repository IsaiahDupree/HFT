import Link from "next/link";
import { Sparkline } from "@/components/Sparkline";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PromoteToLiveButton } from "@/components/PromoteToLiveButton";
import { GovernanceCard } from "@/components/GovernanceCard";
import { equityCurveForAgent, getPaperAgent, listTradesForAgent, toLiveAgent } from "@/lib/arena/db";
import { scoreAgent, liveEquity } from "@/lib/arena/score";
import { loadRecentCandles, velocity, acceleration } from "@/lib/arena/momentum";
import { buildLiveTickContext } from "@/lib/arena/context";
import { decide } from "@/lib/arena/sim";
import { db } from "@/lib/db/client";
import { parseGenome } from "@/lib/arena/genome";
import type { Genome } from "@/lib/arena/genome";

export const dynamic = "force-dynamic";

export default async function ArenaAgentDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agentId = Number(id);
  if (!Number.isFinite(agentId)) return <p className="text-accent-red text-xs">invalid id</p>;
  const row = getPaperAgent(agentId);
  if (!row) return <p className="text-accent-red text-xs">paper_agent {agentId} not found</p>;
  const live = toLiveAgent(row);
  const score = scoreAgent(row);
  const trades = listTradesForAgent(agentId, 100);
  const equity = equityCurveForAgent(agentId);
  const equityValues = equity.map((p) => p.equity);

  // ----- Live decision context: what is this agent SEEING right now? -----
  // Run the agent's own decide() against current market state so the page
  // shows the verdict (FIRE / HOLD with rationale) it would emit on the
  // next tick. Read-only — no DB writes, no position changes.
  const liveCtx = buildLiveTickContext({ historyDays: 7 });
  let liveDecision: { kind: string; rationale?: string; market_id?: string; side?: string; size_usd?: number } | null = null;
  let liveContextRows: Array<{ label: string; value: string; ok?: boolean }> = [];
  try {
    const sig = decide(live, liveCtx, Math.random);
    liveDecision = sig.kind === "hold"
      ? { kind: "hold" }
      : sig.kind === "entry"
        ? { kind: "entry", side: sig.side, market_id: sig.market_id, size_usd: sig.size_usd, rationale: sig.rationale }
        : { kind: "exit", market_id: sig.market_id, rationale: sig.rationale };

    // Show momentum context when the genome's a coinbase momentum strategy.
    const g = live.genome as Genome;
    if (g.kind === "cb_momentum_burst") {
      const p = g.params;
      const candles = loadRecentCandles(p.product_id, Math.max(p.vel_window_min * 2 + 5, 30));
      const v = velocity(candles, p.vel_window_min);
      const a = acceleration(candles, p.vel_window_min);
      const latest = candles[candles.length - 1];
      liveContextRows = [
        { label: "product", value: p.product_id },
        { label: "candles available", value: `${candles.length} × 1-min`, ok: candles.length >= p.vel_window_min + 2 },
        { label: "current price", value: latest ? `$${latest.close.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "—" },
        { label: `velocity (${p.vel_window_min}m)`, value: Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(3)}%` : "—", ok: Number.isFinite(v) && v >= p.vel_entry_pct },
        { label: "vel entry threshold", value: `≥ +${(p.vel_entry_pct * 100).toFixed(3)}%` },
        { label: "acceleration", value: Number.isFinite(a) ? `${a >= 0 ? "+" : ""}${(a * 100).toFixed(3)}%` : "—", ok: Number.isFinite(a) && a >= p.accel_min },
        { label: "accel threshold", value: `≥ +${(p.accel_min * 100).toFixed(3)}%` },
        { label: "direction_bias", value: p.direction_bias },
        { label: "entry size", value: `$${p.entry_size_usd.toFixed(2)}` },
        { label: "open positions", value: `${live.positions.length}`, ok: live.positions.length === 0 },
      ];
    } else if (g.kind === "cb_breakout" || g.kind === "cb_mean_reversion") {
      const p = g.params as { product_id: string };
      const candles = loadRecentCandles(p.product_id, 1440);
      const latest = candles[candles.length - 1];
      liveContextRows = [
        { label: "product", value: p.product_id },
        { label: "candles available", value: `${candles.length} × 1-min` },
        { label: "current price", value: latest ? `$${latest.close.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : "—" },
        { label: "open positions", value: `${live.positions.length}` },
      ];
    } else if (g.kind === "random_walk_baseline") {
      const p = g.params;
      liveContextRows = [
        { label: "trade_prob (per tick)", value: `${(p.trade_prob * 100).toFixed(1)}%` },
        { label: "buy_bias_pct", value: `${(p.buy_bias_pct * 100).toFixed(0)}%` },
        { label: "entry size", value: `$${p.entry_size_usd.toFixed(2)}` },
        { label: "open positions", value: `${live.positions.length}` },
      ];
    }
  } catch {
    liveDecision = null;
  }

  // Live-capsule binding check for the "Promote to live" button — disable if
  // the agent already owns a paper/live capsule.
  const liveCapsule = db().prepare(
    `SELECT id, status FROM capsules WHERE paper_agent_id = ? AND status IN ('paper','live') LIMIT 1`,
  ).get(agentId) as { id: string; status: string } | undefined;

  // Strategy kind for governance card — used to filter calibration / decisions
  // when no capsule is bound. Genome JSON always carries the kind.
  let strategyKindForGov: string | undefined;
  try {
    strategyKindForGov = parseGenome(row.genome_json).kind;
  } catch {
    strategyKindForGov = undefined;
  }

  return (
    <div className="space-y-6">
      <AutoRefresh label={`agent-${row.id}`} intervalMs={15_000} />
      <div>
        <Link href="/arena" className="text-xs text-zinc-500 hover:text-zinc-300">← arena</Link>
        <div className="mt-1 flex items-center gap-2">
          <h1 className="text-2xl font-semibold">{row.name}</h1>
          {row.is_elite ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/20 text-accent-amber border border-accent-amber/40">ELITE</span> : null}
          {liveCapsule ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-green/20 text-accent-green border border-accent-green/40">{liveCapsule.status.toUpperCase()} CAPSULE</span> : null}
        </div>
        <p className="text-xs text-zinc-500">
          gen {row.generation} · {row.alive ? "alive" : `retired (${row.retire_reason ?? "unknown"})`} ·
          parent {row.parent_paper_agent_id ?? "—"} · introduced by {row.introduced_by} ·
          <Link href={`/arena/lineage/${row.id}`} className="ml-1 hover:text-accent-blue">view lineage →</Link>
        </p>
        {row.alive && row.entries_count > 0 && (
          <PromoteToLiveButton
            agentId={agentId}
            agentName={row.name}
            isElite={!!row.is_elite}
            hasLiveCapsule={!!liveCapsule}
          />
        )}
      </div>

      {/* Governance — per-agent view of decision pipeline + portfolio governance.
       *  Inline diversity profile, capsule state, recent decisions, calibration,
       *  governor / killswitch events. Reads strategy_kind from the genome so
       *  calibration filtering works without a capsule binding too. */}
      <GovernanceCard paperAgentId={agentId} strategyKind={strategyKindForGov} />

      {/* Live decision context — what would this agent do right now? */}
      <section className={`card ${liveDecision?.kind === "entry" ? "border-accent-green/40" : liveDecision?.kind === "exit" ? "border-accent-amber/40" : "border-ink-700"}`} data-testid="agent-live-context">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="card-title m-0">Live decision context</h2>
          <span className="text-[10px] text-zinc-500">computed from current market state · refreshes every 15s</span>
        </div>
        {liveDecision == null ? (
          <p className="text-xs text-accent-red">decide() crashed — check the strategy implementation in src/lib/arena/sim.ts</p>
        ) : (
          <>
            <div className="flex items-baseline gap-3 mb-3">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Would-fire verdict</span>
              {liveDecision.kind === "entry" ? (
                <span className="pill-green font-semibold">FIRE {liveDecision.side} · ${liveDecision.size_usd?.toFixed(2)} {liveDecision.market_id?.split("-")[0]}</span>
              ) : liveDecision.kind === "exit" ? (
                <span className="pill-amber font-semibold">EXIT {liveDecision.market_id?.split("-")[0]}</span>
              ) : (
                <span className="pill-blue">HOLD (thresholds not met)</span>
              )}
              {liveDecision.rationale && (
                <span className="text-xs text-zinc-400 italic">{liveDecision.rationale}</span>
              )}
            </div>
            {liveContextRows.length > 0 ? (
              <table className="w-full text-xs">
                <tbody>
                  {liveContextRows.map((r) => (
                    <tr key={r.label}>
                      <td className="text-zinc-500 py-0.5 w-1/2">{r.label}</td>
                      <td className={`text-right tabular-nums py-0.5 ${r.ok === true ? "text-accent-green" : r.ok === false ? "text-accent-red" : "text-zinc-200"}`}>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-zinc-500 italic">No live context view implemented for genome kind <code>{live.genome.kind}</code> yet.</p>
            )}
            <p className="text-[10px] text-zinc-500 mt-3 italic">
              Verdict computed by calling the agent's own <code>decide()</code> against the live TickContext — same code
              path the scheduled tick worker uses. If you see HOLD here, that's why it isn't trading: the genome's
              entry thresholds aren't being met by current market conditions.
            </p>
          </>
        )}
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="card-title m-0">Equity curve ({equity.length - 1} closed trades)</h2>
          <span className="text-[10px] text-zinc-500">
            ${equityValues[0]?.toFixed(2) ?? "—"} → ${equityValues[equityValues.length - 1]?.toFixed(2) ?? "—"}
          </span>
        </div>
        <div className="mt-2">
          <Sparkline values={equityValues} width={760} height={80} stroke={(equityValues[equityValues.length - 1] ?? 0) >= (equityValues[0] ?? 0) ? "#46d39a" : "#ff6e6e"} />
        </div>
      </section>

      <section className="grid grid-cols-5 gap-4">
        <Stat label="Equity" value={`$${liveEquity(row).toFixed(2)}`} hint={`cash $${row.cash_usd_current.toFixed(2)} + locked $${(liveEquity(row) - row.cash_usd_current - row.unrealized_pnl_usd).toFixed(2)} + unr $${row.unrealized_pnl_usd.toFixed(2)}`} />
        <Stat label="Realized PnL" value={`$${row.realized_pnl_usd.toFixed(2)}`} className={row.realized_pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"} />
        <Stat label="Fitness" value={score.fitness.toFixed(4)} hint={`${(score.pnl_pct * 100).toFixed(2)}% − 2 × ${(score.max_dd_pct * 100).toFixed(2)}%`} className={score.fitness >= 0 ? "text-accent-green" : "text-accent-red"} />
        <Stat label="Entries" value={String(row.entries_count)} hint="positions opened (incl. still-open)" />
        <Stat label="Round-trips / Wins" value={`${row.trades_count} / ${row.wins_count}`} hint={`win rate ${(score.win_rate * 100).toFixed(0)}% · only closed positions`} />
      </section>

      <section className="card">
        <h2 className="card-title">Genome ({live.genome.kind})</h2>
        <pre className="text-[11px] text-zinc-300 overflow-auto">{JSON.stringify(live.genome.params, null, 2)}</pre>
      </section>

      <section className="card">
        <h2 className="card-title">Open positions ({live.positions.length})</h2>
        {live.positions.length === 0 ? (
          <p className="text-xs text-zinc-500">none</p>
        ) : (
          <table className="list">
            <thead><tr><th>Venue</th><th>Market</th><th>Side</th><th className="text-right">Size</th><th className="text-right">Entry</th><th>Target</th><th>Stop</th><th>Time stop</th></tr></thead>
            <tbody>
              {live.positions.map((p, i) => (
                <tr key={i}>
                  <td className="text-xs text-zinc-500">{p.venue.replace("sim-", "")}</td>
                  <td className="text-zinc-100">{p.market_id.slice(0, 24)}{p.market_id.length > 24 ? "…" : ""}</td>
                  <td className={p.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{p.side}</td>
                  <td className="text-right tabular-nums">${p.size_usd.toFixed(2)}</td>
                  <td className="text-right tabular-nums">{p.entry_price.toFixed(4)}</td>
                  <td className="text-xs text-zinc-400">{p.target_price?.toFixed(4) ?? "—"}</td>
                  <td className="text-xs text-zinc-400">{p.stop_price?.toFixed(4) ?? "—"}</td>
                  <td className="text-xs text-zinc-500">{p.time_stop_at ? new Date(p.time_stop_at).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Trades (last 100)</h2>
        {trades.length === 0 ? (
          <p className="text-xs text-zinc-500">none</p>
        ) : (
          <table className="list">
            <thead><tr><th>Time</th><th>Venue</th><th>Market</th><th>Intent</th><th>Side</th><th className="text-right">Px</th><th className="text-right">$Size</th><th className="text-right">PnL</th><th>Why</th></tr></thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id}>
                  <td className="text-xs text-zinc-500">{new Date(t.tick_at).toLocaleString()}</td>
                  <td className="text-xs text-zinc-500">{t.venue.replace("sim-", "")}</td>
                  <td className="text-zinc-100 text-xs">{t.market_id.slice(0, 18)}{t.market_id.length > 18 ? "…" : ""}</td>
                  <td className={t.intent === "entry" ? "text-accent-blue" : "text-accent-amber"}>{t.intent}</td>
                  <td className={t.side === "BUY" ? "text-accent-green" : "text-accent-red"}>{t.side}</td>
                  <td className="text-right tabular-nums">{t.price.toFixed(4)}</td>
                  <td className="text-right tabular-nums">${t.size_usd.toFixed(2)}</td>
                  <td className={`text-right tabular-nums ${(t.realized_pnl_usd ?? 0) > 0 ? "text-accent-green" : (t.realized_pnl_usd ?? 0) < 0 ? "text-accent-red" : "text-zinc-500"}`}>
                    {t.realized_pnl_usd != null ? `$${t.realized_pnl_usd.toFixed(2)}` : "—"}
                  </td>
                  <td className="text-xs text-zinc-500">{t.signal_rationale?.slice(0, 40)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, hint, className }: { label: string; value: string; hint?: string; className?: string }) {
  return (
    <div className="card">
      <div className="card-title">{label}</div>
      <div className={`stat ${className ?? ""}`}>{value}</div>
      {hint && <div className="text-[10px] text-zinc-500 mt-1">{hint}</div>}
    </div>
  );
}
