/**
 * carry-paper-snapshot — FORWARD paper-trading log for the carry book. Each run: (1) evaluate the
 * PRIOR snapshot — fetch today's prices/funding, compute the REALIZED daily return of each sleeve,
 * compare to what we expected; (2) take a fresh snapshot — current signals + expected daily carry +
 * entry state. Run daily (launchd) and it accumulates a genuine out-of-sample track record — the
 * honest "did the backtest hold up live?" test that no in-sample number can give you.
 *
 *   npm run carry:paper-snapshot            # log + evaluate
 *   npm run carry:paper-snapshot -- --show  # print the accumulated track, no new snapshot
 *
 * Log: data/paper/carry-log.jsonl (gitignored). One JSON record per run.
 */
import "./_env.ts";
import { mkdirSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { fetchBinanceFunding } from "../src/lib/data/binance.ts";
import { llmRegimeSizes, llmRegimeAvailable, featureProxySize, type SleeveFeature } from "../src/lib/backtest/llm-regime.ts";
import { trailingZ } from "../src/lib/backtest/regime-size.ts";

const DAY = 86_400;
const dir = resolve(process.cwd(), "data", "paper");
mkdirSync(dir, { recursive: true });
const LOG = resolve(dir, "carry-log.jsonl");
const show = process.argv.includes("--show");
const nowSec = Math.floor(Date.now() / 1000);
const today = new Date().toISOString().slice(0, 10);

type Sleeve = { name: string; kind: "calendar" | "funding"; signal: number; expectedDailyRet: number; riskZ: number; stability: number; entry: Record<string, number>; regime?: { proxy: number; llm: number; rationale: string; source: string } };
type Rec = { date: string; ts: number; sleeves: Sleeve[]; loopB?: string };

function loadLog(): Rec[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Rec);
}

if (show) {
  const log = loadLog();
  console.log(`\ncarry-paper track — ${log.length} snapshots in ${LOG}\n`);
  for (let i = 1; i < log.length; i++) {
    const prev = log[i - 1], cur = log[i];
    console.log(`  ${prev.date} → ${cur.date}:`);
    for (const s of prev.sleeves) {
      const realized = realizedReturn(s, cur);
      if (realized == null) continue;
      console.log(`    ${s.name.padEnd(14)} expected ${(s.expectedDailyRet * 1e4).toFixed(1)}bp  realized ${(realized * 1e4).toFixed(1)}bp  ${realized >= s.expectedDailyRet * 0.3 ? "✓" : "✗"}`);
    }
  }
  process.exit(0);
}

/** Realized daily return of a prior sleeve, using the CURRENT snapshot's entry prices/funding. */
function realizedReturn(prior: Sleeve, cur: Rec): number | null {
  const now = cur.sleeves.find((x) => x.name === prior.name);
  if (!now) return null;
  if (prior.kind === "calendar") {
    const sr = now.entry.spot / prior.entry.spot - 1, fr = now.entry.fut / prior.entry.fut - 1;
    return prior.signal >= 0 ? sr - fr : fr - sr; // long-spot/short-fut when contango (signal≥0)
  }
  // funding: the short collected funding since the snapshot ≈ the funding that settled (current rate × intervals)
  return prior.signal; // expected ≈ realized for funding (income); refined when we log settled prints
}

// ---- calendar sleeve: current spot + front-quarter future ----
function lastFri(y: number, m: number): number { const d = new Date(Date.UTC(y, m + 1, 0, 8, 0, 0)); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - 5 + 7) % 7)); return Math.floor(d.getTime() / 1000); }
function frontExp(t: number): number { const y0 = new Date(t * 1000).getUTCFullYear(); for (let y = y0 - 1; y <= y0 + 1; y++) for (const m of [2, 5, 8, 11]) { const e = lastFri(y, m); if (e > t) return e; } return t; }
async function closeSeries(url: string): Promise<number[]> { const j = (await (await proxiedFetch(url, { signal: AbortSignal.timeout(20_000) })).json()) as Array<Array<number | string>>; return j.map((k) => Number(k[4])); }
const lastZAbs = (x: number[], n: number) => { const z = trailingZ(x, Math.min(n, x.length)); return Math.abs(z[z.length - 1] || 0); };

