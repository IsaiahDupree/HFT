/**
 * leadlag-campaign — G1 of the Polymarket maker plan (POLYMARKET-STACK-AUDIT §5),
 * automated. One measurement is an anecdote; G1 wants a WEEK of counts of the
 * exploitable triple: (big CEX move) × (high-delta market near expiry) × (stale
 * quote wider than spread+fees).
 *
 * Each run:
 *   1. discovers the CURRENT livest near-expiry BTC/ETH binaries via Gamma
 *      (events ending soon, NTM mid, real 24h volume — the high-delta pool),
 *   2. runs scripts/binance-poly-leadlag.ts against each (child process),
 *   3. parses the printed metrics and appends one JSONL row per market to
 *      leadlag-campaign.jsonl (passport when mounted, else data/).
 *
 *   npx tsx scripts/leadlag-campaign.ts -- --seconds 300 --move-bps 20
 *   npx tsx scripts/leadlag-campaign.ts -- --discover-only   # list picks, no capture
 *
 * Scheduled hourly by ~/Library/LaunchAgents/com.isaiahdupree.hft.leadlag.plist
 * (minute :48 — hourly Up/Down markets are in their high-delta final stretch).
 * Read-only: public Gamma/CLOB/Binance data, no keys, no orders.
 */
import "./_env.ts";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { poly } from "../src/lib/polymarket/client.ts";

