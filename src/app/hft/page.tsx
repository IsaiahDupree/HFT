import Link from "next/link";
import { VENUES } from "@/lib/hft/venues";
import { HftCalculator } from "@/components/HftCalculator";
import { PolyBtcMatrix } from "@/components/PolyBtcMatrix";
import { StrategyRanker } from "@/components/StrategyRanker";

export const dynamic = "force-static";

export const metadata = {
  title: "HFT comparison — crypto venues vs Polymarket BTC",
  description:
    "Side-by-side: HFT-style crypto execution venues (Coinbase, Hyperliquid, Paradex, dYdX, Solana CLOBs) vs Polymarket BTC Up/Down binary strategies.",
};

export default function HftPage() {
  return (
    <div className="space-y-10">
      <header>
        <div className="text-xs uppercase tracking-wider text-accent-blue">HFT comparison</div>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">
          Crypto execution venues <span className="text-zinc-500">vs</span> Polymarket BTC binaries
        </h1>
        <p className="text-zinc-400 mt-2 max-w-3xl">
          Apply one formula across every venue:{" "}
          <code className="text-zinc-200">expected_edge_bps {">"} fees + spread + slippage + latency + adverse_selection</code>.
          Then rank — across CEX HFT lanes, gasless perp CLOBs, and Polymarket BTC Up/Down — by net expected PnL.
        </p>
      </header>

      <section className="grid grid-cols-12 gap-6">
        <EdgeFormulaCard />
        <DecisionRulesCard />
      </section>

      <section>
        <SectionHeader
          eyebrow="Venue matrix"
          title="Where can HFT-style execution actually exist?"
          subtitle="Fees, gas posture, latency, and HFT suitability for the venues we benchmark."
        />
        <VenueMatrix />
      </section>

      <section>
        <SectionHeader
          eyebrow="Calculator"
          title="Net edge after costs — interactive"
          subtitle="Set notional, expected edge, latency, and fill rate; the ranker re-orders venues in real time."
        />
        <HftCalculator />
      </section>

      <section>
        <SectionHeader
          eyebrow="Strategy ranker"
          title="Curated HFT strategies vs Polymarket BTC binaries"
          subtitle="A canonical strategy per venue, plus the four BTC Up/Down playbooks from the research notes, ranked head-to-head."
        />
        <StrategyRanker />
      </section>

      <section>
        <SectionHeader
          eyebrow="Polymarket BTC matrix"
          title="BTC Up/Down — strategy economics"
          subtitle="Polymarket maker is 0 bps + 20 bps rebate; taker is 100 bps. Adjust notional, fills/day, and your edge confidence."
        />
        <PolyBtcMatrix />
      </section>

      <section className="card">
        <SectionHeader
          eyebrow="Honest ranking"
          title="What we'd actually build first"
          subtitle="From the research notes — opinionated, US-compliant, and biased toward maker-first economics."
        />
        <ol className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <RankCard
            rank={1}
            title="Polymarket — BTC binary maker"
            why="0% maker fee + 20% rebate. Best operator-friendly economics if your fair-prob model has any signal. Already integrated end-to-end in this codebase."
            href="/binaries"
          />
          <RankCard
            rank={2}
            title="Coinbase Advanced — ETH/USDC maker"
            why="Already wired here via the CDP key. Off-chain matching means no gas; the limitation is REST latency, so it suits maker-first, not lead-lag."
            href="/coinbase"
          />
          <RankCard
            rank={3}
            title="Hyperliquid — BTC/ETH perp maker"
            why="Crypto-native CLOB with no gas drag. Best fit for serious quoting / inventory rotation. Needs a separate Hyperliquid adapter (not yet wired)."
          />
          <RankCard
            rank={4}
            title="Paradex Pro — 0% maker perp"
            why="Strong API design for maker-only flow. Worth a small pilot once Hyperliquid is humming."
          />
        </ol>
        <p className="text-[10px] text-zinc-500 mt-4 leading-snug">
          Excluded by jurisdiction: dYdX perpetuals (US-restricted; do not route around the geofence). Excluded by economics at the current
          fee tier: Coinbase Advanced taker, Polymarket news-taker on routine moves.
        </p>
      </section>
    </div>
  );
}

function SectionHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div className="mb-4">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{eyebrow}</div>
      <h2 className="text-lg font-semibold tracking-tight text-zinc-100 mt-1">{title}</h2>
      {subtitle && <p className="text-xs text-zinc-500 mt-1 max-w-3xl">{subtitle}</p>}
    </div>
  );
}

