/**
 * /binaries — dashboard for Polymarket short-duration Up/Down events.
 *
 * Three sections:
 *   1. Active: upcoming binaries with countdown, asset, current YES mid,
 *      and a count of paper agents holding positions on them.
 *   2. Recently resolved: the last N settled binaries with outcome + impact.
 *   3. Aggregate: by-asset summary of total / resolved / win-rate / active.
 *
 * Server-rendered against the same DB the arena reads; refreshes on a
 * client-side AutoRefresh tick.
 */
import { db } from "@/lib/db/client";
import { AutoRefresh } from "@/components/AutoRefresh";
import { PolymarketBinaryEmbed } from "@/components/PolymarketBinaryEmbed";

export const dynamic = "force-dynamic";

type ActiveRow = {
  token_id: string;
  asset: string;
  duration_kind: string;
  expiry_iso: string;
  question: string;
  midpoint: number | null;
  midpoint_captured_at: string | null;
  agent_positions: number;
  event_slug: string | null;
};

type ResolvedRow = {
  token_id: string;
  asset: string;
  duration_kind: string;
  expiry_iso: string;
  reference_price: number | null;
  outcome_yes: number | null;
  resolved_at: string;
};

type AssetSummaryRow = {
  asset: string;
  total: number;
  resolved: number;
  yes_wins: number;
  no_wins: number;
  active: number;
};

