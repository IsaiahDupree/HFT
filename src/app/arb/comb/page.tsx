import Link from "next/link";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Event = {
  id: number;
  event_type: string;
  summary: string;
  payload_json: string;
  created_at: string;
};

export default function CombArbPage() {
  const events = db().prepare(
    "SELECT id, event_type, summary, payload_json, created_at FROM evolution_log WHERE event_type = 'comb-arb-detection' ORDER BY id DESC LIMIT 50",
  ).all() as Event[];

  return (
    <div className="space-y-6">
      <div>
        <Link href="/arb" className="text-xs text-zinc-500 hover:text-zinc-300">← single-market arb</Link>
        <h1 className="text-2xl font-semibold mt-1">Combinatorial arbitrage detections</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Multi-market arbs discovered by scanning Gamma event groups with the LP solver{" "}
          (<code className="text-zinc-300">findCombinatorialArbs</code>: direct LP for ≤14 outcomes,{" "}
          column generation for larger universes). Run{" "}
          <code className="text-zinc-300">npm run arb:comb</code> to refresh.
        </p>
      </div>

      {events.length === 0 ? (
        <div className="card">
          <p className="text-zinc-400 text-sm">No combinatorial arbs detected yet.</p>
          <p className="text-zinc-500 text-xs mt-2">
            Trigger a scan with <code>npm run arb:comb</code>. With no explicit dependency constraints,
            the LP finds basket arbs across markets within an event but won&apos;t catch logical-implication
            arbs (e.g. &quot;Republicans win PA by 5+&quot; ⇒ &quot;Trump wins PA&quot;) — that requires an
            LLM-based constraint inference layer, the next iteration.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {events.map((e) => {
            let p: any = {};
            try { p = JSON.parse(e.payload_json); } catch {}
            const arb = p.arb ?? {};
            return (
              <div key={e.id} className="card">
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-lg font-medium">{p.eventTitle ?? "(no title)"}</h3>
                  <span className="text-xs text-zinc-500">{e.created_at}</span>
                </div>
                <div className="grid grid-cols-4 gap-3 text-xs mb-3">
                  <Cell label="Markets analyzed" value={(p.marketsAnalyzed ?? 0).toString()} />
                  <Cell label="Tokens" value={(p.tokenCount ?? 0).toString()} />
                  <Cell label="Total cost" value={`$${Number(arb.totalCostUsd ?? 0).toFixed(2)}`} />
                  <Cell label="Edge" value={`$${Number(arb.edgeUsd ?? 0).toFixed(2)}`} accent="green" />
                </div>
                <p className="text-xs text-zinc-400 mb-2">{arb.notes}</p>
                {Array.isArray(arb.basket) && arb.basket.length > 0 && (
                  <table className="list">
                    <thead><tr><th>Token</th><th>Label</th><th>Px</th><th>Shares</th><th>Cost</th></tr></thead>
                    <tbody>
                      {arb.basket.map((b: any, i: number) => (
                        <tr key={i}>
                          <td className="font-mono text-[10px]">{b.tokenId?.slice(0, 14)}…</td>
                          <td>{b.label}</td>
                          <td className="tabular-nums">{Number(b.price).toFixed(3)}</td>
                          <td className="tabular-nums">{b.sharesToBuy}</td>
                          <td className="tabular-nums">${(b.price * b.sharesToBuy).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Cell({ label, value, accent }: { label: string; value: string; accent?: "green" }) {
  return (
    <div className="border border-ink-700 rounded p-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`text-sm tabular-nums ${accent === "green" ? "text-accent-green" : "text-zinc-200"}`}>{value}</div>
    </div>
  );
}