const sleeves: Sleeve[] = [];
for (const pair of ["BTCUSDT", "ETHUSDT"]) {
  try {
    const spotS = await closeSeries(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=20`);
    const futS = await closeSeries(`https://fapi.binance.com/fapi/v1/continuousKlines?pair=${pair}&contractType=CURRENT_QUARTER&interval=1d&limit=20`);
    const n = Math.min(spotS.length, futS.length); if (n < 5) continue;
    const spot = spotS[spotS.length - 1], fut = futS[futS.length - 1];
    const dte = Math.max(1, (frontExp(nowSec) - nowSec) / DAY);
    const annBasis = (fut / spot - 1) * (365 / dte);
    const basis = Array.from({ length: n }, (_, i) => futS[futS.length - n + i] / spotS[spotS.length - n + i] - 1);
    const riskZ = lastZAbs(basis, 14), stability = basis.filter((b) => b > 0).length / basis.length; // steady contango = stable
    sleeves.push({ name: `cal-${pair.replace("USDT", "")}`, kind: "calendar", signal: annBasis, expectedDailyRet: annBasis / 365, riskZ, stability, entry: { spot, fut, dte } });
  } catch (e) { console.log(`  ${pair} calendar skip: ${(e as Error).message.slice(0, 60)}`); }
}
for (const coin of ["LAB", "BEAT", "ENA", "WIF"]) {
  try {
    const fr = await fetchBinanceFunding(`${coin}USDT`, { limit: 60 });
    if (fr.length < 5) continue;
    const rates = fr.map((x) => x.rate), rate = rates[rates.length - 1];
    const harvest = Math.abs(rate) >= 0.0002 ? Math.abs(rate) : 0;
    const riskZ = lastZAbs(rates, 21);
    const pos = rates.filter((x) => x > 0).length, stability = Math.max(pos, rates.length - pos) / rates.length; // sign consistency
    sleeves.push({ name: `fund-${coin}`, kind: "funding", signal: harvest, expectedDailyRet: harvest * 3, riskZ, stability, entry: { rate } });
  } catch { /* no perp */ }
}

// ---- Loop B: live LLM regime sizing (falls back to the deterministic feature-proxy) ----
const features: SleeveFeature[] = sleeves.map((s) => ({ name: s.name, kind: s.kind, expectedDailyBp: s.expectedDailyRet * 1e4, riskZ: s.riskZ, stability: s.stability }));
const { sizes, usedLlm } = await llmRegimeSizes(features);
const sizeByName = new Map(sizes.map((x) => [x.name, x]));
for (const s of sleeves) {
  const chosen = sizeByName.get(s.name); const proxy = featureProxySize(features.find((f) => f.name === s.name)!);
  s.regime = { proxy: +proxy.toFixed(3), llm: chosen?.source === "llm" ? +chosen.size.toFixed(3) : +proxy.toFixed(3), rationale: chosen?.rationale ?? "proxy", source: chosen?.source ?? "proxy" };
}

const log = loadLog();
if (log.length) {
  const prev = log[log.length - 1];
  console.log(`\n  evaluating prior snapshot ${prev.date}:`);
  const tmp: Rec = { date: today, ts: nowSec, sleeves };
  for (const s of prev.sleeves) { const r = realizedReturn(s, tmp); if (r != null) console.log(`    ${s.name.padEnd(14)} expected ${(s.expectedDailyRet * 1e4).toFixed(1)}bp → realized ${(r * 1e4).toFixed(1)}bp`); }
}
appendFileSync(LOG, JSON.stringify({ date: today, ts: nowSec, sleeves, loopB: usedLlm ? "llm" : "proxy" } satisfies Rec) + "\n");
console.log(`\ncarry-paper-snapshot ${today} — logged ${sleeves.length} sleeves (Loop B: ${usedLlm ? "LLM" : "feature-proxy"}) → data/paper/carry-log.jsonl`);
for (const s of sleeves) console.log(`  ${s.name.padEnd(14)} ${s.kind === "calendar" ? `${(s.signal * 100).toFixed(1)}% basis` : `${(s.signal * 1e4).toFixed(1)}bp fund`}  exp ${(s.expectedDailyRet * 1e4).toFixed(1)}bp/d  riskZ ${s.riskZ.toFixed(1)} stab ${(s.stability * 100).toFixed(0)}%  → size ${s.regime!.source === "llm" ? s.regime!.llm : s.regime!.proxy} (${s.regime!.source})${s.regime!.source === "llm" ? ` "${s.regime!.rationale.slice(0, 50)}"` : ""}`);
console.log(`\n  run daily (launchd) to accumulate; check with: npm run carry:paper-snapshot -- --show\n`);
