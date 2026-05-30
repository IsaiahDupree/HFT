"use client";

import { useEffect, useState } from "react";

type SafetySnapshot = {
  polymarket: { auth_available: boolean; mode: string; max_trade_usd: number; max_daily_usd: number; daily_executed_usd: number };
  coinbase: { auth_available: boolean; mode: string; max_trade_usd: number; max_daily_usd: number; daily_executed_usd: number };
  risk_engine: { halted: boolean; halt_reason: string };
  market_freshness: { total: number; stale: number; newest_age_seconds: number | null; oldest_age_seconds: number | null };
};
type ArenaStatus = {
  open_generation: { gen_number: number; tick_count: number; tick_target: number; n_agents: number } | null;
  alive_total: number;
  ai_agents: number;
  trades_today: number;
  live_money: { n_capsules: number; capital_usd: number; current_pnl_usd: number; daily_pnl_usd: number };
};

const REFRESH_MS = 30_000;

/**
 * Sticky strip at the very top of every page. Polls /api/safety/snapshot
 * + /api/arena/status every 30s so the operator always sees the live mode
 * + halt state + gen tick progress without leaving whatever page they're on.
 */
export function SystemStatusBar() {
  const [safety, setSafety] = useState<SafetySnapshot | null>(null);
  const [arena, setArena] = useState<ArenaStatus | null>(null);
  // Track tick time as state so SSR renders blank and the client fills it in
  // after mount — avoids "server-rendered text didn't match client" hydration
  // error from rendering Date.now() inline.
  const [lastTick, setLastTick] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const [s, a] = await Promise.all([
          fetch("/api/safety/snapshot").then((r) => r.json()).catch(() => null),
          fetch("/api/arena/status").then((r) => r.json()).catch(() => null),
        ]);
        if (cancelled) return;
        if (s) setSafety(s);
        if (a) setArena(a);
        setLastTick(new Date());
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const halt = safety?.risk_engine?.halted;
  const polyLive = safety?.polymarket?.mode === "LIVE";
  const cbLive = safety?.coinbase?.mode === "LIVE";
  const gen = arena?.open_generation;
  const ticksRemaining = gen ? Math.max(0, gen.tick_target - gen.tick_count) : null;
  const stale = safety?.market_freshness?.stale ?? 0;
  const live = arena?.live_money;
  const hasLiveMoney = !!(live && live.n_capsules > 0);
  const aiCount = arena?.ai_agents ?? 0;

  return (
    <div className={`border-b text-[11px] tabular-nums ${halt ? "bg-accent-red/10 border-accent-red/40" : "bg-ink-900 border-ink-800"}`}>
      <div className="mx-auto max-w-7xl px-6 py-1.5 flex items-center gap-3 flex-wrap">
        <span className="font-semibold text-zinc-300 mr-1">SYSTEM</span>

        {halt ? (
          <span className="pill-red font-semibold">HALTED — {safety?.risk_engine?.halt_reason || "kill switch"}</span>
        ) : (
          <span className="pill-green">OK</span>
        )}

        <Divider />
        <span title="Polymarket mode">
          poly <ModePill mode={safety?.polymarket?.mode} live={polyLive} />
        </span>
        <span title="Coinbase mode">
          cb <ModePill mode={safety?.coinbase?.mode} live={cbLive} />
        </span>

        {hasLiveMoney && (
          <>
            <Divider />
            <span
              className={`pill ${polyLive ? "pill-green" : "pill-amber"} font-semibold`}
              title={polyLive
                ? `LIVE: ${live!.n_capsules} capsule${live!.n_capsules === 1 ? "" : "s"} on real CLOB · today P/L $${live!.daily_pnl_usd.toFixed(2)}`
                : `PAPER: ${live!.n_capsules} capsule${live!.n_capsules === 1 ? "" : "s"} wired but ALLOW_TRADE unset → DRY_RUN`}
            >
              {polyLive ? "💰" : "📝"} ${live!.capital_usd.toFixed(0)}
              <span className={`ml-1 ${live!.current_pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                {live!.current_pnl_usd >= 0 ? "+" : ""}${live!.current_pnl_usd.toFixed(2)}
              </span>
            </span>
          </>
        )}

        <Divider />
        <span className="text-zinc-400">alive</span><span className="text-zinc-100">{arena?.alive_total ?? "—"}</span>
        {aiCount > 0 && (
          <span
            className="text-[10px] px-1 rounded bg-accent-blue/15 text-accent-blue border border-accent-blue/40"
            title={`${aiCount} alive agent${aiCount === 1 ? "" : "s"} have an llm_probability_oracle component (Claude-driven decisions). Remaining ${(arena!.alive_total - aiCount)} are deterministic pattern matchers.`}
          >
            🧠 {aiCount} AI
          </span>
        )}

        {gen && (
          <>
            <Divider />
            <span className="text-zinc-400">gen</span>
            <span className="text-zinc-100">{gen.gen_number}</span>
            <span className="text-zinc-400">tick</span>
            <span className="text-zinc-100">{gen.tick_count}/{gen.tick_target}</span>
            <span className="text-zinc-500">→ next evolve in {ticksRemaining ?? "—"} tick{ticksRemaining === 1 ? "" : "s"}</span>
          </>
        )}

        <Divider />
        <span className="text-zinc-400">trades today</span>
        <span className="text-zinc-100">{arena?.trades_today ?? 0}</span>

        {stale > 0 && (
          <>
            <Divider />
            <span className="pill-amber" title="markets with no snapshot in 10+ min">{stale} stale</span>
          </>
        )}

        <div className="ml-auto text-zinc-600 text-[10px]" suppressHydrationWarning>
          {lastTick ? `refresh 30s · ${lastTick.toLocaleTimeString()}` : "refresh 30s · —"}
        </div>
      </div>
    </div>
  );
}

function ModePill({ mode, live }: { mode?: string; live: boolean }) {
  if (!mode) return <span className="text-zinc-500">—</span>;
  return <span className={live ? "pill-red" : "pill-green"}>{mode}</span>;
}
function Divider() { return <span className="text-zinc-700">|</span>; }
