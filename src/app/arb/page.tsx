import Link from "next/link";
import { poly } from "@/lib/polymarket/client";
import { findSingleMarketArbs, type MarketPair, type OrderBookSummary } from "@/lib/polymarket/arb";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function runnerStatus() {
  const live = process.env.ALLOW_TRADE === "1";
  return {
    mode: live ? "LIVE" : "DRY_RUN",
    maxTrade: Number(process.env.MAX_TRADE_USD ?? "25"),
    maxDaily: Number(process.env.MAX_DAILY_USD ?? "100"),
  };
}

function recentRunnerEvents(limit = 30) {
  return db().prepare(
    `SELECT id, event_type, summary, payload_json, created_at
     FROM evolution_log
     WHERE event_type LIKE 'arb-%' OR event_type = 'kill-switch'
     ORDER BY id DESC LIMIT ?`,
  ).all(limit) as Array<{ id: number; event_type: string; summary: string; payload_json: string; created_at: string }>;
}

function dailySpent() {
  const row = db().prepare(
    `SELECT COALESCE(SUM(json_extract(payload_json, '$.cost_usd')), 0) AS spend, COUNT(*) AS n
     FROM evolution_log
     WHERE event_type = 'arb-executed' AND created_at > datetime('now', '-1 day')`,
  ).get() as { spend: number; n: number };
  return row;
}

