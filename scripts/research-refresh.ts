/**
 * research-refresh — deterministic, market-ADAPTIVE re-targeting for the loop.
 *
 * Re-derives the same edges the 6-agent research workflow found, but cheaply (no
 * LLM): reads the CURRENT DB, classifies the crypto regime from real candles,
 * counts tradeable non-coinflip event markets + favorites, then seeds a small,
 * bounded batch of TARGETED agents matched to right-now conditions:
 *   - chop  -> cb_mean_reversion ;  trend -> cb_breakout + cb_momentum_burst
 *   - always -> cross_venue_arb (BTC/ETH, structural)
 *   - if >=5 event markets -> llm_probability_oracle
 *   - if favorites present  -> category_specialist
 * Skips when the population is already large (lets arena:evolve cull first).
 *
 * Wired into scripts/arena-cron.sh (every RESEARCH_EVERY cycles). Run the full
 * LLM workflow occasionally for deeper, market-specific targeting.
 *
 *   npx tsx scripts/research-refresh.ts [--limit 12] [--max-pop 160]
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { clamp, getParamBounds, parseGenome, randomGenome, type Genome, type GenomeKind } from "../src/lib/arena/genome.ts";
import { getCurrentGeneration, insertPaperAgent, listAllAgentsForGen, setGenerationAgentCount, startGeneration } from "../src/lib/arena/db.ts";

const EVENT_CATEGORIES = ["elections", "geopolitics", "sports", "macro", "weather", "tech", "other"];

function num(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

function buildGenome(kind: GenomeKind, params: Record<string, number | string>): Genome | null {
  const base = randomGenome(() => 0.5, kind) as { kind: GenomeKind; params: Record<string, unknown> };
  const merged: Record<string, unknown> = { ...base.params };
  const bounds = getParamBounds(kind);
  for (const [k, v] of Object.entries(params)) {
    const b = bounds[k];
    if (b && Array.isArray(b) && typeof b[0] === "number") {
      const x = Number(v);
      if (Number.isFinite(x)) merged[k] = clamp(x, b[0] as number, b[1] as number);
    } else if (b && Array.isArray(b) && typeof b[0] === "string") {
      if ((b as string[]).includes(String(v))) merged[k] = String(v);
    } else merged[k] = v;
  }
  try { return parseGenome(JSON.stringify({ kind, params: merged })); } catch { return null; }
}

/** Efficiency ratio over the last N closes: |net move| / sum|bar moves|.
 *  ~0 = pure chop (mean-revert), ~1 = clean trend. */
