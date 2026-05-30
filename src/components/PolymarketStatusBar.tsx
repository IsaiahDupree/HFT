"use client";

/**
 * Sticky top bar showing live Polymarket account state + active capsule
 * bindings. Polls /api/polymarket/account-status every 30s.
 *
 * Displays (left → right):
 *   1. Trading collateral: CLOB-recognized USDC balance + portfolio value
 *   2. Funder address (truncated, copy-on-click)
 *   3. ALLOW_TRADE state pill (DRY_RUN vs LIVE) + daily-cap remaining
 *   4. Active live/paper capsules + their bound agents
 *
 * Designed to be unobtrusive — render below SystemStatusBar in layout.tsx.
 * Renders nothing when no funder is configured (avoids noise in fresh setups).
 */
import Link from "next/link";
import { useEffect, useState } from "react";

type Capsule = {
  capsule_id: string;
  capsule_name: string;
  status: string;
  is_auto: boolean;
  capital_available_usd: number;
  capital_allocated_usd: number;
  daily_pnl_usd: number;
  current_pnl_usd: number;
  agent_id: number | null;
  agent_name: string | null;
  agent_alive: boolean;
  agent_kind: string | null;
  open_positions: number;
  last_action_at: string | null;
  last_action_summary: string | null;
};

type AccountStatus = {
  funder: string;
  balances: { usdc_e: number; usdc_native: number; matic: number };
  clob_collateral_usd: number | null;
  clob_open_orders: number | null;
  portfolio_value_usd: number;
  capsules: Capsule[];
  safety: { allow_trade: boolean; max_trade_usd: number; max_daily_usd: number };
  fetched_at: string;
  error?: string;
};