function EdgeFormulaCard() {
  return (
    <div className="col-span-12 md:col-span-7 card">
      <h3 className="card-title">The edge formula</h3>
      <p className="text-xs text-zinc-400 leading-relaxed">
        Every fill must clear all-in cost. Maker and taker have different cost surfaces — maker fights adverse selection, taker pays the
        spread plus fee.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 text-[11px] tabular-nums">
        <CodeRow label="taker" code="edge_bps > fee_bps + spread_bps + slippage_bps + latency_bps" />
        <CodeRow label="maker" code="edge_bps > fee_bps − rebate_bps + adverse_sel_bps" />
      </div>
      <p className="text-[10px] text-zinc-500 mt-3 leading-snug">
        The maker branch ignores spread because you earn it; the cost is the chance you got filled only because the price moved against you.
      </p>
    </div>
  );
}

function DecisionRulesCard() {
  return (
    <div className="col-span-12 md:col-span-5 card">
      <h3 className="card-title">Decision rules</h3>
      <ul className="text-xs text-zinc-300 space-y-2">
        <li>· Maker-first by default. Cross the spread only on clearly-stale book.</li>
        <li>· Stop trading on stale data, rejected orders, or abnormal spread.</li>
        <li>· Cap daily loss; halt every venue once tripped.</li>
        <li>· Backtest with real order-book snapshots, not 1m candles.</li>
        <li>· Never route around a venue's jurisdiction terms.</li>
      </ul>
    </div>
  );
}

function CodeRow({ label, code }: { label: string; code: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="pill-blue uppercase">{label}</span>
      <code className="text-zinc-200">{code}</code>
    </div>
  );
}

function VenueMatrix() {
  return (
    <div className="card overflow-x-auto">
      <table className="list min-w-[1100px]">
        <thead>
          <tr>
            <th>Venue</th>
            <th>Chain</th>
            <th>Gas</th>
            <th>HFT lane</th>
            <th className="text-right">Maker (bps)</th>
            <th className="text-right">Taker (bps)</th>
            <th className="text-right">Maker rebate</th>
            <th className="text-right">p50 latency</th>
            <th>US compliant</th>
            <th>APIs</th>
          </tr>
        </thead>
        <tbody>
          {VENUES.map((v) => (
            <tr key={v.id}>
              <td>
                <div className="text-zinc-100">{v.name}</div>
                <div className="text-[10px] text-zinc-500 leading-snug max-w-xs">{v.notes}</div>
              </td>
              <td className="text-zinc-300">{v.chain}</td>
              <td>
                <span className={v.gas === "none" ? "pill-green" : v.gas === "relayer" ? "pill-blue" : "pill-amber"}>{v.gas}</span>
              </td>
              <td>
                <span className={v.hftSuitability >= 4 ? "pill-green" : v.hftSuitability >= 3 ? "pill-amber" : "pill-red"}>
                  {"★".repeat(v.hftSuitability)}
                </span>
              </td>
              <td className="text-right tabular-nums text-zinc-300">{v.makerBps.toFixed(1)}</td>
              <td className="text-right tabular-nums text-zinc-300">{v.takerBps.toFixed(1)}</td>
              <td className={`text-right tabular-nums ${v.makerRebateBps < 0 ? "text-accent-green" : "text-zinc-500"}`}>
                {v.makerRebateBps < 0 ? `−${Math.abs(v.makerRebateBps).toFixed(2)}` : "—"}
              </td>
              <td className="text-right tabular-nums text-zinc-400">{v.latencyMsP50} ms</td>
              <td>
                <span
                  className={
                    v.compliantUS === "yes"
                      ? "pill-green"
                      : v.compliantUS === "partial"
                      ? "pill-amber"
                      : "pill-red"
                  }
                >
                  {v.compliantUS}
                </span>
              </td>
              <td className="text-[10px] text-zinc-400">{v.apis.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-zinc-500 mt-3 leading-snug">
        Fee numbers reflect typical retail-tier conditions and the research notes; live bots should re-pull the venue's current fee schedule before sizing up.
        For each venue, hover the row in the calculator below to see strategy candidates and risks.
      </p>
    </div>
  );
}

function RankCard({ rank, title, why, href }: { rank: number; title: string; why: string; href?: string }) {
  const inner = (
    <div className="border border-ink-700 rounded p-4 hover:border-accent-blue/60 transition-colors h-full">
      <div className="flex items-baseline gap-2">
        <span className="pill-blue">#{rank}</span>
        <span className="text-zinc-100 text-sm font-semibold">{title}</span>
      </div>
      <p className="text-xs text-zinc-400 mt-2 leading-relaxed">{why}</p>
      {href && <div className="text-[10px] text-accent-blue mt-3">→ open page</div>}
    </div>
  );
  return href ? (
    <li>
      <Link href={href} className="block">{inner}</Link>
    </li>
  ) : (
    <li>{inner}</li>
  );
}
