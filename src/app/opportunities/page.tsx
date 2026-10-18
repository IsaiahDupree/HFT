import Link from "next/link";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export const revalidate = 30;

type Row = { id: number; event_type: string; summary: string; payload_json: string; created_at: string };

function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null) return "—";
  return `${(Number(n) * 100).toFixed(digits)}%`;
}

function typeLabel(t: string): string {
  if (t === "near-resolution-opportunity") return "Near-resolution";
  if (t === "cross-timeframe-spread") return "Cross-timeframe";
  if (t === "orderbook-imbalance-signal") return "Orderbook imbalance";
  return t;
}

function typeColor(t: string): string {
  if (t === "near-resolution-opportunity") return "text-accent-green";
  if (t === "cross-timeframe-spread") return "text-accent-blue";
  if (t === "orderbook-imbalance-signal") return "text-accent-amber";
  return "text-zinc-400";
}

export default function OpportunitiesPage() {
  const rows = db()
    .prepare(
      `SELECT id, event_type, summary, payload_json, created_at FROM evolution_log
        WHERE event_type IN ('near-resolution-opportunity', 'cross-timeframe-spread', 'orderbook-imbalance-signal')
          AND created_at >= datetime('now', '-24 hours')
        ORDER BY created_at DESC LIMIT 200`,
    )
    .all() as Row[];

  const parsed = rows.map((r) => {
    let p: any = {};
    try {
      p = JSON.parse(r.payload_json);
    } catch {
      /* ignore */
    }
    return { ...r, p };
  });

  // Counters by type
  const counts: Record<string, number> = {};
  for (const r of parsed) counts[r.event_type] = (counts[r.event_type] ?? 0) + 1;

  // Last-scan timestamps
  const lastScans = {
    nrs: db().prepare(
      `SELECT created_at FROM evolution_log
        WHERE event_type IN ('near-resolution-opportunity', 'near-resolution-scan-empty')
        ORDER BY created_at DESC LIMIT 1`,
    ).get() as { created_at: string } | undefined,
    cts: db().prepare(
      `SELECT created_at FROM evolution_log
        WHERE event_type IN ('cross-timeframe-spread', 'cross-timeframe-scan-empty')
        ORDER BY created_at DESC LIMIT 1`,
    ).get() as { created_at: string } | undefined,
    obi: db().prepare(
      `SELECT created_at FROM evolution_log
        WHERE event_type IN ('orderbook-imbalance-signal', 'orderbook-scan-empty')
        ORDER BY created_at DESC LIMIT 1`,
    ).get() as { created_at: string } | undefined,
  };

  // Recent auto-exec activity
  const recentExec = db()
    .prepare(
      `SELECT id, summary, payload_json, created_at FROM evolution_log
        WHERE event_type = 'nrs-auto-exec'
          AND created_at >= datetime('now', '-24 hours')
        ORDER BY created_at DESC LIMIT 20`,
    )
    .all() as Array<{ id: number; summary: string; payload_json: string; created_at: string }>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Strategy opportunities</h1>
        <p className="text-xs text-zinc-500 mt-1">
          Unified 24h feed from the 3 strategy scanners. Run{" "}
          <code>npm run scan:near-resolution</code>, <code>npm run scan:cross-timeframe</code>,{" "}
          <code>npm run scan:orderbook-imbalance</code> to refresh.
        </p>
        <div className="flex flex-wrap gap-4 text-xs text-zinc-500 mt-2 tabular-nums">
          <span>
            NRS: <span className={typeColor("near-resolution-opportunity")}>{counts["near-resolution-opportunity"] ?? 0}</span> · last{" "}
            <span className="text-zinc-300">{lastScans.nrs?.created_at?.slice(0, 19).replace("T", " ") ?? "—"}</span>
          </span>
          <span>
            CTS: <span className={typeColor("cross-timeframe-spread")}>{counts["cross-timeframe-spread"] ?? 0}</span> · last{" "}
            <span className="text-zinc-300">{lastScans.cts?.created_at?.slice(0, 19).replace("T", " ") ?? "—"}</span>
          </span>
          <span>
            OBI: <span className={typeColor("orderbook-imbalance-signal")}>{counts["orderbook-imbalance-signal"] ?? 0}</span> · last{" "}
            <span className="text-zinc-300">{lastScans.obi?.created_at?.slice(0, 19).replace("T", " ") ?? "—"}</span>
          </span>
          <span>
            NRS auto-exec: <span className="text-zinc-300">{recentExec.length}</span> in 24h
          </span>
        </div>
      </div>

      {parsed.length === 0 ? (
        <section className="card text-sm text-zinc-500">
          No opportunities recorded in the last 24h. Either the scanners haven&apos;t run, or
          current market conditions don&apos;t meet thresholds. Run a scanner from the CLI to
          check now — empty scans also write &quot;scan-empty&quot; events so you can confirm
          the scanner is alive.
        </section>
      ) : (
        <section className="card overflow-x-auto">
          <h2 className="card-title mb-2">Opportunities (last 24h)</h2>
          <table className="list w-full text-xs">
            <thead>
              <tr>
                <th>Time UTC</th>
                <th>Type</th>
                <th>Market</th>
                <th>Side</th>
                <th className="text-right">Edge</th>
                <th className="text-right">Annualized</th>
                <th className="text-right">Strength</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {parsed.map((r) => (
                <tr key={r.id}>
                  <td className="tabular-nums">{r.created_at.slice(5, 16).replace("T", " ")}</td>
                  <td className={typeColor(r.event_type)}>{typeLabel(r.event_type)}</td>
                  <td className="text-zinc-300">
                    {String(r.p.marketTitle ?? r.p.marketKey ?? "—").slice(0, 50)}
                  </td>
                  <td>{r.p.side ?? r.p.cheapSide ?? "—"}</td>
                  <td className="text-right tabular-nums">{fmtPct(r.p.edge)}</td>
                  <td className="text-right tabular-nums">{fmtPct(r.p.annualizedEdge, 0)}</td>
                  <td className="text-right tabular-nums">{fmtPct(r.p.signalStrength, 0)}</td>
                  <td className="text-zinc-400">{String(r.p.reason ?? r.summary).slice(0, 70)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {recentExec.length > 0 && (
        <section className="card overflow-x-auto">
          <h2 className="card-title mb-2">Recent NRS auto-executions (last 24h)</h2>
          <table className="list w-full text-xs">
            <thead>
              <tr>
                <th>Time UTC</th>
                <th>Status</th>
                <th>Mode</th>
                <th className="text-right">USD</th>
                <th className="text-right">Kelly f</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {recentExec.map((r) => {
                let p: any = {};
                try {
                  p = JSON.parse(r.payload_json);
                } catch {
                  /* ignore */
                }
                const status = p.verdict?.status ?? "—";
                const isOk = ["filled", "partially_filled", "submitted"].includes(String(status));
                return (
                  <tr key={r.id}>
                    <td className="tabular-nums">{r.created_at.slice(5, 19).replace("T", " ")}</td>
                    <td className={isOk ? "text-accent-green" : "text-accent-red"}>{status}</td>
                    <td>{p.mode ?? "—"}</td>
                    <td className="text-right tabular-nums">${Number(p.orderUsd ?? 0).toFixed(0)}</td>
                    <td className="text-right tabular-nums">{Number(p.kellyFraction ?? 0).toFixed(4)}</td>
                    <td className="text-zinc-400">{r.summary.slice(0, 70)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="card text-xs text-zinc-500">
        <p>
          <strong className="text-zinc-300">Pipeline.</strong> Each scanner runs independently and
          emits opportunities to <code>evolution_log</code>. Agents see all 3 via{" "}
          <code>AgentContext.recentStrategyOpportunities</code>. To auto-execute near-resolution
          signals: <code>npm run worker:nrs-exec</code> (sim by default; <code>NRS_LIVE=1</code>{" "}
          arms live trading via the venue router + capsule pipeline).
        </p>
        <p className="mt-2">
          <Link className="text-accent-blue hover:underline" href="/safety">
            Safety control plane →
          </Link>
        </p>
      </section>
    </div>
  );
}
