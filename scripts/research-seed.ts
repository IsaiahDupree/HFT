/**
 * research-seed — spin up RESEARCH-TARGETED arena agents (not random grids).
 *
 * Reads a proposals JSON (produced by the research workflow, or hand-written) and
 * seeds paper_agents whose genomes are tuned to a researched +EV edge — arbitrage,
 * market-making, LLM-priced markets, regime-matched momentum, etc. Each proposal:
 *   { kind, params, count, angle, rationale, expected_edge_bps, confidence, targets }
 * For each, we build a VALID genome (randomGenome base fills opaque fields, the
 * researched params override the bounded ones, clamped to PARAM_BOUNDS) and insert
 * `count` agents into the open generation so the running arena loop scores them.
 *
 *   npx tsx scripts/research-seed.ts <proposals.json> [--limit 40] [--gen current]
 *
 * Safe: validates every genome against the Zod schema (skips invalid), bounds the
 * total by --limit, seeds at the arena's sim layer (paper_agents) like arena:init.
 */
import "./_env.ts";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db/client.ts";
import { clamp, getParamBounds, parseGenome, randomGenome, type Genome, type GenomeKind } from "../src/lib/arena/genome.ts";
import { getCurrentGeneration, insertPaperAgent, listAllAgentsForGen, setGenerationAgentCount, startGeneration } from "../src/lib/arena/db.ts";

type Proposal = {
  kind: GenomeKind;
  params?: Record<string, number | string>;
  count?: number;
  angle?: string;
  rationale?: string;
  expected_edge_bps?: number;
  confidence?: number;
  targets?: string[];
};

const KNOWN_KINDS: GenomeKind[] = [
  "poly_fade_spike", "poly_breakout", "cb_breakout", "cb_mean_reversion", "cross_venue_arb",
  "cb_momentum_burst", "random_walk_baseline", "category_specialist", "wallet_copy_filtered",
  "polymarket_market_maker", "llm_probability_oracle", "poly_short_binary_directional", "multi_strategy",
];

function rid(): string {
  return Math.floor(Math.random() * 1e9).toString(36);
}

/** Build a valid genome of `kind` with researched params overriding a random base. */
function buildGenome(kind: GenomeKind, params: Record<string, number | string> = {}): Genome | null {
  const base = randomGenome(() => 0.5, kind) as { kind: GenomeKind; params: Record<string, unknown> };
  const merged: Record<string, unknown> = { ...base.params };
  const bounds = getParamBounds(kind);
  for (const [k, v] of Object.entries(params)) {
    const b = bounds[k];
    if (b && Array.isArray(b) && typeof b[0] === "number") {
      const num = Number(v);
      if (Number.isFinite(num)) merged[k] = clamp(num, b[0] as number, b[1] as number);
    } else if (b && Array.isArray(b) && typeof b[0] === "string") {
      if ((b as string[]).includes(String(v))) merged[k] = String(v);
    } else {
      // opaque/string field not in bounds — accept as-is (e.g. category targets)
      merged[k] = v;
    }
  }
  try {
    return parseGenome(JSON.stringify({ kind, params: merged }));
  } catch {
    return null;
  }
}

function argNum(name: string, def: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: research-seed.ts <proposals.json> [--limit N]");
    process.exit(1);
  }
  const limit = argNum("--limit", 40);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { proposals?: Proposal[] } | Proposal[];
  const proposals: Proposal[] = Array.isArray(raw) ? raw : raw.proposals ?? [];
  if (proposals.length === 0) {
    console.error("no proposals in file");
    process.exit(1);
  }

  const handle = db();
  let gen = getCurrentGeneration();
  let genId: number;
  let genNumber: number;
  if (!gen) {
    genNumber = 0;
    genId = startGeneration(0, undefined, "research-seed");
    console.log("(no open generation — created gen 0)");
  } else {
    genId = gen.id;
    genNumber = gen.gen_number;
  }

  let seeded = 0;
  let skipped = 0;
  const byKind: Record<string, number> = {};
  const tx = handle.transaction(() => {
    outer: for (const p of proposals) {
      if (!KNOWN_KINDS.includes(p.kind)) { skipped++; continue; }
      const count = Math.max(1, Math.min(Number(p.count ?? 1), 20));
      const angle = (p.angle ?? "research").replace(/[^a-z0-9]+/gi, "-").slice(0, 16);
      for (let i = 0; i < count; i++) {
        const genome = buildGenome(p.kind, p.params ?? {});
        if (!genome) { skipped++; continue; }
        insertPaperAgent({
          name: `rt-${p.kind}-${angle}-${rid()}`,
          generation: genNumber,
          genome,
          introduced_by: "machine:research-seed",
          cash_usd_start: 100,
        });
        seeded++;
        byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
        if (seeded >= limit) break outer;
      }
    }
  });
  tx();
  setGenerationAgentCount(genId, listAllAgentsForGen(genNumber).length);

  console.log(`\nresearch-seed: seeded ${seeded} targeted agents into gen ${genNumber} (skipped ${skipped} invalid).`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(28)} ${n}`);
  console.log(`\nThe running arena loop will tick + score these; arena:allocate funds the proven ones.`);
}

main();