export function PolymarketStatusBar() {
  const [data, setData] = useState<AccountStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const r = await fetch("/api/polymarket/account-status");
        if (!r.ok) {
          // 400 = no funder configured. Quiet failure — bar just stays empty.
          if (r.status === 400) { setData(null); return; }
          throw new Error(`HTTP ${r.status}`);
        }
        const j = (await r.json()) as AccountStatus;
        if (!cancelled) { setData(j); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    }
    tick();
    const id = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (err) {
    return <div className="px-4 py-1 text-[10px] text-accent-red border-b border-ink-700 bg-ink-900">PolymarketStatusBar: {err}</div>;
  }
  if (!data) return null;   // no funder configured or pre-first-fetch

  const liveCapsules = data.capsules.filter((c) => c.status === "live" && c.agent_id != null);
  const pendingCapsules = data.capsules.filter((c) => c.status === "paper" || c.agent_id == null);
  const tradingBalance = data.clob_collateral_usd ?? data.balances.usdc_e ?? 0;

  return (
    <div className="border-b border-ink-700 bg-ink-900/80 backdrop-blur text-xs">
      <div className="mx-auto max-w-7xl px-6 py-1.5 flex items-center gap-4 flex-wrap">
        {/* Section 1: Trading balance */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 hover:text-zinc-100 text-zinc-300"
          title="Click to expand capsule details"
        >
          <span className="text-zinc-500">PM:</span>
          <span className="tabular-nums font-semibold">
            {data.clob_collateral_usd != null
              ? <span className="text-accent-green">${tradingBalance.toFixed(2)}</span>
              : <span className="text-zinc-400" title="CLOB balance unavailable; showing on-chain proxy balance">${tradingBalance.toFixed(2)}</span>}
          </span>
          {data.portfolio_value_usd > 0 && (
            <span className="text-zinc-500" title="Portfolio value (open positions notional)">
              + ${data.portfolio_value_usd.toFixed(2)} positions
            </span>
          )}
          {data.clob_open_orders != null && data.clob_open_orders > 0 && (
            <span className="text-accent-blue" title="Open orders on CLOB">
              · {data.clob_open_orders} orders
            </span>
          )}
        </button>

        {/* Section 2: Active capsules summary */}
        <div className="flex items-center gap-2 text-zinc-400">
          <span className="text-zinc-600">|</span>
          {liveCapsules.length === 0 ? (
            <span className="text-zinc-500">no live capsules</span>
          ) : liveCapsules.map((c) => (
            <Link
              key={c.capsule_id}
              href={`/arena/${c.agent_id}`}
              className="hover:text-accent-blue flex items-center gap-1"
              title={`${c.is_auto ? "auto-promoted" : "manual"} capsule ${c.capsule_id.slice(0, 8)}… capital $${c.capital_available_usd.toFixed(2)}`}
            >
              <span className="text-accent-amber font-semibold">{c.agent_name?.replace(/^g\d+-/, "")}</span>
              {c.is_auto && (
                <span className="text-[8px] px-0.5 rounded bg-accent-amber/20 text-accent-amber border border-accent-amber/40">AUTO</span>
              )}
              <span className="text-[10px] text-zinc-500">${c.capital_available_usd.toFixed(0)}</span>
            </Link>
          ))}
          {pendingCapsules.length > 0 && (
            <span className="text-zinc-600 text-[10px]">+{pendingCapsules.length} paper</span>
          )}
        </div>

        {/* Section 3: Trading state pill */}
        <div className="ml-auto flex items-center gap-2">
          {data.safety.allow_trade ? (
            <span className="px-2 py-0.5 rounded text-[10px] bg-accent-red/20 text-accent-red border border-accent-red/40 font-semibold animate-pulse" title="ALLOW_TRADE=1 — live orders may fire on next tick">
              🔥 LIVE
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded text-[10px] bg-zinc-800 text-zinc-400 border border-zinc-700" title="ALLOW_TRADE unset — orders DRY_RUN only">
              DRY_RUN
            </span>
          )}
          <span className="text-zinc-500 text-[10px]" title="Per-trade and per-day caps">
            caps ${data.safety.max_trade_usd}/${data.safety.max_daily_usd}
          </span>
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border-t border-ink-700 bg-ink-900 px-6 py-2 text-[11px]">
          <div className="mx-auto max-w-7xl space-y-2">
            <div className="text-zinc-400">
              Funder: <code className="text-zinc-200">{data.funder}</code> · last updated {new Date(data.fetched_at).toLocaleTimeString()}
            </div>
            <div className="text-zinc-500">
              On-chain proxy balances: USDC.e ${data.balances.usdc_e.toFixed(2)} · native USDC ${data.balances.usdc_native.toFixed(2)} · MATIC {data.balances.matic.toFixed(4)}
              {data.clob_collateral_usd != null && (
                <> · CLOB collateral <span className="text-accent-green">${data.clob_collateral_usd.toFixed(2)}</span></>
              )}
            </div>
            {data.capsules.length > 0 && (
              <div>
                <div className="text-zinc-400 font-semibold mt-1 mb-1">Capsules:</div>
                <table className="w-full">
                  <thead className="text-zinc-500">
                    <tr><th className="text-left">Agent</th><th className="text-left">Status</th><th className="text-right">Capital</th><th className="text-right">Daily PnL</th><th className="text-right">Open pos</th><th className="text-left">Last action</th></tr>
                  </thead>
                  <tbody>
                    {data.capsules.map((c) => (
                      <tr key={c.capsule_id} className="border-t border-ink-800/50">
                        <td>
                          {c.agent_name ? (
                            <Link href={`/arena/${c.agent_id}`} className="text-zinc-200 hover:text-accent-blue">{c.agent_name}</Link>
                          ) : <span className="text-zinc-600">(unbound)</span>}
                          {c.agent_kind && <span className="ml-1 text-[9px] text-zinc-500">{c.agent_kind.replace(/_/g, "-")}</span>}
                        </td>
                        <td>
                          {c.status === "live"
                            ? <span className="px-1 rounded bg-accent-red/20 text-accent-red text-[9px]">LIVE</span>
                            : c.status === "paused"
                            ? <span className="px-1 rounded bg-zinc-700 text-zinc-300 text-[9px]">PAUSED</span>
                            : <span className="px-1 rounded bg-zinc-800 text-zinc-400 text-[9px]">paper</span>}
                          {c.is_auto && <span className="ml-1 px-1 rounded bg-accent-amber/20 text-accent-amber text-[9px]">AUTO</span>}
                        </td>
                        <td className="text-right tabular-nums">${c.capital_available_usd.toFixed(2)}</td>
                        <td className={`text-right tabular-nums ${c.daily_pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                          {c.daily_pnl_usd >= 0 ? "+" : ""}${c.daily_pnl_usd.toFixed(2)}
                        </td>
                        <td className="text-right tabular-nums">{c.open_positions}</td>
                        <td className="text-zinc-500 max-w-[300px] truncate" title={c.last_action_summary ?? ""}>
                          {c.last_action_at ? (
                            <>
                              <span className="text-zinc-600">{new Date(c.last_action_at + "Z").toLocaleTimeString()}</span>
                              {" · "}
                              {c.last_action_summary?.slice(0, 60)}
                            </>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
