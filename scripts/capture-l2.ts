/**
 * capture-l2 — capture REAL Polymarket L2 top-of-book for active markets into
 * JSONL MarketEvents (the handbook Data layer; keyless public CLOB /book). Run
 * repeatedly (cron/launchd) to build a time series — OFI/microprice need ≥2
 * book points per token. Replay with loadCaptureJsonl() into the L2 backtester.
 *
 *   npx tsx scripts/capture-l2.ts [--markets 8]
 *
 * Output: data/captures/<UTC-date>/<token_id>.jsonl  (gitignored).
 * Note: REST top-of-book → OFI/microprice; TRADE events (for VPIN) need the WS
 * market channel — the production upgrade (handbook §10.5).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { db } from "../src/lib/db/client.ts";
import { microprice } from "../src/lib/strategies/as-market-maker.ts";
import type { MarketEvent } from "../src/lib/backtest/l2/engine.ts";

const CLOB = "https://clob.polymarket.com";
function arg(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
type BookLevel = { price: string; size: string };

async function fetchBook(tokenId: string): Promise<{ bids: BookLevel[]; asks: BookLevel[] } | null> {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    return (await r.json()) as { bids: BookLevel[]; asks: BookLevel[] };
  } catch { return null; }
}

(async () => {
  const limit = arg("--markets", 8);
  const outDir = `data/captures/${new Date().toISOString().slice(0, 10)}`;
  // Candidate tokens: recent, non-5/15-min-binary (those resolve fast / empty books).
  const candidates = db().prepare(
    `SELECT DISTINCT token_id, question, category FROM market_snapshots
       WHERE category NOT IN ('5min-binary','15min-binary')
       ORDER BY id DESC LIMIT 60`,
  ).all() as Array<{ token_id: string; question: string; category: string }>;

  console.log(`capture-l2: scanning ${candidates.length} candidates for live books…\n`);
  let captured = 0;
  const ts = Math.floor(Date.now() / 1000);
  for (const c of candidates) {
    if (captured >= limit) break;
    const b = await fetchBook(c.token_id);
    if (!b?.bids?.length || !b?.asks?.length) continue;
    const bestBid = b.bids.reduce((m, x) => (Number(x.price) > Number(m.price) ? x : m));
    const bestAsk = b.asks.reduce((m, x) => (Number(x.price) < Number(m.price) ? x : m));
    const ev: MarketEvent = {
      ts, kind: "book",
      bidPx: Number(bestBid.price), bidSz: Number(bestBid.size),
      askPx: Number(bestAsk.price), askSz: Number(bestAsk.size),
    };
    if (ev.bidPx <= 0 || ev.askPx <= 0 || ev.bidPx >= ev.askPx) continue;
    mkdirSync(outDir, { recursive: true });
    appendFileSync(`${outDir}/${c.token_id}.jsonl`, JSON.stringify(ev) + "\n");
    const mp = microprice(ev.bidPx, ev.bidSz, ev.askPx, ev.askSz);
    console.log(`  ${(c.question || "").slice(0, 42).padEnd(42)} ${(c.category || "").padEnd(10)} bid=${ev.bidPx}×${ev.bidSz} ask=${ev.askPx}×${ev.askSz} mp=${mp.toFixed(3)} spr=${(ev.askPx - ev.bidPx).toFixed(3)}`);
    captured++;
  }
  console.log(`\ncaptured ${captured} live books → ${outDir}/. Run repeatedly to build the OFI time series.`);
})();
