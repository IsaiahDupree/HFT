/**
 * build-cascade-klines-passport — read the 5-year 1m zip archive on the passport
 * and build data/cascade-klines/{SYMBOL}.json for every target symbol.
 *
 * The existing _fetch-cascade-klines.ts only fetches the most recent 21 days from
 * the live Binance API. This script replaces that short window with the full 5-year
 * corpus already sitting on disk at:
 *   /Volumes/My Passport/hft-data/binance/spot/klines/{SYMBOL}/1m/{SYMBOL}-1m-{YYYY-MM}.zip
 *
 * Output format (matches what _intraday-liquidation-cascade-reversal.ts expects):
 *   { t: number (ms), o, h, l, c, v: number }[]
 *
 *   npx tsx scripts/build-cascade-klines-passport.ts
 *   npx tsx scripts/build-cascade-klines-passport.ts -- --symbols BTCUSDT,ETHUSDT
 *   npx tsx scripts/build-cascade-klines-passport.ts -- --passport "/Volumes/My Passport/hft-data"
 *
 * After this runs, re-run the backtest:
 *   npx tsx scripts/_intraday-liquidation-cascade-reversal.ts
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const arg = (n: string, def = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};

const PASSPORT = arg("--passport", "/Volumes/My Passport/hft-data");
const KLINES_ROOT = join(PASSPORT, "binance", "spot", "klines");
const OUT_DIR = "data/cascade-klines";

const DEFAULT_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT",
  "AVAXUSDT", "LINKUSDT", "BNBUSDT", "ADAUSDT",
];
const symArg = arg("--symbols");
const SYMBOLS = symArg ? symArg.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_SYMBOLS;

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function parseZip(zipPath: string): Bar[] {
  const csv = execSync(`unzip -p ${JSON.stringify(zipPath)}`, {
    maxBuffer: 256 * 1024 * 1024,
  }).toString();
  const bars: Bar[] = [];
  for (const line of csv.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    const t = Number(cols[0]);
    if (!Number.isFinite(t) || t < 1_000_000_000_000) continue; // skip header rows
    // Binance bulk archive uses ms; some 2026 files use µs — normalize to ms.
    const tMs = t > 1e15 ? Math.floor(t / 1000) : t;
    bars.push({
      t: tMs,
      o: Number(cols[1]),
      h: Number(cols[2]),
      l: Number(cols[3]),
      c: Number(cols[4]),
      v: Number(cols[5]),
    });
  }
  return bars;
}

function dedupSort(bars: Bar[]): Bar[] {
  const seen = new Set<number>();
  return bars
    .filter((b) => (seen.has(b.t) ? false : (seen.add(b.t), true)))
    .sort((a, b) => a.t - b.t);
}

if (!existsSync(KLINES_ROOT)) {
  console.error(`passport klines not found: ${KLINES_ROOT}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
console.log(`Building 5-year cascade klines from passport archive → ${OUT_DIR}`);
console.log(`Symbols: ${SYMBOLS.join(", ")}\n`);

for (const sym of SYMBOLS) {
  const ivDir = join(KLINES_ROOT, sym, "1m");
  if (!existsSync(ivDir)) {
    console.log(`  ${sym}: no 1m data at ${ivDir} — skipping`);
    continue;
  }

  const zips = readdirSync(ivDir)
    .filter((f) => f.endsWith(".zip"))
    .sort();

  if (zips.length === 0) {
    console.log(`  ${sym}: no zip files found — skipping`);
    continue;
  }

  const t0 = Date.now();
  process.stdout.write(`  ${sym}: loading ${zips.length} monthly zips ...`);

  let allBars: Bar[] = [];
  for (const z of zips) {
    const bars = parseZip(join(ivDir, z));
    allBars = allBars.concat(bars);
  }
  allBars = dedupSort(allBars);

  const outPath = join(OUT_DIR, `${sym}.json`);
  writeFileSync(outPath, JSON.stringify(allBars));

  const spanDays = allBars.length
    ? (allBars[allBars.length - 1]!.t - allBars[0]!.t) / 86_400_000
    : 0;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    ` ${allBars.length.toLocaleString()} bars | ${spanDays.toFixed(1)}d | ${elapsed}s → ${outPath}`,
  );
}

console.log(
  `\nDone. Re-run the cascade backtest:\n  npx tsx scripts/_intraday-liquidation-cascade-reversal.ts`,
);
