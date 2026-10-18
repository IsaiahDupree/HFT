import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db/client";
import { loadRecentCandles, velocity, acceleration } from "@/lib/arena/momentum";
import { LiveCountdown, WindowRangeLabel } from "@/components/LiveCountdown";
import { LivePrice } from "@/components/LivePrice";
import { ClientOnly } from "@/components/ClientOnly";
import { WindowBars } from "@/components/WindowBars";
import { AutoRefresh } from "@/components/AutoRefresh";
import { SimilarMarketsPanel } from "@/components/SimilarMarketsPanel";

export const dynamic = "force-dynamic";

const WINDOW_MIN = 5;
const ALL_PRODUCTS = (process.env.ARENA_SNAPSHOT_CB_PRODUCTS ?? "BTC-USD,ETH-USD,SOL-USD,XRP-USD,DOGE-USD")
  .split(",").map((s) => s.trim()).filter(Boolean);
const FULL_NAME: Record<string, string> = {
  "BTC-USD": "Bitcoin",
  "ETH-USD": "Ethereum",
  "SOL-USD": "Solana",
  "XRP-USD": "XRP",
  "DOGE-USD": "Dogecoin",
};

function naiveUpProb(vel5: number | null): number | null {
  if (vel5 == null || !Number.isFinite(vel5)) return null;
  return 1 / (1 + Math.exp(-vel5 * 600));
}
function fmtAge(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${(sec / 3600).toFixed(1)}h ago`;
}

export default async function CryptoDeepDive({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const productId = symbol.toUpperCase();
  if (!ALL_PRODUCTS.includes(productId)) {
    notFound();
  }
  const sym = productId.split("-")[0];
  const fullName = FULL_NAME[productId] ?? sym;

  // Candles + momentum for THIS product
  const candles = loadRecentCandles(productId, 240);
  const closes = candles.map((c) => c.close);
  const latest = candles[candles.length - 1];
  const v5 = velocity(candles, 5);
  const v15 = velocity(candles, 15);
  const a5 = acceleration(candles, 5);
  const ourUp = naiveUpProb(Number.isFinite(v5) ? v5 : null);

  // Window math
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - (nowSec % (WINDOW_MIN * 60));
  const startCandle = candles.find((c) => c.start_unix === windowStart) ?? candles[candles.length - WINDOW_MIN];
  const priceToBeat = startCandle?.open ?? null;
  const currentPrice = latest?.close ?? null;
  const delta = (priceToBeat != null && currentPrice != null) ? currentPrice - priceToBeat : null;
  const deltaPct = (priceToBeat != null && delta != null) ? delta / priceToBeat : null;

  // Bar history — last 10 completed windows, format labels like "5:20PM"
  const completedBars: Array<{ label: string; deltaUsd: number }> = [];
  for (let w = 10; w >= 1; w--) {
    const wStart = windowStart - w * WINDOW_MIN * 60;
    const wEnd = wStart + WINDOW_MIN * 60;
    const startC = candles.find((c) => c.start_unix === wStart);
    const endC = candles.find((c) => c.start_unix === wEnd - 60);
    if (startC && endC) {
      const startTime = new Date(wStart * 1000);
      const hh = startTime.getHours() % 12 || 12;
      const mm = String(startTime.getMinutes()).padStart(2, "0");
      const ampm = startTime.getHours() >= 12 ? "PM" : "AM";
      completedBars.push({ label: `${hh}:${mm}${ampm}`, deltaUsd: endC.close - startC.open });
    }
  }

  // For the sidebar — compute Up estimate for the OTHER products
  const others = ALL_PRODUCTS.map((pid) => {
    const cs = loadRecentCandles(pid, 30);
    const v = velocity(cs, 5);
    return { productId: pid, upProbability: naiveUpProb(Number.isFinite(v) ? v : null) };
  });

  const lastSnapAt = db().prepare(
    `SELECT captured_at FROM coinbase_snapshots WHERE product_id = ? ORDER BY captured_at DESC LIMIT 1`,
  ).get(productId) as { captured_at: string } | undefined;
  const ageSeconds = lastSnapAt
    ? Math.max(0, (Date.now() - new Date(lastSnapAt.captured_at.replace(" ", "T") + "Z").getTime()) / 1000)
    : null;

  const upDir = delta != null && delta >= 0;

  return (
    <div className="space-y-6">
      <AutoRefresh label={sym.toLowerCase()} intervalMs={15_000} />

      <div className="flex items-baseline gap-3 text-zinc-400 text-xs">
        <Link href="/crypto" className="hover:text-zinc-300">← back to all crypto markets</Link>
      </div>

      {/* Hero card — Polymarket faithful */}
      <section className={`card ${upDir ? "border-accent-green/40" : "border-accent-red/40"}`} data-testid="crypto-hero">
        <div className="grid grid-cols-12 gap-6">
          {/* Left 8 cols: title, window, price-to-beat, current price */}
          <div className="col-span-8">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${upDir ? "bg-accent-green/20 text-accent-green" : "bg-accent-red/20 text-accent-red"}`}>
                {sym}
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{sym} Up or Down 5m</h1>
                <div className="text-xs text-zinc-400 mt-0.5">
                  <ClientOnly fallback={<span className="text-zinc-500">…</span>}>
                    <WindowRangeLabel intervalMin={WINDOW_MIN} />
                  </ClientOnly>
                  {" "}ET
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-8 mt-6">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Price To Beat</div>
                <div className="font-mono text-3xl tabular-nums text-zinc-200">
                  ${priceToBeat != null ? priceToBeat.toLocaleString(undefined, { maximumFractionDigits: priceToBeat >= 1 ? 2 : 4 }) : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Current Price</div>
                <div className={`text-3xl leading-none ${upDir ? "text-accent-green" : "text-accent-red"}`}>
                  <ClientOnly fallback={<span className="font-mono text-zinc-500">$––,––</span>}>
                    <LivePrice productId={productId} className="text-3xl" />
                  </ClientOnly>
                </div>
                {delta != null && (
                  <div className={`text-xs tabular-nums mt-1 ${upDir ? "text-accent-green" : "text-accent-red"}`}>
                    {delta >= 0 ? "+" : ""}${delta.toFixed(2)} ({(deltaPct! * 100).toFixed(3)}%)
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right 4 cols: countdown + status */}
          <div className="col-span-4 border-l border-ink-800 pl-6">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Time remaining</div>
            <div className="mt-2">
              <ClientOnly fallback={<div className="font-mono text-3xl tabular-nums text-zinc-300">––:––</div>}>
                <LiveCountdown intervalMin={WINDOW_MIN} variant="big" />
              </ClientOnly>
            </div>
            <div className="text-[10px] text-zinc-500 mt-4">
              data: <span className="text-zinc-300">Coinbase {productId}</span>
              {ageSeconds != null && <span className="ml-1">· {fmtAge(ageSeconds)}</span>}
            </div>
            <div className="text-[10px] text-zinc-500 mt-1">
              window auto-rolls every {WINDOW_MIN}m
            </div>
          </div>
        </div>

        {/* Bar chart history — 10 completed windows */}
        <div className="mt-6 pt-4 border-t border-ink-800">
          <div className="flex items-baseline justify-between mb-2">
            <h3 className="text-xs uppercase tracking-wider text-zinc-500">Recent windows (close − open per window)</h3>
            <span className="text-[10px] text-zinc-500">last {completedBars.length} × {WINDOW_MIN}m</span>
          </div>
          <WindowBars bars={completedBars} width={760} height={64} />
          <div className="flex justify-between mt-1 text-[10px] text-zinc-500">
            {completedBars.length > 0 && (
              <>
                <span>{completedBars[0].label}</span>
                <span>{completedBars[Math.floor(completedBars.length / 2)].label}</span>
                <span>{completedBars[completedBars.length - 1].label}</span>
              </>
            )}
          </div>
        </div>
      </section>

      {/* 8 / 4 split: explainer left, sidebar right */}
      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-8 space-y-4">
          {/* Our Up estimate panel */}
          <section className="card">
            <h3 className="card-title">Our Up estimate (next {WINDOW_MIN}m)</h3>
            <div className="grid grid-cols-3 gap-6">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Implied prob (Up)</div>
                <div className="font-mono text-2xl tabular-nums">{ourUp != null ? `${(ourUp * 100).toFixed(0)}%` : "—"}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">5-min velocity</div>
                <div className={`font-mono text-2xl tabular-nums ${v5 >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                  {Number.isFinite(v5) ? `${v5 >= 0 ? "+" : ""}${(v5 * 100).toFixed(3)}%` : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Acceleration</div>
                <div className={`font-mono text-2xl tabular-nums ${a5 >= 0 ? "text-accent-green" : "text-accent-red"}`}>
                  {Number.isFinite(a5) ? `${a5 >= 0 ? "+" : ""}${(a5 * 100).toFixed(3)}%` : "—"}
                </div>
              </div>
            </div>
            <p className="text-[10px] text-zinc-500 mt-3 italic">
              Naïve logistic on 5-min velocity. ±0.5% velocity ⇒ ~95% confidence. Replace with a
              Black-Scholes prob(end &gt; start | T, σ) once Chainlink stream is plumbed.
            </p>
          </section>

          {/* Resolution explainer */}
          <section className="card text-sm text-zinc-300 leading-relaxed">
            <h3 className="card-title">How this market resolves</h3>
            <p>
              This market resolves to <strong className="text-accent-green">Up</strong> if the {fullName} price at the
              end of the window is greater than or equal to the price at the beginning, otherwise <strong className="text-accent-red">Down</strong>.
            </p>
            <p className="mt-2">
              <strong>Polymarket's settlement source</strong> is the{" "}
              <a className="text-accent-blue hover:underline" target="_blank" href="https://data.chain.link/streams/btc-usd" rel="noopener noreferrer">
                Chainlink {sym}/USD data stream
              </a>
              . <strong>Our truth source</strong> for live signals on this page is the Coinbase spot ticker for{" "}
              <code className="text-zinc-200">{productId}</code> (1-min candles via <code>publicGetProductCandles</code>).
              They generally track within a few cents, but for serious live trading
              you should subscribe to the same Chainlink stream Polymarket settles from to remove
              the basis risk between Coinbase last-trade and Chainlink composite.
            </p>
            <p className="text-zinc-500 text-xs mt-3">
              Live data may be delayed by a few seconds and can be influenced by price activity on other
              exchanges and broader market conditions.
            </p>
          </section>

          {/* What an agent would do (placeholder "one-tap" CTA) */}
          <section className="card">
            <h3 className="card-title">What an arena agent would do this tick</h3>
            <p className="text-xs text-zinc-400 mb-3">
              The momentum-burst genome (kind=<code>cb_momentum_burst</code>) would fire if velocity ≥
              <code className="mx-1">vel_entry_pct</code> AND acceleration ≥ <code className="mx-1">accel_min</code>.
              Below — given current signal, here's the verdict.
            </p>
            <div className="flex items-baseline gap-4 mt-3">
              {(() => {
                const wouldFireLong = Number.isFinite(v5) && Number.isFinite(a5) && v5 >= 0.002 && a5 >= 0.0001;
                const wouldFireShort = Number.isFinite(v5) && Number.isFinite(a5) && v5 <= -0.002 && a5 <= -0.0001;
                return (
                  <>
                    <div className="text-xs">
                      <span className="text-zinc-500">Long: </span>
                      <span className={wouldFireLong ? "text-accent-green font-semibold" : "text-zinc-500"}>{wouldFireLong ? "FIRE" : "skip"}</span>
                    </div>
                    <div className="text-xs">
                      <span className="text-zinc-500">Short: </span>
                      <span className={wouldFireShort ? "text-accent-red font-semibold" : "text-zinc-500"}>{wouldFireShort ? "FIRE" : "skip"}</span>
                    </div>
                  </>
                );
              })()}
            </div>
            <Link href={`/arena`} className="text-xs text-accent-blue hover:underline inline-block mt-3">→ See live arena leaderboard</Link>
          </section>
        </div>

        {/* Right sidebar — similar markets */}
        <aside className="col-span-4 space-y-4">
          <SimilarMarketsPanel markets={others} currentSymbol={productId} />

          {/* "One-tap buy" placeholder card matching the Polymarket sidebar */}
          <div className="card">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">Status</div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-sm font-semibold">{sym} Up or Down 5m</span>
              <span className={`pill ${upDir ? "pill-green" : "pill-red"}`}>{upDir ? "Up" : "Down"}</span>
            </div>
            <button type="button" className="w-full mt-3 text-xs px-3 py-2 rounded bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30 transition-colors" disabled>
              One-tap buy (arena agents only)
            </button>
            <p className="text-[10px] text-zinc-500 mt-2 italic">
              Manual entry intentionally disabled. Live fills come from arena agents bound to a capsule
              via the unified ExecutionRouter — gated by <code>COINBASE_ALLOW_TRADE=1</code> + per-trade caps.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
