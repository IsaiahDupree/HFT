import Link from "next/link";
import { notFound } from "next/navigation";
import { defaultAavePolygonClient, getAaveAccountData } from "@/lib/onchain/aave";
import { computeLeverageAdvice } from "@/lib/onchain/aave-advisor";

export const dynamic = "force-dynamic";

function fmtUsd(n: number): string {
  return `$${Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function actionColor(action: string): string {
  switch (action) {
    case "repay_urgent":
      return "text-accent-red";
    case "repay_some":
      return "text-accent-amber";
    case "borrow_more":
      return "text-accent-green";
    default:
      return "text-zinc-300";
  }
}

export default async function LeverageAdvisorPage({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) notFound();

  let data: Awaited<ReturnType<typeof getAaveAccountData>> | null = null;
  let advice: ReturnType<typeof computeLeverageAdvice> | null = null;
  let error: string | null = null;
  try {
    const client = defaultAavePolygonClient();
    data = await getAaveAccountData(client, address as `0x${string}`);
    advice = computeLeverageAdvice(data);
  } catch (err) {
    error = (err as Error).message;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/onchain/aave" className="text-xs text-zinc-500 hover:text-zinc-300">
          ← Aave liquidation risk
        </Link>
        <h1 className="text-2xl font-semibold mt-1">Aave leverage advisor</h1>
        <div className="font-mono text-xs text-zinc-500 mt-1">{address}</div>
        <p className="text-xs text-zinc-500 mt-2">
          Read-only. This computes what you could safely do with <em>your own</em> Aave position.
          Execute changes through your own wallet (Aave UI / Safe / 1Inch); this app never holds keys
          or signs Aave transactions.
        </p>
      </div>

      {error && (
        <section className="card border-accent-red/30">
          <p className="text-sm text-accent-red">RPC error: {error}</p>
          <p className="text-xs text-zinc-500 mt-2">
            Set <code>POLYGON_HTTP_URL</code> in .env.local for a reliable RPC.
          </p>
        </section>
      )}

      {data && advice && (
        <>
          <section className="card">
            <h2 className="card-title mb-3">Current position</h2>
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-zinc-500 text-xs">Collateral</div>
                <div className="text-lg tabular-nums">{fmtUsd(data.totalCollateralUsd)}</div>
              </div>
              <div>
                <div className="text-zinc-500 text-xs">Debt</div>
                <div className="text-lg tabular-nums">{fmtUsd(data.totalDebtUsd)}</div>
              </div>
              <div>
                <div className="text-zinc-500 text-xs">Health Factor</div>
                <div className={`text-lg tabular-nums ${data.healthFactor < 1.5 ? "text-accent-amber" : "text-accent-green"}`}>
                  {Number.isFinite(data.healthFactor) ? data.healthFactor.toFixed(2) : "∞"}
                </div>
              </div>
              <div>
                <div className="text-zinc-500 text-xs">Tier</div>
                <div className="text-lg">{data.riskTier.replace("_", " ")}</div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-4 text-xs text-zinc-500">
              <div>
                LTV: <span className="text-zinc-300 tabular-nums">{(data.ltvBps / 100).toFixed(2)}%</span>
              </div>
              <div>
                Liquidation threshold:{" "}
                <span className="text-zinc-300 tabular-nums">
                  {(data.currentLiquidationThresholdBps / 100).toFixed(2)}%
                </span>
              </div>
              <div>
                Available to borrow:{" "}
                <span className="text-zinc-300 tabular-nums">{fmtUsd(data.availableBorrowsUsd)}</span>
              </div>
            </div>
          </section>

          <section className="card">
            <h2 className="card-title mb-3">
              Recommendation @ target HF = {advice.target.healthFactor}
            </h2>
            <div className={`text-xl mb-2 ${actionColor(advice.recommendation.action)}`}>
              {advice.recommendation.action.replace(/_/g, " ").toUpperCase()} —{" "}
              {fmtUsd(advice.recommendation.amountUsd)}
            </div>
            <p className="text-xs text-zinc-400">{advice.recommendation.reason}</p>
            <div className="mt-3 text-xs text-zinc-500">
              max debt at target: <span className="text-zinc-300 tabular-nums">{fmtUsd(advice.target.maxDebtUsd)}</span>
              {" · "}headroom: <span className="text-zinc-300 tabular-nums">{fmtUsd(advice.target.remainingHeadroomUsd)}</span>
            </div>
          </section>

          <section className="card border-accent-amber/30">
            <h2 className="card-title text-accent-amber mb-2">Caveats</h2>
            <ul className="text-xs text-zinc-300 list-disc pl-5 space-y-1">
              {advice.caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
