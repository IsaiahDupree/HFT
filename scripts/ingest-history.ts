/**
 * ingest-history — pull DEEP daily OHLC history for the major coins, since their
 * Coinbase origination, into coinbase_candles (granularity ONE_DAY). Keyless
 * public Coinbase Exchange candles, paginated 300 days/request. Idempotent
 * (UNIQUE(product_id,granularity,start_unix) → INSERT OR IGNORE) and resumable.
 *
 *   npx tsx scripts/ingest-history.ts [--from 2014-01-01] [--coins BTC-USD,ETH-USD]
 *                                     [--granularity ONE_DAY|SIX_HOUR|ONE_HOUR]
 *
 * Gives years of real candles for backtest-history.ts to evaluate strategies on.
 * Hourly (ONE_HOUR) gives finer entries for the position-sizing experiments.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";

const DEFAULT_COINS = [
  "BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "LTC-USD",
  "ADA-USD", "LINK-USD", "AVAX-USD", "BCH-USD", "DOT-USD", "MATIC-USD",
];
// Coinbase granularity (seconds) → our stored label.
const GRAN_MAP: Record<string, number> = { ONE_HOUR: 3600, SIX_HOUR: 21600, ONE_DAY: 86400 };
const PER_REQ = 300; // Coinbase max candles/request (any granularity)
const API = "https://api.exchange.coinbase.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const GRAN_LABEL = (arg("--granularity") ?? "ONE_DAY").toUpperCase();
const GRAN_SECONDS = GRAN_MAP[GRAN_LABEL];
if (!GRAN_SECONDS) { console.error(`unknown --granularity ${GRAN_LABEL}; use one of ${Object.keys(GRAN_MAP).join("|")}`); process.exit(1); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Coinbase candle row: [time, low, high, open, close, volume]
type Row = [number, number, number, number, number, number];

async function fetchWindow(product: string, startIso: string, endIso: string): Promise<Row[]> {
  const url = `${API}/products/${product}/candles?granularity=${GRAN_SECONDS}&start=${startIso}&end=${endIso}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "hft/ingest" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? (j as Row[]) : [];
  } catch { return []; }
}

(async () => {
  const fromIso = (arg("--from") ?? "2014-01-01") + "T00:00:00Z";
  const coins = (arg("--coins")?.split(",").map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_COINS;
  const now = Math.floor(Date.now() / 1000);
  const start0 = Math.floor(new Date(fromIso).getTime() / 1000);

  const insert = db().prepare(
    `INSERT OR IGNORE INTO coinbase_candles (product_id, granularity, start_unix, open, high, low, close, volume)
     VALUES (@p, @g, @t, @o, @h, @l, @c, @v)`,
  );
  const insertMany = db().transaction((p: string, rows: Row[]) => {
    let n = 0;
    for (const r of rows) {
      const res = insert.run({ p, g: GRAN_LABEL, t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] });
      n += res.changes;
    }
    return n;
  });

  console.log(`ingest-history: ${coins.length} coins, ${GRAN_LABEL}, from ${fromIso.slice(0, 10)} → now\n`);
  for (const product of coins) {
    let inserted = 0;
    let fetched = 0;
    for (let s = start0; s < now; s += PER_REQ * GRAN_SECONDS) {
      const e = Math.min(now, s + PER_REQ * GRAN_SECONDS);
      const rows = await fetchWindow(product, new Date(s * 1000).toISOString(), new Date(e * 1000).toISOString());
      fetched += rows.length;
      if (rows.length) inserted += insertMany(product, rows);
      await sleep(140); // be gentle with the public endpoint
    }
    const range = db().prepare(
      `SELECT COUNT(*) n, MIN(start_unix) mn, MAX(start_unix) mx FROM coinbase_candles WHERE product_id=? AND granularity=?`,
    ).get(product, GRAN_LABEL) as { n: number; mn: number | null; mx: number | null };
    const fmt = (u: number | null) => (u ? new Date(u * 1000).toISOString().slice(0, 19).replace("T", " ") : "—");
    console.log(`  ${product.padEnd(10)} +${String(inserted).padStart(6)} new · total ${String(range.n).padStart(6)} ${GRAN_LABEL} candles · ${fmt(range.mn)} → ${fmt(range.mx)}`);
  }
  console.log(`\nDone. Backtest with: npm run backtest:history`);
})();
