import Link from "next/link";
import { db } from "@/lib/db/client";
import { loadRecentCandles, velocity, acceleration } from "@/lib/arena/momentum";
import { Sparkline } from "@/components/Sparkline";
import { AutoRefresh } from "@/components/AutoRefresh";
import { LiveCountdown, WindowRangeLabel } from "@/components/LiveCountdown";
import { ClientOnly } from "@/components/ClientOnly";
import { LivePrice } from "@/components/LivePrice";
import { WindowBars } from "@/components/WindowBars";
import { safety as pmSafety } from "@/lib/polymarket/execute";
import { cbSafety } from "@/lib/coinbase/execute";
import { authIsAvailable as cbAuthAvailable } from "@/lib/coinbase/auth";
import { getDefaultKillSwitch } from "@/lib/risk/kill-switch";
import { getDefaultRouter } from "@/lib/venue/router";
import { getMarketFreshness } from "@/lib/arena/snapshot";

export const dynamic = "force-dynamic";

const PRODUCTS = (process.env.ARENA_SNAPSHOT_CB_PRODUCTS ?? "BTC-USD,ETH-USD,SOL-USD")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Inspired by the video: bots target rolling 5-minute "Will BTC be Up?" markets.
// We don't (yet) snapshot those specific markets; meanwhile the same Coinbase
// momentum signal lets us compute our own "Up probability" for any product.
const WINDOW_MIN = 5;

function fmtPrice(n: number | null | undefined): string {
  if (n == null) return "—";
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toFixed(4);
}
function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
}
function pctClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "text-zinc-500";
  return n >= 0 ? "text-accent-green" : "text-accent-red";
}
/**
 * Naïve probability that the next 5-min window resolves "Up" given current
 * 5-min velocity. Logistic squash; ±0.5% velocity → ~95% confidence. Honest
 * about its simplicity: the video bots use Chainlink-derived Black-Scholes,
 * we use only the most-recent momentum direction. Treat as illustrative.
 */