export default async function ArbPage({ searchParams }: { searchParams: Promise<{ n?: string; fee?: string }> }) {
  const { n, fee } = await searchParams;
  const N = Math.min(40, Math.max(4, Number(n ?? 20)));
  const feeBps = Math.max(0, Number(fee ?? 50));

  const sampling = await poly.samplingMarkets(N).catch(() => ({ data: [] as any[] }));
  const pairs: MarketPair[] = (sampling.data ?? [])
    .map((m: any) => {
      const yes = m.tokens?.find((t: any) => t.outcome === "Yes");
      const no = m.tokens?.find((t: any) => t.outcome === "No");
      if (!yes?.token_id || !no?.token_id || !m.condition_id) return null;
      return {
        conditionId: m.condition_id as string,
        question: (m.question ?? "(no question)") as string,
        yesTokenId: yes.token_id as string,
        noTokenId: no.token_id as string,
      };
    })
    .filter(Boolean) as MarketPair[];

  const books = await Promise.all(
    pairs.map(async (p) => {
      const [y, no] = await Promise.all([
        poly.orderbook(p.yesTokenId).catch(() => null),
        poly.orderbook(p.noTokenId).catch(() => null),
      ]);
      return { pair: p, yesBook: y as OrderBookSummary | null, noBook: no as OrderBookSummary | null };
    }),
  );

  const arbs = findSingleMarketArbs(books, { feeBps, depthCapFraction: 0.5, minProfitUsd: 0.10 });
  const scanned = books.filter((b) => b.yesBook && b.noBook).length;
  const status = runnerStatus();
  const events = recentRunnerEvents();
  const spent = dailySpent();
  const detections = events.filter((e) => e.event_type === "arb-detection").length;
  const dryRuns = events.filter((e) => e.event_type === "arb-dry-run").length;
  const executed = events.filter((e) => e.event_type === "arb-executed").length;
  const rejected = events.filter((e) => e.event_type === "arb-rejected").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Single-market arbitrage scan</h1>
        <p className="text-zinc-400 text-sm mt-1">
          For each sampling market, fetches both YES and NO orderbooks and flags any with{" "}
          <code className="text-zinc-300">ask_yes + ask_no &lt; $1 - fees</code>. The websocket runner under{" "}
          <code className="text-zinc-300">npm run arb:runner</code> subscribes to these markets and dispatches{" "}
          to the executor on every book update.
        </p>
      </div>

      <section className="grid grid-cols-4 gap-3">
        <Stat label="Runner mode" value={status.mode} accent={status.mode === "LIVE" ? "red" : "amber"} />
        <Stat label="Cap / trade" value={`$${status.maxTrade}`} />
        <Stat label="Spent today" value={`$${spent.spend.toFixed(2)} / $${status.maxDaily}`} />
        <Stat label="Detections (recent)" value={`${detections} det · ${dryRuns} dry · ${executed} live · ${rejected} rej`} />
      </section>

      <form action="" className="flex gap-3 text-xs items-end">
        <label className="flex flex-col">
          <span className="text-zinc-500 mb-1">Markets to scan</span>
          <input name="n" type="number" min="4" max="40" defaultValue={N} className="bg-ink-900 border border-ink-700 rounded px-2 py-1 w-24" />
        </label>
        <label className="flex flex-col">
          <span className="text-zinc-500 mb-1">Fee buffer (bps)</span>
          <input name="fee" type="number" min="0" max="500" defaultValue={feeBps} className="bg-ink-900 border border-ink-700 rounded px-2 py-1 w-24" />
        </label>
        <button className="px-3 py-1.5 rounded bg-accent-blue/20 text-accent-blue hover:bg-accent-blue/30">Re-scan</button>
        <span className="ml-auto text-zinc-500">Scanned {scanned}/{pairs.length} markets · found {arbs.length} live arbs</span>
      </form>

      {arbs.length === 0 ? (
        <div className="card">
          <p className="text-zinc-400 text-sm">No live YES+NO arbs above the fee buffer right now.</p>
          <p className="text-zinc-500 text-xs mt-2">
            This is the normal state — HFT systems capture these within ~2s per the article. Run the websocket
            runner with <code className="text-zinc-300">npm run arb:runner</code> to detect intra-update windows
            instead of just polling.
          </p>
        </div>
      ) : (
        <div className="card">
          <table className="list">
            <thead>
              <tr>
                <th>Market</th><th>YES ask</th><th>NO ask</th><th>Σ</th><th>Edge/sh</th><th>Exec sh</th><th>Profit</th><th>Quality</th>
              </tr>
            </thead>
            <tbody>
              {arbs.map((a) => (
                <tr key={a.conditionId}>
                  <td className="max-w-md truncate">
                    <Link href={`/markets/condition/${a.conditionId}`} className="text-accent-blue hover:underline">{a.question}</Link>
                  </td>
                  <td className="tabular-nums">{a.bestYesAsk.toFixed(3)}</td>
                  <td className="tabular-nums">{a.bestNoAsk.toFixed(3)}</td>
                  <td className="tabular-nums">{a.sumOfAsks.toFixed(3)}</td>
                  <td className="tabular-nums text-accent-green">${a.edgeAfterFeesPerShare.toFixed(4)}</td>
                  <td className="tabular-nums">{a.maxExecutableShares.toLocaleString()}</td>
                  <td className="tabular-nums text-accent-green">${a.expectedProfitUsd.toFixed(2)}</td>
                  <td className="tabular-nums text-zinc-500">{a.qualityScore.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="card">
        <h2 className="card-title">Recent runner activity</h2>
        {events.length === 0 ? (
          <p className="text-zinc-500 text-xs">No runner events yet. Start it with <code>npm run arb:runner</code> in a separate terminal.</p>
        ) : (
          <table className="list">
            <thead><tr><th>Time</th><th>Event</th><th>Summary</th><th>Detail</th></tr></thead>
            <tbody>
              {events.slice(0, 20).map((e) => {
                const p = (() => { try { return JSON.parse(e.payload_json); } catch { return {}; } })();
                const cost = p?.cost_usd ?? ((p?.planned?.yes?.sizeUsd && p?.planned?.no?.sizeUsd) ? (p.planned.yes.sizeUsd + p.planned.no.sizeUsd) : null);
                return (
                  <tr key={e.id}>
                    <td className="text-xs text-zinc-500 whitespace-nowrap">{e.created_at?.slice(11, 19)}</td>
                    <td><span className={`pill-${eventColor(e.event_type)}`}>{e.event_type.replace("arb-", "")}</span></td>
                    <td className="max-w-md truncate">{e.summary}</td>
                    <td className="text-xs text-zinc-400 tabular-nums">{cost ? `$${Number(cost).toFixed(2)}` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="card">
        <h2 className="card-title">Safety</h2>
        <ul className="text-xs text-zinc-400 space-y-1 list-disc list-inside">
          <li><code>ALLOW_TRADE=1</code> required for live submission; default is DRY_RUN (logs intent only).</li>
          <li>Per-trade cap <code>MAX_TRADE_USD</code> default $25; per-day cap <code>MAX_DAILY_USD</code> default $100.</li>
          <li>Position size capped at 50% of orderbook depth (the article's rule for avoiding self-impact).</li>
          <li>Emergency cancel-all: <code>npm run arb:kill</code></li>
        </ul>
      </div>

      <div className="card">
        <h2 className="card-title">Background</h2>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Single-market arb uses the basket equation <code>ask_yes + ask_no &lt; $1 - fees</code>.
          The combinatorial case (cross-market dependencies) uses{" "}
          <Link className="text-accent-blue" href="/research">an LP/IP solver</Link>{" "}
          (glpk.js, OSS): direct LP for ≤14 outcomes, column generation for larger universes
          (trader-side analog of the Frank-Wolfe + IP approach in{" "}
          <a className="text-accent-blue" href="https://arxiv.org/abs/1606.02825" target="_blank" rel="noopener noreferrer">arxiv:1606.02825</a>).
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "red" | "amber" | "green" }) {
  const cls = accent === "red" ? "text-accent-red" : accent === "amber" ? "text-accent-amber" : accent === "green" ? "text-accent-green" : "";
  return <div className="card"><div className="card-title">{label}</div><div className={`stat ${cls}`}>{value}</div></div>;
}

function eventColor(t: string): "green" | "red" | "amber" | "blue" {
  if (t === "arb-executed") return "green";
  if (t === "arb-rejected" || t === "arb-error" || t === "kill-switch") return "red";
  if (t === "arb-submitting" || t === "arb-partial") return "amber";
  return "blue";
}