function loadAll() {
  const active = db().prepare(`
    SELECT
      b.token_id, b.asset, b.duration_kind, b.expiry_iso, b.question, b.event_slug,
      (SELECT midpoint FROM market_snapshots
        WHERE token_id = b.token_id AND midpoint IS NOT NULL
        ORDER BY captured_at DESC LIMIT 1) AS midpoint,
      (SELECT captured_at FROM market_snapshots
        WHERE token_id = b.token_id AND midpoint IS NOT NULL
        ORDER BY captured_at DESC LIMIT 1) AS midpoint_captured_at,
      (SELECT COUNT(*) FROM paper_agents
        WHERE alive = 1 AND position_basket_json LIKE '%' || b.token_id || '%') AS agent_positions
    FROM poly_binaries b
    WHERE b.settled = 0 AND b.expiry_iso > datetime('now')
    ORDER BY b.expiry_iso ASC LIMIT 40
  `).all() as ActiveRow[];

  const resolved = db().prepare(`
    SELECT token_id, asset, duration_kind, expiry_iso, reference_price, outcome_yes, resolved_at
    FROM poly_binaries
    WHERE settled = 1 AND resolved_at IS NOT NULL
    ORDER BY resolved_at DESC LIMIT 50
  `).all() as ResolvedRow[];

  const byAsset = db().prepare(`
    SELECT
      asset,
      COUNT(*) AS total,
      SUM(CASE WHEN settled = 1 AND outcome_yes IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN outcome_yes = 1 THEN 1 ELSE 0 END) AS yes_wins,
      SUM(CASE WHEN outcome_yes = 0 THEN 1 ELSE 0 END) AS no_wins,
      SUM(CASE WHEN settled = 0 AND expiry_iso > datetime('now') THEN 1 ELSE 0 END) AS active
    FROM poly_binaries
    GROUP BY asset ORDER BY asset
  `).all() as AssetSummaryRow[];

  const overall = db().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN settled = 1 AND outcome_yes IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
      SUM(CASE WHEN settled = 0 AND expiry_iso > datetime('now') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN outcome_yes = 1 THEN 1 ELSE 0 END) AS yes_wins,
      SUM(CASE WHEN outcome_yes = 0 THEN 1 ELSE 0 END) AS no_wins
    FROM poly_binaries
  `).get() as { total: number; resolved: number; active: number; yes_wins: number; no_wins: number };

  // Agent-level binary performance.
  const binaryAgents = db().prepare(`
    SELECT id, name, generation, alive, realized_pnl_usd, unrealized_pnl_usd,
           cash_usd_current, entries_count, trades_count, wins_count
    FROM paper_agents
    WHERE genome_json LIKE '%poly_short_binary_directional%'
    ORDER BY (realized_pnl_usd + unrealized_pnl_usd) DESC
    LIMIT 20
  `).all() as Array<{
    id: number; name: string; generation: number; alive: 0 | 1;
    realized_pnl_usd: number; unrealized_pnl_usd: number;
    cash_usd_current: number; entries_count: number; trades_count: number; wins_count: number;
  }>;

  return { active, resolved, byAsset, overall, binaryAgents };
}

function minutesFromNow(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / 60_000;
}

function fmtCountdown(min: number): string {
  if (min < 0) return "EXPIRED";
  if (min < 1) return `${Math.round(min * 60)}s`;
  if (min < 60) return `${min.toFixed(1)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

function pillForCountdown(min: number): string {
  if (min <= 2)  return "bg-red-900/40 text-red-300 border border-red-700";
  if (min <= 5)  return "bg-amber-900/40 text-amber-200 border border-amber-700";
  if (min <= 15) return "bg-emerald-900/40 text-emerald-200 border border-emerald-700";
  return "bg-zinc-800/60 text-zinc-300 border border-zinc-700";
}

function fmtMid(mid: number | null): string {
  if (mid == null) return "—";
  return mid.toFixed(3);
}

function winRate(wins: number, total: number): string {
  if (total === 0) return "—";
  return `${(wins / total * 100).toFixed(0)}%`;
}

export default function BinariesPage() {
  const { active, resolved, byAsset, overall, binaryAgents } = loadAll();
  const overallResolvedRate = overall.resolved > 0 ? overall.yes_wins / overall.resolved : 0;

  return (
    <div className="space-y-8">
      <AutoRefresh intervalMs={30_000} />
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Binaries</h1>
          <p className="text-zinc-400 text-sm mt-1">
            Polymarket 5-min / 15-min crypto Up/Down events. Snapshot + resolve pipeline.
          </p>
        </div>
        <div className="text-xs text-zinc-500">refreshes every 30s</div>
      </div>

      {/* Overall summary */}
      <section className="grid grid-cols-5 gap-3">
        <div className="card">
          <div className="text-xs text-zinc-500">Total tracked</div>
          <div className="text-2xl font-semibold mt-1">{overall.total.toLocaleString()}</div>
        </div>
        <div className="card">
          <div className="text-xs text-zinc-500">Active</div>
          <div className="text-2xl font-semibold mt-1 text-accent-blue">{overall.active}</div>
        </div>
        <div className="card">
          <div className="text-xs text-zinc-500">Resolved</div>
          <div className="text-2xl font-semibold mt-1">{overall.resolved}</div>
        </div>
        <div className="card">
          <div className="text-xs text-zinc-500">YES win-rate</div>
          <div className="text-2xl font-semibold mt-1">{(overallResolvedRate * 100).toFixed(1)}%</div>
          <div className="text-[10px] text-zinc-500 mt-1">{overall.yes_wins} YES · {overall.no_wins} NO</div>
        </div>
        <div className="card">
          <div className="text-xs text-zinc-500">Binary agents alive</div>
          <div className="text-2xl font-semibold mt-1">{binaryAgents.filter((a) => a.alive).length}</div>
        </div>
      </section>

      {/* Live Polymarket embeds — one iframe per asset showing the next-soonest
       *  binary that has a non-null event_slug. Renders the actual Polymarket
       *  YES/NO chart + countdown so the operator can watch the market and
       *  the agent's decision in the same view. */}
      {(() => {
        // Pick the soonest active binary per asset (skip ones with no slug).
        const bySoonest = new Map<string, ActiveRow>();
        for (const r of active) {
          if (!r.event_slug) continue;
          if (!bySoonest.has(r.asset)) bySoonest.set(r.asset, r);
        }
        const liveEmbeds = [...bySoonest.values()];
        if (liveEmbeds.length === 0) {
          return (
            <section className="card">
              <h2 className="card-title">Live Polymarket embeds</h2>
              <p className="text-xs text-zinc-500 italic">
                No active binaries with event slugs yet — run the snapshot worker so fetchShortBinaries populates poly_binaries.event_slug.
              </p>
            </section>
          );
        }
        return (
          <section className="card">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="card-title m-0">Live Polymarket embeds ({liveEmbeds.length})</h2>
              <span className="text-[10px] text-zinc-500">soonest active binary per asset · iframes from embed.polymarket.com</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {liveEmbeds.map((r) => {
                const ttl = minutesFromNow(r.expiry_iso);
                return (
                  <div key={r.token_id} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-zinc-200">{r.asset}</span>
                      <span className="text-zinc-400">{r.duration_kind}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${pillForCountdown(ttl)}`}>{fmtCountdown(ttl)}</span>
                      {r.agent_positions > 0 && (
                        <span className="text-[10px] text-accent-green" title={`${r.agent_positions} agent(s) holding`}>
                          {r.agent_positions} holding
                        </span>
                      )}
                    </div>
                    <PolymarketBinaryEmbed eventSlug={r.event_slug!} question={r.question} width={380} height={260} />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })()}

      {/* Per-asset breakdown */}
      <section>
        <h2 className="text-base font-semibold mb-3">By asset</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-xs">
            <thead className="text-zinc-500 border-b border-ink-700">
              <tr>
                <th className="text-left p-2">Asset</th>
                <th className="text-right p-2">Total</th>
                <th className="text-right p-2">Active</th>
                <th className="text-right p-2">Resolved</th>
                <th className="text-right p-2">YES wins</th>
                <th className="text-right p-2">NO wins</th>
                <th className="text-right p-2">YES rate</th>
              </tr>
            </thead>
            <tbody>
              {byAsset.map((r) => (
                <tr key={r.asset} className="border-b border-ink-800/60 last:border-0">
                  <td className="p-2 font-semibold">{r.asset}</td>
                  <td className="p-2 text-right text-zinc-300">{r.total}</td>
                  <td className="p-2 text-right text-accent-blue">{r.active}</td>
                  <td className="p-2 text-right text-zinc-300">{r.resolved}</td>
                  <td className="p-2 text-right text-emerald-400">{r.yes_wins}</td>
                  <td className="p-2 text-right text-red-400">{r.no_wins}</td>
                  <td className="p-2 text-right">{winRate(r.yes_wins, r.resolved)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Active binaries */}
      <section>
        <h2 className="text-base font-semibold mb-3">Active ({active.length})</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-xs">
            <thead className="text-zinc-500 border-b border-ink-700">
              <tr>
                <th className="text-left p-2">TTL</th>
                <th className="text-left p-2">Asset</th>
                <th className="text-left p-2">Kind</th>
                <th className="text-right p-2">YES mid</th>
                <th className="text-right p-2">Mid age</th>
                <th className="text-right p-2">Holders</th>
                <th className="text-left p-2">Question</th>
              </tr>
            </thead>
            <tbody>
              {active.map((r) => {
                const ttl = minutesFromNow(r.expiry_iso);
                const midAgeSec = r.midpoint_captured_at
                  ? (Date.now() - new Date(r.midpoint_captured_at).getTime()) / 1000 : null;
                return (
                  <tr key={r.token_id} className="border-b border-ink-800/60 last:border-0">
                    <td className="p-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${pillForCountdown(ttl)}`}>
                        {fmtCountdown(ttl)}
                      </span>
                    </td>
                    <td className="p-2 font-semibold">{r.asset}</td>
                    <td className="p-2 text-zinc-400">{r.duration_kind}</td>
                    <td className="p-2 text-right text-zinc-200">{fmtMid(r.midpoint)}</td>
                    <td className="p-2 text-right text-zinc-500">
                      {midAgeSec == null ? "—" : `${midAgeSec.toFixed(0)}s`}
                    </td>
                    <td className="p-2 text-right">
                      {r.agent_positions > 0
                        ? <span className="text-accent-green">{r.agent_positions}</span>
                        : <span className="text-zinc-600">0</span>}
                    </td>
                    <td className="p-2 text-zinc-400 truncate max-w-md">{r.question}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recently resolved */}
      <section>
        <h2 className="text-base font-semibold mb-3">Recently resolved ({resolved.length})</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-xs">
            <thead className="text-zinc-500 border-b border-ink-700">
              <tr>
                <th className="text-left p-2">Resolved at</th>
                <th className="text-left p-2">Asset</th>
                <th className="text-left p-2">Kind</th>
                <th className="text-right p-2">Ref price</th>
                <th className="text-center p-2">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {resolved.map((r) => {
                const outcomeYes = r.outcome_yes === 1;
                const isUnresolvable = r.outcome_yes == null;
                return (
                  <tr key={r.token_id} className="border-b border-ink-800/60 last:border-0">
                    <td className="p-2 text-zinc-400">{r.resolved_at}</td>
                    <td className="p-2 font-semibold">{r.asset}</td>
                    <td className="p-2 text-zinc-400">{r.duration_kind}</td>
                    <td className="p-2 text-right text-zinc-300">
                      {r.reference_price != null ? r.reference_price.toLocaleString() : "—"}
                    </td>
                    <td className="p-2 text-center">
                      {isUnresolvable
                        ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-500 border border-zinc-700">UNRESOLVED</span>
                        : outcomeYes
                          ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-900/40 text-emerald-200 border border-emerald-700">YES (UP)</span>
                          : <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-900/40 text-red-200 border border-red-700">NO (DOWN)</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Binary agents */}
      <section>
        <h2 className="text-base font-semibold mb-3">Binary agents</h2>
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-xs">
            <thead className="text-zinc-500 border-b border-ink-700">
              <tr>
                <th className="text-left p-2">Name</th>
                <th className="text-left p-2">Gen</th>
                <th className="text-center p-2">Status</th>
                <th className="text-right p-2">Cash</th>
                <th className="text-right p-2">Realized</th>
                <th className="text-right p-2">Unrealized</th>
                <th className="text-right p-2">Entries</th>
                <th className="text-right p-2">Trades</th>
                <th className="text-right p-2">Wins</th>
              </tr>
            </thead>
            <tbody>
              {binaryAgents.map((a) => (
                <tr key={a.id} className="border-b border-ink-800/60 last:border-0">
                  <td className="p-2 text-zinc-200">{a.name}</td>
                  <td className="p-2 text-zinc-500">g{a.generation}</td>
                  <td className="p-2 text-center">
                    {a.alive
                      ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-900/40 text-emerald-200 border border-emerald-700">alive</span>
                      : <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-500 border border-zinc-700">retired</span>}
                  </td>
                  <td className="p-2 text-right">${a.cash_usd_current.toFixed(2)}</td>
                  <td className={`p-2 text-right ${a.realized_pnl_usd >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                    {a.realized_pnl_usd >= 0 ? "+" : ""}${a.realized_pnl_usd.toFixed(2)}
                  </td>
                  <td className={`p-2 text-right ${a.unrealized_pnl_usd >= 0 ? "text-emerald-300" : "text-red-300"}`}>
                    {a.unrealized_pnl_usd >= 0 ? "+" : ""}${a.unrealized_pnl_usd.toFixed(2)}
                  </td>
                  <td className="p-2 text-right">{a.entries_count}</td>
                  <td className="p-2 text-right">{a.trades_count}</td>
                  <td className="p-2 text-right">{a.wins_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
