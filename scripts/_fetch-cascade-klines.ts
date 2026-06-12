import "./_env.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { writeFileSync, mkdirSync } from "node:fs";

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };
const MIN_MS = 60_000, DAYS = 21, PAGE = 1000;
const SYMS = ["BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT"];

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<Bar[]> {
  const out: Bar[] = []; let cursor = startMs, guard = 0;
  while (cursor < endMs && guard < 400) {
    guard++;
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=${PAGE}&startTime=${cursor}&endTime=${endMs}`;
    let rows: any[] = [];
    try {
      const r = await proxiedFetch(url, { signal: AbortSignal.timeout(25_000) });
      if (!r.ok) { process.stdout.write(`  [${symbol}] HTTP ${r.status}\n`); break; }
      rows = (await r.json()) as any[];
    } catch (e) { process.stdout.write(`  [${symbol}] fetch err ${(e as Error).message}, retrying once\n`); 
      try { const r2 = await proxiedFetch(url, { signal: AbortSignal.timeout(25_000) }); rows = (await r2.json()) as any[]; } catch { break; } }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const k of rows) out.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
    const last = +rows[rows.length-1][0];
    if (last <= cursor) break;
    cursor = last + MIN_MS;
    if (rows.length < PAGE) break;
  }
  const seen = new Set<number>();
  return out.filter(b => seen.has(b.t) ? false : (seen.add(b.t), true)).sort((a,b)=>a.t-b.t);
}

const endMs = Date.now(), startMs = endMs - DAYS*86400_000;
mkdirSync("data/cascade-klines", { recursive: true });
process.stdout.write(`Fetching ${DAYS}d 1m klines, ${SYMS.length} coins\n`);
for (const sym of SYMS) {
  const t0 = Date.now();
  const bars = await fetchKlines(sym, startMs, endMs);
  const span = bars.length ? (bars[bars.length-1].t - bars[0].t)/86400_000 : 0;
  writeFileSync(`data/cascade-klines/${sym}.json`, JSON.stringify(bars));
  process.stdout.write(`  ${sym}: ${bars.length} bars span ${span.toFixed(2)}d in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
}
process.stdout.write("done\n");