function naiveUpProb(vel5: number | null): number | null {
  if (vel5 == null || !Number.isFinite(vel5)) return null;
  return 1 / (1 + Math.exp(-vel5 * 600));
}
function fmtCountdown(secondsUntil: number): string {
  if (secondsUntil < 0) return "—";
  const m = Math.floor(secondsUntil / 60);
  const s = Math.floor(secondsUntil % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default async function CryptoPage() {
  getDefaultRouter();
  const ks = getDefaultKillSwitch();
  const now = new Date();
  const sinceMinute = now.getUTCMinutes() % WINDOW_MIN;
  const secondsLeftInWindow = (WINDOW_MIN - sinceMinute) * 60 - now.getUTCSeconds();

  const productPanels = PRODUCTS.map((pid) => {
    const candles = loadRecentCandles(pid, 240);
    const closes = candles.map((c) => c.close);
    const latest = candles[candles.length - 1];
    const cbSnap = db().prepare(
      `SELECT best_bid, best_ask, midpoint, spread, volume_24h, price_24h_change_pct, captured_at
       FROM coinbase_snapshots WHERE product_id = ? ORDER BY captured_at DESC LIMIT 1`,
    ).get(pid) as { best_bid: number | null; best_ask: number | null; midpoint: number | null; spread: number | null; volume_24h: number | null; price_24h_change_pct: number | null; captured_at: string } | undefined;
    const v5 = velocity(candles, 5);
    const v15 = velocity(candles, 15);
    const a5 = acceleration(candles, 5);
    const ourUp = naiveUpProb(Number.isFinite(v5) ? v5 : null);
    const pmUp: number | null = null;
    const edgePt = (ourUp != null && pmUp != null) ? (ourUp - pmUp) * 100 : null;
    const isLive = candles.length > 0 && cbSnap != null;

    // Price To Beat = open of the candle that started the current 5-min window.
    // Walks back: find candles where start_unix % (WINDOW_MIN*60) == 0.
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = nowSec - (nowSec % (WINDOW_MIN * 60));
    const startCandle = candles.find((c) => c.start_unix === windowStart) ?? candles[candles.length - WINDOW_MIN];
    const priceToBeat = startCandle?.open ?? null;

    // Bars: for last 10 completed windows, take (close at window-end) − (open at window-start).
    const completedBars: Array<{ label: string; deltaUsd: number }> = [];
    for (let w = 10; w >= 1; w--) {
      const wStart = windowStart - w * WINDOW_MIN * 60;
      const wEnd = wStart + WINDOW_MIN * 60;
      const startC = candles.find((c) => c.start_unix === wStart);
      const endC = candles.find((c) => c.start_unix === wEnd - 60);
      if (startC && endC) {
        // UTC formatting only — getHours()/getMinutes() use the local timezone
        // which can desync between SSR and hydrate passes when Next.js dev
        // re-renders the same server component (Turbopack streaming or RSC
        // replay). UTC labels are deterministic regardless of host TZ.
        const startTime = new Date(wStart * 1000);
        const hh = startTime.getUTCHours() % 12 || 12;
        const mm = String(startTime.getUTCMinutes()).padStart(2, "0");
        completedBars.push({ label: `${hh}:${mm}Z`, deltaUsd: endC.close - startC.open });
      }
    }
    return { pid, latest, cbSnap, closes, v5, v15, a5, ourUp, pmUp, edgePt, isLive, priceToBeat, completedBars };
  });

  const polyMarkets = db().prepare(
    `SELECT token_id, condition_id, question, midpoint, spread, volume_24h, MAX(captured_at) AS last_seen
       FROM market_snapshots
       WHERE captured_at >= datetime('now', '-3 hours') AND midpoint IS NOT NULL
       GROUP BY token_id
       ORDER BY volume_24h DESC NULLS LAST, last_seen DESC
       LIMIT 20`,
  ).all() as Array<{ token_id: string; condition_id: string; question: string; midpoint: number; spread: number | null; volume_24h: number | null; last_seen: string }>;

  const scoreboard = db().prepare(
    `SELECT pa.id, pa.name, COUNT(*) AS trades,
            SUM(CASE WHEN pt.realized_pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
            SUM(CASE WHEN pt.realized_pnl_usd < 0 THEN 1 ELSE 0 END) AS losses,
            COALESCE(SUM(pt.realized_pnl_usd), 0) AS net_pnl
       FROM paper_trades pt JOIN paper_agents pa ON pa.id = pt.paper_agent_id
       WHERE pt.tick_at >= datetime('now', 'start of day')
       GROUP BY pa.id, pa.name
       ORDER BY net_pnl DESC LIMIT 10`,
  ).all() as Array<{ id: number; name: string; trades: number; wins: number; losses: number; net_pnl: number }>;

  // Trade-readiness checks (preflight, video pattern).
  // - Threshold: 5 min, matches the scheduler cadence (cron runs every 5min).
  // - Coinbase auth: real file-or-env check via the auth module (not just env presence).
  // - Polymarket: optional in SIM mode; flagged "N/A" when missing rather than blocking.
  const fresh = getMarketFreshness({ staleSeconds: 600 });
  const newestAge = fresh.length > 0 ? Math.min(...fresh.map((f) => f.age_seconds)) : Infinity;
  const cbAuth = (() => { try { return cbAuthAvailable(); } catch { return false; } })();
  const polyAuth = Boolean(process.env.POLYMARKET_PRIVATE_KEY);
  const polyAllowTrade = process.env.ALLOW_TRADE === "1";
  const dailySpent = cbSafety.dailyExecutedUsd() + pmSafety.dailyExecutedUsd();
  const dailyCap = cbSafety.maxDaily() + pmSafety.maxDaily();
  const halted = ks.riskEngine.isHalted();
  const checks = [
    { ok: newestAge < 300, label: `data freshness < 5 min`, value: Number.isFinite(newestAge) ? `${Math.round(newestAge)}s` : "no snapshots" },
    { ok: !halted, label: "kill switch clear", value: halted ? "ENGAGED" : "ok" },
    { ok: dailySpent < dailyCap * 0.8, label: "daily spend under 80% cap", value: `$${dailySpent.toFixed(2)} / $${dailyCap.toFixed(0)}` },
    { ok: cbAuth, label: "Coinbase JWT loaded", value: cbAuth ? "ok" : "missing (set COINBASE_CDP_KEY_FILE or env vars)" },
    // Polymarket is optional — if you're not arming live trading there, missing is fine.
    { ok: !polyAllowTrade || polyAuth, label: polyAllowTrade ? "Polymarket signer loaded" : "Polymarket signer (N/A in sim)", value: polyAuth ? "ok" : polyAllowTrade ? "MISSING (ALLOW_TRADE=1 but no key)" : "—" },
  ];
  const allReady = checks.every((c) => c.ok);

  return (
    <div className="space-y-6">
      <AutoRefresh label="crypto" intervalMs={15_000} />

      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Crypto trading challenge — live</h1>
          <p className="text-zinc-400 text-sm mt-1">
            Coinbase spot is the truth source. Polymarket Crypto markets are the venue. The video
            (<Link href="https://www.youtube.com/watch?v=6UBGecQTsZE" target="_blank" className="text-accent-blue hover:underline">Codex 5.5 vs Claude 4.7</Link>)
            framed it as rolling 5-min "Will BTC be Up?" binaries — same edge calc surfaced here.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">next 5-min window</div>
          <LiveCountdown intervalMin={WINDOW_MIN} variant="big" />
        </div>
      </div>

      {/* Polymarket-style 5m Up/Down widgets — one big card for each product */}
      <section className="space-y-4">
        {productPanels.map((p) => {
          const upDir = p.priceToBeat != null && p.latest != null && p.latest.close >= p.priceToBeat;
          const livePrice = p.latest?.close ?? p.cbSnap?.midpoint ?? null;
          const winsCount = p.completedBars.filter((b) => b.deltaUsd >= 0).length;
          const lossesCount = p.completedBars.length - winsCount;
          return (
            <div key={p.pid} className={`card ${upDir ? "border-accent-green/40" : "border-accent-red/40"}`} data-testid={`crypto-card-${p.pid}`}>
              <div className="grid grid-cols-12 gap-6 items-start">
                {/* Left: title + countdown + window range */}
                <div className="col-span-3">
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-lg font-semibold tracking-tight">
                      <Link href={`/crypto/${p.pid}`} className="hover:text-accent-blue" data-testid={`deep-dive-link-${p.pid}`}>
                        {p.pid.split("-")[0]} Up or Down 5m →
                      </Link>
                    </h2>
                  </div>
                  <div className="mt-1">
                    <ClientOnly fallback={<span className="text-zinc-500">…</span>}>
                      <WindowRangeLabel intervalMin={WINDOW_MIN} />
                    </ClientOnly>
                  </div>
                  <div className="mt-3">
                    <ClientOnly fallback={<div className="font-mono text-3xl tabular-nums text-zinc-300">––:––</div>}>
                      <LiveCountdown intervalMin={WINDOW_MIN} variant="big" />
                    </ClientOnly>
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-2">{p.completedBars.length}-window history: {winsCount}W / {lossesCount}L</div>
                </div>

                {/* Middle: Price To Beat vs Current */}
                <div className="col-span-4 border-l border-r border-ink-800 px-6">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Price To Beat</div>
                  <div className="font-mono text-2xl tabular-nums">${p.priceToBeat != null ? p.priceToBeat.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}</div>
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mt-3">Current Price</div>
                  <div className={`font-mono text-2xl tabular-nums ${upDir ? "text-accent-green" : "text-accent-red"}`}>
                    ${livePrice != null ? livePrice.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
                  </div>
                  <div className="text-[10px] text-zinc-500 mt-1">
                    {p.priceToBeat != null && livePrice != null
                      ? `${upDir ? "+" : ""}$${(livePrice - p.priceToBeat).toFixed(2)} (${(((livePrice - p.priceToBeat) / p.priceToBeat) * 100).toFixed(3)}%)`
                      : "—"}
                  </div>
                </div>

                {/* Right: Up prob + bars history + sparkline */}
                <div className="col-span-5">
                  <div className="flex items-baseline justify-between mb-2">
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500">Our Up estimate</div>
                      <div className="font-mono text-2xl tabular-nums">{p.ourUp != null ? `${(p.ourUp * 100).toFixed(0)}%` : "—"}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500">PM-implied</div>
                      <div className="font-mono text-2xl tabular-nums text-zinc-400" title="No PM rolling-5m market currently snapshotted">{p.pmUp != null ? `${(p.pmUp * 100).toFixed(0)}%` : "—"}</div>
                    </div>
                  </div>
                  <div className="mt-2">
                    <div className="text-[10px] text-zinc-500 mb-1">last 10 windows (close − open)</div>
                    <WindowBars bars={p.completedBars} width={360} height={50} />
                  </div>
                  <div className="mt-2">
                    <Sparkline values={p.closes.slice(-60)} width={360} height={30} stroke={upDir ? "#46d39a" : "#ff6e6e"} />
                    <div className="text-[10px] text-zinc-500">last 60 × 1-min closes</div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </section>

      {/* Compact momentum side-panel — all 5 coins at a glance */}
      <section className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0">All coins at a glance</h2>
          <span className="text-[10px] text-zinc-500">5-min momentum · refreshes with page</span>
        </div>
        <table className="list">
          <thead><tr><th>Coin</th><th className="text-right">Price</th><th className="text-right">24h</th><th className="text-right">vel 5m</th><th className="text-right">accel 5m</th><th className="text-right">Our Up%</th></tr></thead>
          <tbody>
            {productPanels.map((p) => (
              <tr key={p.pid} data-testid={`row-${p.pid}`}>
                <td className="text-zinc-100 font-semibold">{p.pid.split("-")[0]}</td>
                <td className="text-right tabular-nums">${fmtPrice(p.latest?.close ?? p.cbSnap?.midpoint)}</td>
                <td className={`text-right tabular-nums ${pctClass(p.cbSnap?.price_24h_change_pct != null ? p.cbSnap.price_24h_change_pct / 100 : null)}`}>
                  {p.cbSnap?.price_24h_change_pct != null ? `${p.cbSnap.price_24h_change_pct >= 0 ? "+" : ""}${p.cbSnap.price_24h_change_pct.toFixed(2)}%` : "—"}
                </td>
                <td className={`text-right tabular-nums ${pctClass(p.v5)}`}>{fmtPct(p.v5, 3)}</td>
                <td className={`text-right tabular-nums ${pctClass(p.a5)}`}>{fmtPct(p.a5, 3)}</td>
                <td className="text-right tabular-nums font-semibold">{p.ourUp != null ? `${(p.ourUp * 100).toFixed(0)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div className={`card ${allReady ? "border-accent-green/30" : "border-accent-amber/40"}`}>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="card-title m-0">Trade readiness (preflight)</h2>
            <span className={allReady ? "pill-green" : "pill-amber"}>{allReady ? "READY" : "NOT READY"}</span>
          </div>
          <ul className="text-xs space-y-1">
            {checks.map((c) => (
              <li key={c.label} className="flex items-baseline justify-between">
                <span>
                  <span className={`mr-2 ${c.ok ? "text-accent-green" : "text-accent-red"}`}>{c.ok ? "✓" : "✗"}</span>
                  <span className="text-zinc-300">{c.label}</span>
                </span>
                <span className="text-zinc-500 tabular-nums text-[10px]">{c.value}</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-zinc-500 mt-2 italic">
            Mirrors the video's preflight pattern: every check must pass before any agent's
            entry signal routes to the unified router.
          </p>
        </div>

        <div className="card">
          <h2 className="card-title">Position caps (Coinbase capsule)</h2>
          <table className="w-full text-xs tabular-nums">
            <tbody>
              <tr><td className="text-zinc-500 py-1">per order</td><td className="text-right">${cbSafety.maxTrade().toFixed(2)}</td><td className="text-right text-zinc-500"><code className="text-[10px]">COINBASE_MAX_TRADE_USD</code></td></tr>
              <tr><td className="text-zinc-500 py-1">daily cap</td><td className={`text-right ${dailySpent / (cbSafety.maxDaily() || 1) > 0.8 ? "text-accent-amber" : ""}`}>${cbSafety.maxDaily().toFixed(2)}</td><td className="text-right text-zinc-500"><code className="text-[10px]">COINBASE_MAX_DAILY_USD</code></td></tr>
              <tr><td className="text-zinc-500 py-1">spent today (CB)</td><td className="text-right">${cbSafety.dailyExecutedUsd().toFixed(2)}</td><td className="text-right text-zinc-500">{cbSafety.mode()}</td></tr>
              <tr><td className="text-zinc-500 py-1">spent today (PM)</td><td className="text-right">${pmSafety.dailyExecutedUsd().toFixed(2)}</td><td className="text-right text-zinc-500">{pmSafety.mode()}</td></tr>
            </tbody>
          </table>
          <p className="text-[10px] text-zinc-500 mt-2 italic">
            Video defaults: ≤ $3.25/order, ≤ $5.25/market, ≤ $8.25 total open. Tune ours via
            <code className="mx-1">COINBASE_MAX_TRADE_USD</code> / <code className="mx-1">COINBASE_MAX_DAILY_USD</code>
            in <code>.env.local</code>.
          </p>
        </div>
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0">Today's scoreboard</h2>
          <span className="text-[10px] text-zinc-500">paper agents, by net P&amp;L</span>
        </div>
        {scoreboard.length === 0 ? (
          <p className="text-xs text-zinc-500">
            No trades today yet. Agents fire as the snapshot worker fills history — momentum strategies need ~30 min
            of 1-min candles to start firing, fade-spike strategies need hours of poly snapshot history.
          </p>
        ) : (
          <table className="list">
            <thead><tr><th>Agent</th><th className="text-right">W</th><th className="text-right">L</th><th className="text-right">Trades</th><th className="text-right">Net P&amp;L</th></tr></thead>
            <tbody>
              {scoreboard.map((r) => (
                <tr key={r.id}>
                  <td><Link className="text-zinc-100 hover:text-accent-blue" href={`/arena/${r.id}`}>{r.name}</Link></td>
                  <td className="text-right text-accent-green tabular-nums">{r.wins}</td>
                  <td className="text-right text-accent-red tabular-nums">{r.losses}</td>
                  <td className="text-right tabular-nums">{r.trades}</td>
                  <td className={`text-right tabular-nums ${r.net_pnl >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                    {r.net_pnl >= 0 ? "+" : ""}${r.net_pnl.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="card-title m-0">Polymarket Crypto markets ({polyMarkets.length})</h2>
          <span className="text-[10px] text-zinc-500">snapshotted in last 3h · sorted by 24h volume</span>
        </div>
        {polyMarkets.length === 0 ? (
          <p className="text-xs text-zinc-500">No crypto markets in the last 3h — run <code>npm run worker:snapshot</code>.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Question</th><th className="text-right">Implied</th><th className="text-right">Spread</th><th className="text-right">24h vol</th></tr></thead>
            <tbody>
              {polyMarkets.map((m) => (
                <tr key={m.token_id}>
                  <td>
                    <Link href={`/markets/condition/${m.condition_id}`} className="text-zinc-100 hover:text-accent-blue">
                      {m.question.slice(0, 90)}{m.question.length > 90 ? "…" : ""}
                    </Link>
                  </td>
                  <td className="text-right tabular-nums">{(m.midpoint * 100).toFixed(1)}%</td>
                  <td className="text-right tabular-nums text-zinc-500">{m.spread != null ? (m.spread * 100).toFixed(2) + "pp" : "—"}</td>
                  <td className="text-right tabular-nums text-zinc-400">{m.volume_24h != null ? "$" + m.volume_24h.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <nav className="text-xs text-zinc-500 flex gap-4">
        <Link href="/api/crypto/dashboard" className="hover:text-zinc-300">→ Dashboard JSON</Link>
        <Link href="/arena" className="hover:text-zinc-300">→ Arena</Link>
        <Link href="/safety" className="hover:text-zinc-300">→ Safety</Link>
      </nav>
    </div>
  );
}
