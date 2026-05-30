import Link from "next/link";
import { safety as pmSafety } from "@/lib/polymarket/execute";
import { cbSafety } from "@/lib/coinbase/execute";
import { authIsAvailable as cbAuthAvailable } from "@/lib/coinbase/auth";
import { getDefaultKillSwitch } from "@/lib/risk/kill-switch";
import { getDefaultRouter } from "@/lib/venue/router";
import { getMarketFreshness } from "@/lib/arena/snapshot";
import { listCapsules } from "@/lib/capsules/store";
import { AutoRefresh } from "@/components/AutoRefresh";

export const dynamic = "force-dynamic";

function polyAuthAvailable(): boolean {
  return Boolean(process.env.POLYMARKET_PRIVATE_KEY);
}

function fmtUsd(n: number | null | undefined): string { return `$${Number(n ?? 0).toFixed(2)}`; }
function fmtAge(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

export default async function SafetyDashboard() {
  // Force adapter registration so kill-switch shows every venue.
  getDefaultRouter();
  const ks = getDefaultKillSwitch();

  const polyMode = pmSafety.mode();
  const cbMode = cbSafety.mode();
  const polyAuth = polyAuthAvailable();
  const cbAuth = (() => { try { return cbAuthAvailable(); } catch { return false; } })();
  const halted = ks.riskEngine.isHalted();
  const haltReason = ks.riskEngine.getHaltReason();
  const limits = ks.riskEngine.getLimits();
  const brokers = ks.getRegisteredBrokers();
  const fresh = getMarketFreshness({ staleSeconds: 600 });
  const capsules = listCapsules();
  const liveCapsules = capsules.filter((c) => c.status === "live");

  const activation = {
    window_days: Number(process.env.ARENA_ACTIVATE_WINDOW_DAYS ?? "14"),
    min_pnl_pct: Number(process.env.ARENA_ACTIVATE_MIN_PNL_PCT ?? "-0.02"),
    max_dd_pct: Number(process.env.ARENA_ACTIVATE_MAX_DD_PCT ?? "0.25"),
  };

  const polyLive = polyMode === "LIVE";
  const cbLive = cbMode === "LIVE";

  return (
    <div className="space-y-6">
      <AutoRefresh label="safety" />
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Safety control plane</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Every gate that stands between an agent's decision and a real fill. Defaults are <span className="text-accent-green">SAFE</span>:
          venue trading off, halt clear, pre-flight backtest gate enforced. Bypassing any gate is logged to <code>evolution_log</code>.
        </p>
      </div>

      {halted && (
        <section className="card border-accent-red/40 bg-accent-red/5">
          <div className="flex items-baseline justify-between">
            <h2 className="card-title text-accent-red">🛑 GLOBAL HALT engaged</h2>
            <form action="/api/risk/halt" method="DELETE" className="inline">
              <button type="submit" className="text-xs px-2 py-1 rounded bg-accent-green/15 text-accent-green hover:bg-accent-green/25">
                Resume (DELETE)
              </button>
            </form>
          </div>
          <p className="text-xs text-zinc-300 mt-1">Reason: {haltReason || "(none recorded)"}</p>
          <p className="text-xs text-zinc-500">No new orders will pass the router gate until resumed.</p>
        </section>
      )}

      <section className="grid grid-cols-2 gap-6">
        <VenueCard
          name="Polymarket"
          authAvailable={polyAuth}
          mode={polyMode}
          live={polyLive}
          maxTrade={pmSafety.maxTrade()}
          maxDaily={pmSafety.maxDaily()}
          dailyExec={pmSafety.dailyExecutedUsd()}
          allowEnv="ALLOW_TRADE"
          tradeCapEnv="MAX_TRADE_USD"
          dailyCapEnv="MAX_DAILY_USD"
        />
        <VenueCard
          name="Coinbase"
          authAvailable={cbAuth}
          mode={cbMode}
          live={cbLive}
          maxTrade={cbSafety.maxTrade()}
          maxDaily={cbSafety.maxDaily()}
          dailyExec={cbSafety.dailyExecutedUsd()}
          allowEnv="COINBASE_ALLOW_TRADE"
          tradeCapEnv="COINBASE_MAX_TRADE_USD"
          dailyCapEnv="COINBASE_MAX_DAILY_USD"
        />
      </section>

      <section className="card">
        <h2 className="card-title">Risk engine + kill switch</h2>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <table className="list text-xs">
              <tbody>
                <tr><td className="text-zinc-500">Halted</td><td className={halted ? "text-accent-red" : "text-accent-green"}>{halted ? "yes" : "no"}</td></tr>
                <tr><td className="text-zinc-500">Max notional / order</td><td className="tabular-nums">{fmtUsd(limits.max_order_notional_usd)}</td></tr>
                <tr><td className="text-zinc-500">Max position notional</td><td className="tabular-nums">{fmtUsd(limits.max_position_notional_usd)}</td></tr>
                <tr><td className="text-zinc-500">Max daily loss</td><td className="tabular-nums">{fmtUsd(limits.max_daily_loss_usd)}</td></tr>
                <tr><td className="text-zinc-500">Max orders / min</td><td className="tabular-nums">{limits.max_orders_per_minute}</td></tr>
                <tr><td className="text-zinc-500">Max open positions</td><td className="tabular-nums">{limits.max_open_positions}</td></tr>
                <tr><td className="text-zinc-500">Max concentration pct</td><td className="tabular-nums">{(limits.max_concentration_pct * 100).toFixed(0)}%</td></tr>
                <tr><td className="text-zinc-500">Registered brokers</td><td className="tabular-nums">{brokers.length ? brokers.join(", ") : "(none)"}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="space-y-3">
            <form action="/api/risk/halt" method="POST" className="space-y-2">
              <input type="hidden" name="mode" value="pause_new_only" />
              <input
                name="reason"
                placeholder="halt reason (required)"
                className="w-full text-xs bg-ink-800 border border-ink-700 rounded px-2 py-1 text-zinc-100 placeholder-zinc-600"
                required minLength={1}
              />
              <button type="submit" className="w-full text-xs px-2 py-2 rounded bg-accent-red/15 text-accent-red hover:bg-accent-red/25">
                Halt new orders only
              </button>
            </form>
            <details className="text-xs text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-300">Manage via API</summary>
              <pre className="mt-2 bg-ink-900 p-2 rounded text-[10px] overflow-auto">{`GET    /api/risk/halt           # current state
POST   /api/risk/halt           # engage { reason, mode }
DELETE /api/risk/halt           # resume`}</pre>
            </details>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Activation gate (pre-flight backtest)</h2>
        <p className="text-xs text-zinc-400 mb-3">
          Before any capsule flips <code>paper → live</code>, the bound agent's genome runs through the same sim engine
          over the last <strong>{activation.window_days} days</strong>. Refused if PnL%&nbsp;&lt;&nbsp;
          {(activation.min_pnl_pct * 100).toFixed(2)}% or DD%&nbsp;&gt;&nbsp;{(activation.max_dd_pct * 100).toFixed(2)}%.
          Default is ENFORCED — opt-out with <code>{`{"bypass": true}`}</code> (audit-logged).
        </p>
        <table className="list text-xs">
          <tbody>
            <tr><td className="text-zinc-500">Window</td><td><code>ARENA_ACTIVATE_WINDOW_DAYS</code></td><td className="tabular-nums">{activation.window_days} d</td></tr>
            <tr><td className="text-zinc-500">Min PnL%</td><td><code>ARENA_ACTIVATE_MIN_PNL_PCT</code></td><td className="tabular-nums">{(activation.min_pnl_pct * 100).toFixed(2)}%</td></tr>
            <tr><td className="text-zinc-500">Max DD%</td><td><code>ARENA_ACTIVATE_MAX_DD_PCT</code></td><td className="tabular-nums">{(activation.max_dd_pct * 100).toFixed(2)}%</td></tr>
            <tr><td className="text-zinc-500">Default bypass</td><td><code>(hard-coded)</code></td><td className="text-accent-green">false (ON)</td></tr>
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="card-title">Live snapshot freshness</h2>
          <form action="/api/worker/snapshot" method="POST" className="inline">
            <button type="submit" className="text-xs px-2 py-1 rounded bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25">
              Force refresh now
            </button>
          </form>
        </div>
        {fresh.length === 0 ? (
          <p className="text-xs text-zinc-500 mt-2">No snapshots in the last 24h. Click "Force refresh" or wait for the scheduled task.</p>
        ) : (
          <>
            <p className="text-xs text-zinc-500 mt-1 mb-3">
              {fresh.length} markets · {fresh.filter((f) => f.is_stale).length} stale (&gt;10 min)
            </p>
            <table className="list text-xs">
              <thead><tr><th>Venue</th><th>Market</th><th className="text-right">Last seen</th><th className="text-right">Age</th><th>Fresh?</th></tr></thead>
              <tbody>
                {fresh.slice(0, 30).map((f) => (
                  <tr key={`${f.venue}-${f.market_id}`}>
                    <td className="text-zinc-500">{f.venue}</td>
                    <td className="text-zinc-100">{f.market_id.slice(0, 26)}{f.market_id.length > 26 ? "…" : ""}</td>
                    <td className="text-right text-zinc-500">{new Date(f.last_seen).toLocaleTimeString()}</td>
                    <td className="text-right tabular-nums">{fmtAge(f.age_seconds)}</td>
                    <td><span className={f.is_stale ? "pill-red" : "pill-green"}>{f.is_stale ? "stale" : "fresh"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">Capsules ({capsules.length})</h2>
        <p className="text-xs text-zinc-500 mb-2">
          {liveCapsules.length} currently LIVE — these will route arena entries through the unified ExecutionRouter
          (subject to every gate above).
        </p>
        <table className="list text-xs">
          <thead><tr><th>Capsule</th><th>Status</th><th className="text-right">Allocated</th><th className="text-right">PnL</th><th></th></tr></thead>
          <tbody>
            {capsules.slice(0, 10).map((c) => (
              <tr key={c.id}>
                <td><Link className="text-zinc-100 hover:text-accent-blue" href={`/capsules`}>{c.name}</Link></td>
                <td><span className={c.status === "live" ? "pill-green" : c.status === "paper" ? "pill-blue" : c.status === "paused" ? "pill-amber" : "pill-red"}>{c.status}</span></td>
                <td className="text-right tabular-nums">{fmtUsd(c.capital_allocated_usd)}</td>
                <td className={`text-right tabular-nums ${c.current_pnl_usd >= 0 ? "text-accent-green" : "text-accent-red"}`}>{fmtUsd(c.current_pnl_usd)}</td>
                <td><Link href="/capsules" className="text-xs text-accent-blue hover:underline">manage →</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <nav className="text-xs text-zinc-500 flex gap-4">
        <Link href="/arena" className="hover:text-zinc-300">→ Arena</Link>
        <Link href="/capsules" className="hover:text-zinc-300">→ Capsules</Link>
        <Link href="/api/safety/snapshot" className="hover:text-zinc-300">→ Safety snapshot JSON</Link>
        <Link href="/api/arena/freshness" className="hover:text-zinc-300">→ Freshness JSON</Link>
      </nav>
    </div>
  );
}

function VenueCard({
  name, authAvailable, mode, live, maxTrade, maxDaily, dailyExec, allowEnv, tradeCapEnv, dailyCapEnv,
}: {
  name: string; authAvailable: boolean; mode: string; live: boolean;
  maxTrade: number; maxDaily: number; dailyExec: number;
  allowEnv: string; tradeCapEnv: string; dailyCapEnv: string;
}) {
  return (
    <div className={`card ${live ? "border-accent-red/40" : ""}`}>
      <div className="flex items-baseline justify-between">
        <h2 className="card-title m-0">{name}</h2>
        <span className={live ? "pill-red" : "pill-green"}>{mode}</span>
      </div>
      <table className="list text-xs mt-2">
        <tbody>
          <tr><td className="text-zinc-500">Auth</td><td className={authAvailable ? "text-accent-green" : "text-accent-red"}>{authAvailable ? "available" : "missing"}</td></tr>
          <tr><td className="text-zinc-500">Trade gate (<code>{allowEnv}</code>)</td><td className={live ? "text-accent-red" : "text-accent-green"}>{live ? "OPEN (1)" : "CLOSED (0/unset)"}</td></tr>
          <tr><td className="text-zinc-500">Per-trade cap (<code>{tradeCapEnv}</code>)</td><td className="tabular-nums">{`$${maxTrade}`}</td></tr>
          <tr><td className="text-zinc-500">Daily cap (<code>{dailyCapEnv}</code>)</td><td className="tabular-nums">{`$${maxDaily}`}</td></tr>
          <tr>
            <td className="text-zinc-500">Spent today</td>
            <td className={dailyExec >= maxDaily * 0.8 ? "text-accent-amber tabular-nums" : "tabular-nums"}>
              ${dailyExec.toFixed(2)} ({maxDaily > 0 ? Math.round((dailyExec / maxDaily) * 100) : 0}% of cap)
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-[10px] text-zinc-500 mt-2">
        Flip to LIVE: <code>{allowEnv}=1</code> in <code>.env.local</code>, then restart dev server.
        Defaults to OFF/DRY_RUN.
      </p>
    </div>
  );
}