const flag = (n: string, d = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const has = (n: string): boolean => process.argv.includes(n);
const SECONDS = Number(flag("--seconds", "300"));
const MOVE_BPS = Number(flag("--move-bps", "20"));
const MAX_MARKETS = Number(flag("--max-markets", "2"));
const HORIZON_H = Number(flag("--horizon-hours", "36"));
const MIN_VOL24 = Number(flag("--min-vol24", "5000"));
const DISCOVER_ONLY = has("--discover-only");

const OUT_PATH =
  process.env.LEADLAG_CAMPAIGN_PATH ??
  (existsSync("/Volumes/My Passport")
    ? "/Volumes/My Passport/hft-data/leadlag-campaign.jsonl"
    : resolve(process.cwd(), "data", "leadlag-campaign.jsonl"));

type Pick_ = {
  question: string;
  symbol: "BTC" | "ETH";
  tokenId: string;
  endDateIso: string;
  tauMinutes: number;
  mid: number;
  volume24hr: number;
};

/** NTM + near-expiry + liquid = the high-delta pool G1 cares about. */
function isNtm(mid: number): boolean {
  return mid >= 0.12 && mid <= 0.88;
}

function symbolOf(q: string): "BTC" | "ETH" | null {
  if (/\b(bitcoin|btc)\b/i.test(q)) return "BTC";
  if (/\b(ethereum|eth)\b/i.test(q)) return "ETH";
  return null;
}

/** Crypto binaries only: Up/Down candles and above/below-$K strikes. */
function isCryptoBinary(q: string): boolean {
  return /up or down|above|below|higher|dip to|reach \$|\$[\d,]+/i.test(q);
}

async function discover(): Promise<Pick_[]> {
  const now = Date.now();
  const events = await poly.events({
    limit: 200,
    closed: false,
    end_date_min: new Date(now).toISOString(),
    end_date_max: new Date(now + HORIZON_H * 3_600_000).toISOString(),
    order: "endDate",
    ascending: true,
  });

  const picks: Pick_[] = [];
  for (const ev of events ?? []) {
    for (const m of ev?.markets ?? []) {
      const q: string = m?.question ?? ev?.title ?? "";
      const sym = symbolOf(q);
      if (!sym || !isCryptoBinary(q)) continue;
      // One-touch/"reach" markets need barrier math the pricer doesn't model —
      // exclude them from the campaign the same way the maker excludes them.
      if (/reach|dip to|touch/i.test(q)) continue;
      if (m?.closed === true || m?.active === false) continue;

      let tokenId = "";
      try {
        const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        tokenId = Array.isArray(ids) && ids[0] ? String(ids[0]) : "";
      } catch { /* skip */ }
      if (!tokenId) continue;

      let mid = NaN;
      try {
        const prices = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        mid = Number(Array.isArray(prices) ? prices[0] : NaN);
      } catch { /* skip */ }
      if (!Number.isFinite(mid) && Number.isFinite(Number(m?.bestBid)) && Number.isFinite(Number(m?.bestAsk))) {
        mid = (Number(m.bestBid) + Number(m.bestAsk)) / 2;
      }
      if (!Number.isFinite(mid) || !isNtm(mid)) continue;

      const vol24 = Number(m?.volume24hr ?? ev?.volume24hr ?? 0);
      if (!(vol24 >= MIN_VOL24)) continue;

      const endMs = Date.parse(m?.endDate ?? ev?.endDate ?? "");
      if (!Number.isFinite(endMs) || endMs <= now) continue;
      const tauMinutes = (endMs - now) / 60_000;
      // need the market to outlive the capture window
      if (tauMinutes * 60 < SECONDS + 60) continue;

      picks.push({
        question: q, symbol: sym, tokenId,
        endDateIso: new Date(endMs).toISOString(),
        tauMinutes: +tauMinutes.toFixed(1), mid: +mid.toFixed(3), volume24hr: Math.round(vol24),
      });
    }
  }

  // soonest expiry first (highest delta); prefer one BTC + one ETH
  picks.sort((a, b) => a.tauMinutes - b.tauMinutes);
  const out: Pick_[] = [];
  for (const p of picks) {
    if (out.length >= MAX_MARKETS) break;
    if (out.some((o) => o.symbol === p.symbol)) continue;
    out.push(p);
  }
  // if only one symbol trades binaries right now, fill remaining slots anyway
  for (const p of picks) {
    if (out.length >= MAX_MARKETS) break;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

type Parsed = {
  binanceTrades: number | null;
  polyMidUpdates: number | null;
  bestLagSec: number | null;
  bestCorr: number | null;
  events: number | null;
  responded: number | null;
  medianResponseSec: number | null;
  staleNoReprice: number | null;
};

function parseOutput(out: string): Parsed {
  const num = (re: RegExp, idx = 1): number | null => {
    const m = out.match(re);
    return m && m[idx] !== undefined ? Number(m[idx]) : null;
  };
  return {
    binanceTrades: num(/captured: binance (\d+) trades/),
    polyMidUpdates: num(/polymarket (\d+) mid updates/),
    bestLagSec: num(/best lag: (-?[\d.]+)s/),
    bestCorr: num(/corr (-?[\d.]+)/),
    events: num(/event study: (\d+) Binance moves/),
    responded: num(/responded within 30s: (\d+)/),
    medianResponseSec: num(/median response ([\d.]+)s/),
    staleNoReprice: num(/NO ≥1¢ reprice within 30s: (\d+)\//),
  };
}

const picks = await discover();
console.log(`leadlag-campaign — ${picks.length} market(s) picked (NTM, vol24h ≥ $${MIN_VOL24}, ending ≤ ${HORIZON_H}h)`);
for (const p of picks) {
  console.log(`  ${p.symbol} τ ${p.tauMinutes}min mid ${(p.mid * 100).toFixed(0)}¢ vol24 $${p.volume24hr} — ${p.question}`);
}
if (!picks.length) {
  appendFileSync(ensureDir(OUT_PATH), JSON.stringify({ ts: Date.now(), iso: new Date().toISOString(), note: "no eligible market" }) + "\n");
  process.exit(0);
}
if (DISCOVER_ONLY) process.exit(0);

function ensureDir(p: string): string {
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

for (const p of picks) {
  console.log(`\n── measuring ${p.symbol} (${SECONDS}s, ≥${MOVE_BPS}bps) ──`);
  const r = spawnSync(
    "npx",
    ["tsx", "scripts/binance-poly-leadlag.ts", "--token", p.tokenId, "--symbol", p.symbol,
      "--seconds", String(SECONDS), "--move-bps", String(MOVE_BPS)],
    { cwd: process.cwd(), encoding: "utf8", timeout: (SECONDS + 120) * 1000 },
  );
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  console.log(out.trim().split("\n").slice(-8).join("\n"));
  const row = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    ...p,
    captureSeconds: SECONDS,
    moveBps: MOVE_BPS,
    ...parseOutput(out),
    exit: r.status,
  };
  appendFileSync(ensureDir(OUT_PATH), JSON.stringify(row) + "\n");
}
console.log(`\nappended ${picks.length} row(s) → ${OUT_PATH}`);