function regimeFromCandles(product: string, n = 60): { eff: number; label: "chop" | "trend" | "mixed"; bars: number } {
  const rows = db().prepare(
    `SELECT close FROM coinbase_candles WHERE product_id = ? ORDER BY start_unix DESC LIMIT ?`,
  ).all(product, n) as Array<{ close: number }>;
  const closes = rows.map((r) => r.close).reverse();
  if (closes.length < 10) return { eff: 0.5, label: "mixed", bars: closes.length };
  const net = Math.abs(closes[closes.length - 1] - closes[0]);
  let path = 0;
  for (let i = 1; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
  const eff = path > 0 ? net / path : 0;
  const label = eff < 0.35 ? "chop" : eff > 0.5 ? "trend" : "mixed";
  return { eff: Math.round(eff * 1000) / 1000, label, bars: closes.length };
}

type Prop = { kind: GenomeKind; params: Record<string, number | string>; count: number; why: string };

function main(): void {
  const limit = num("--limit", 12);
  const maxPop = num("--max-pop", 160);
  const handle = db();

  let gen = getCurrentGeneration();
  let genId: number, genNumber: number;
  if (!gen) { genNumber = 0; genId = startGeneration(0, undefined, "research-refresh"); }
  else { genId = gen.id; genNumber = gen.gen_number; }

  const alive = (handle.prepare("SELECT COUNT(*) n FROM paper_agents WHERE alive = 1").get() as { n: number }).n;
  if (alive >= maxPop) {
    console.log(`research-refresh: skip — population ${alive} >= max-pop ${maxPop} (let arena:evolve cull first).`);
    return;
  }

  // --- read current market conditions ---
  const reg = regimeFromCandles("BTC-USD");
  const eventMarkets = (handle.prepare(
    `SELECT COUNT(DISTINCT token_id) n FROM market_snapshots
       WHERE category IN (${EVENT_CATEGORIES.map(() => "?").join(",")})
         AND midpoint BETWEEN 0.05 AND 0.95 AND spread <= 0.10`,
  ).get(...EVENT_CATEGORIES) as { n: number }).n;
  const favorites = (handle.prepare(
    `SELECT COUNT(DISTINCT token_id) n FROM market_snapshots
       WHERE (midpoint >= 0.92 OR midpoint <= 0.08) AND volume_24h IS NOT NULL`,
  ).get() as { n: number }).n;

  console.log(`research-refresh: regime BTC eff=${reg.eff} -> ${reg.label} (${reg.bars} bars) | event_markets=${eventMarkets} | favorites=${favorites}`);

  // --- build regime/condition-matched proposals ---
  const props: Prop[] = [];
  if (reg.label === "chop") {
    for (const pid of ["BTC-USD", "ETH-USD"]) props.push({ kind: "cb_mean_reversion", params: { product_id: pid, lookback_min: 120, z_entry: 1.4, z_exit: 0.3, stop_pct: 0.012, time_stop_min: 120, entry_size_usd: 25 }, count: 2, why: `chop regime mean-reversion ${pid}` });
  } else if (reg.label === "trend") {
    for (const pid of ["BTC-USD", "ETH-USD"]) props.push({ kind: "cb_breakout", params: { product_id: pid, lookback_min: 60, breakout_mult: 1.03, target_pct: 0.02, stop_pct: 0.015, time_stop_min: 240, entry_size_usd: 25 }, count: 1, why: `trend regime breakout ${pid}` });
    props.push({ kind: "cb_momentum_burst", params: { product_id: "BTC-USD", vel_window_min: 5, vel_entry_pct: 0.004, target_pct: 0.012, stop_pct: 0.008, time_stop_min: 60, direction_bias: "long_short", entry_size_usd: 20 }, count: 1, why: "trend regime momentum" });
  } else {
    props.push({ kind: "cb_mean_reversion", params: { product_id: "BTC-USD", lookback_min: 180, z_entry: 1.6, stop_pct: 0.012, entry_size_usd: 20 }, count: 1, why: "mixed regime mean-reversion" });
    props.push({ kind: "cb_breakout", params: { product_id: "ETH-USD", lookback_min: 90, breakout_mult: 1.03, stop_pct: 0.015, entry_size_usd: 20 }, count: 1, why: "mixed regime breakout" });
  }
  // structural cross-venue arb is always worth probing
  props.push({ kind: "cross_venue_arb", params: { cb_product_id: "BTC-USD", edge_pts: 5, bs_vol_window_days: 7, time_stop_h: 12, entry_size_usd: 25 }, count: 2, why: "structural cross-venue arb BTC" });
  props.push({ kind: "cross_venue_arb", params: { cb_product_id: "ETH-USD", edge_pts: 6, bs_vol_window_days: 7, time_stop_h: 12, entry_size_usd: 20 }, count: 1, why: "structural cross-venue arb ETH" });
  if (eventMarkets >= 5) props.push({ kind: "llm_probability_oracle", params: { model: "claude-haiku-4-5", min_ev_pct: 0.1, max_calls_per_tick: 3, cache_ttl_min: 180, entry_size_usd: 15 }, count: 2, why: `${eventMarkets} tradeable event markets` });
  if (favorites >= 1) props.push({ kind: "category_specialist", params: { category: "elections", inner_strategy: "fade_spike", threshold_pts: 6, lookback_h: 24, stop_pts: 5, entry_size_usd: 20 }, count: 1, why: `${favorites} favorites present` });

  // --- seed bounded ---
  let seeded = 0;
  const byKind: Record<string, number> = {};
  const tx = handle.transaction(() => {
    outer: for (const p of props) {
      for (let i = 0; i < p.count; i++) {
        const g = buildGenome(p.kind, p.params);
        if (!g) continue;
        insertPaperAgent({ name: `rr-${p.kind}-${reg.label}-${Math.floor(Math.random() * 1e9).toString(36)}`, generation: genNumber, genome: g, introduced_by: "machine:research-refresh", cash_usd_start: 100 });
        seeded++; byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
        if (seeded >= limit) break outer;
      }
    }
  });
  tx();
  setGenerationAgentCount(genId, listAllAgentsForGen(genNumber).length);
  console.log(`research-refresh: seeded ${seeded} regime-matched agents (${Object.entries(byKind).map(([k, n]) => `${k}:${n}`).join(", ")}); population now ${alive + seeded}.`);
}

main();
