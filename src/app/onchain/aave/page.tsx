import Link from "next/link";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type EvolutionRow = { id: number; summary: string; payload_json: string; created_at: string };

function fmtUsd(n: number): string {
  return `$${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function tierColor(t: string): string {
  switch (t) {
    case "liquidatable":
    case "pre_liquidation":
      return "text-accent-red";
    case "risky":
    case "cautious":
      return "text-accent-amber";
    case "healthy":
      return "text-accent-green";
    default:
      return "text-zinc-500";
  }
}

export default function AaveLiquidationsPage() {
  const handle = db();
  const recent = handle
    .prepare(
      `SELECT id, summary, payload_json, created_at
         FROM evolution_log
        WHERE event_type = 'aave-liquidation-risk'
          AND created_at >= datetime('now', '-1 day')
        ORDER BY created_at DESC
        LIMIT 100`,
    )
    .all() as EvolutionRow[];

  const lastScan = handle
    .prepare(
      `SELECT created_at FROM evolution_log
        WHERE event_type IN ('aave-liquidation-risk', 'aave-watch-empty')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get() as { created_at: string } | undefined;

  const parsed = recent.map((r) => {
    try {
      const p = JSON.parse(r.payload_json);
      return { id: r.id, created_at: r.created_at, ...p } as any;
    } catch {
      return { id: r.id, created_at: r.created_at } as any;
    }
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Aave V3 liquidation risk (Polygon)</h1>
        <p className="text-xs text-zinc-500 mt-1">
          Tracked wallets&apos; Aave V3 health-factor snapshots in the last 24h. HF&lt;1.0 = liquidatable
          right now. Run <code>npm run watch:aave-liq</code> to refresh.
        </p>
        {lastScan && (
          <p className="text-xs text-zinc-500 mt-1">
            last scan: <span className="text-zinc-300 tabular-nums">{lastScan.created_at.slice(0, 19).replace("T", " ")} UTC</span>
          </p>
        )}
      </div>

      {parsed.length === 0 ? (
        <section className="card text-sm text-zinc-500">
          No risky Aave positions observed in the last 24h.{" "}
          <Link href="/tracked" className="text-accent-blue hover:underline">
            Browse tracked wallets
          </Link>{" "}
          or run <code>npm run watch:aave-liq</code> to scan now.
        </section>
      ) : (
        <table className="list w-full text-xs">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Wallet</th>
              <th className="text-right">HF</th>
              <th className="text-right">Collateral</th>
              <th className="text-right">Debt</th>
              <th>Tier</th>
              <th>Advisor</th>
            </tr>
          </thead>
          <tbody>
            {parsed.map((r) => (
              <tr key={r.id}>
                <td className="tabular-nums">{r.created_at.slice(5, 16).replace("T", " ")}</td>
                <td>
                  <Link href={`/wallets/${r.wallet}`} className="text-accent-blue hover:underline font-mono">
                    {r.wallet?.slice(0, 12)}…
                  </Link>
                </td>
                <td className={`text-right tabular-nums ${(r.healthFactor ?? 0) < 1.1 ? "text-accent-red" : ""}`}>
                  {r.healthFactor != null && Number.isFinite(r.healthFactor)
                    ? Number(r.healthFactor).toFixed(2)
                    : "—"}
                </td>
                <td className="text-right tabular-nums">{fmtUsd(r.totalCollateralUsd ?? 0)}</td>
                <td className="text-right tabular-nums">{fmtUsd(r.totalDebtUsd ?? 0)}</td>
                <td className={tierColor(r.riskTier)}>{r.riskTier}</td>
                <td>
                  <Link href={`/onchain/leverage/${r.wallet}`} className="text-accent-blue hover:underline">
                    advisor →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="card text-xs text-zinc-500">
        <p>
          <strong className="text-zinc-300">Pipeline.</strong> The watcher reads Aave V3 Pool.getUserAccountData
          via a Polygon RPC for each tracked wallet, logs risky positions to evolution_log, dedupes within the
          hour. Pair this view with the Polymarket fingerprint to spot whether the wallet was a forced seller
          (HF crash + simultaneous Polymarket exit) vs. a planned hedge unwind.
        </p>
      </section>
    </div>
  );
}
