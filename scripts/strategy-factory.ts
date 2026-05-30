/**
 * strategy-factory — generate a large population of strategy variants by sweeping
 * parameter grids over the existing strategy families, and (optionally) seed them
 * as `strategy_versions` at `stage='sim'` so the arena can score them.
 *
 * This is the "hundreds of thousands of strategies" lever: a handful of families ×
 * modest per-param grids fans out past 10^5 distinct specs. Generation is cheap;
 * the arena + allocator are what separate signal from noise, so we seed at sim and
 * let promotion (sim→paper→live) gate anything toward real capital.
 *
 *   npx tsx scripts/strategy-factory.ts                 # DRY RUN: report grid sizes + samples
 *   npx tsx scripts/strategy-factory.ts --seed          # seed a bounded sample (default 200) at stage:sim
 *   npx tsx scripts/strategy-factory.ts --seed --limit 1000
 *   npx tsx scripts/strategy-factory.ts --family vol-scalp --seed --limit 500
 *
 * Safe by default: no DB writes unless --seed; seeding is bounded by --limit so it
 * never bloats the operator DB, and every variant lands at stage:sim (never live).
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";

type Grid = Record<string, Array<number | string>>;
type Family = {
  family: string;
  scanner: string; // matches a detector in src/lib/strategies/
  thesis: string;
  grid: Grid;
};

// Param grids over the real strategy families (see src/lib/strategies/*). Values
// are deliberately spread so the cartesian product is large but each point is a
// plausible config, not noise.
const FAMILIES: Family[] = [
  {
    family: "vol-scalp",
    scanner: "detectVolScalp",
    thesis: "Scalp the favorite side of a 5m crypto window when premium + remaining-time + tick-vol align.",
    grid: {
      minPremium: [0.003, 0.005, 0.01, 0.02, 0.03],
      maxPremium: [0.05, 0.06, 0.08, 0.1, 0.12],
      minRemainingMin: [1, 2, 3],
      maxRemainingMin: [10, 15, 20, 30],
      minTicks: [10, 15, 20, 30],
      sensitivityFactor: [1.0, 1.25, 1.5, 1.75, 2.0],
      feeBps: [5, 10, 15, 20],
      regime: ["trend", "mean_revert", "chop", "any"],
    },
  },
  {
    family: "orderbook-imbalance",
    scanner: "detectOrderbookImbalance",
    thesis: "Fade/ride top-of-book depth imbalance when the bid/ask ratio is extreme.",
    grid: {
      depthRatio: [2, 2.5, 3, 4, 5, 6],
      levels: [1, 2, 3],
      minEdge: [0.01, 0.02, 0.03, 0.05],
      holdSecs: [30, 60, 120, 300],
      stopPct: [0.005, 0.01, 0.015, 0.02],
      regime: ["trend", "mean_revert", "chop", "any"],
    },
  },
  {
    family: "cross-timeframe-spread",
    scanner: "detectCrossTimeframeSpread",
    thesis: "Trade divergence between the 5m and 15m view of the same crypto market.",
    grid: {
      zThreshold: [2.0, 2.5, 3.0, 3.5],
      fastWindow: [5, 10, 15],
      slowWindow: [30, 45, 60],
      minSamples: [10, 20, 30],
      stopPct: [0.008, 0.012, 0.02],
      tpMult: [1.5, 2.0, 2.5],
      regime: ["trend", "mean_revert", "chop", "any"],
    },
  },
  {
    family: "midwindow-trajectory",
    scanner: "detectMidwindowTrajectory",
    thesis: "Project the BTC move's trajectory mid-window to price the up/down outcome.",
    grid: {
      lookbackTicks: [10, 20, 30, 40, 60],
      driftThreshold: [0.001, 0.002, 0.004],
      minRemainingMin: [1, 2, 3],
      kellyFraction: [0.1, 0.25, 0.4],
      stopPct: [0.01, 0.015, 0.02],
      regime: ["trend", "mean_revert", "chop", "any"],
    },
  },
  {
    family: "near-resolution-scrape",
    scanner: "detectNearResolution",
    thesis: "Harvest annualized edge on markets pinned >0.95 with real time to resolution.",
    grid: {
      minPrice: [0.93, 0.94, 0.95, 0.96, 0.97],
      minAnnualizedEdge: [0.2, 0.35, 0.5, 0.75, 1.0],
      minHoursToResolve: [24, 48, 72, 168],
      maxPositionPct: [0.1, 0.2, 0.3],
      regime: ["any"],
    },
  },
  {
    family: "complement-sum-arb",
    scanner: "detectComplementSumArb",
    thesis: "Lock the arb when YES+NO best-asks sum below 1 minus fees.",
    grid: {
      maxSum: [0.96, 0.97, 0.98, 0.99],
      minEdgeBps: [20, 40, 60, 80, 100],
      maxLatencyMs: [250, 500, 1000],
      sizeUsd: [10, 25, 50, 100],
      regime: ["any"],
    },
  },
];

function gridSize(grid: Grid): number {
  return Object.values(grid).reduce((n, vals) => n * vals.length, 1);
}

/** Yield each point of the cartesian product as a spec object. */
function* enumerateGrid(grid: Grid): Generator<Record<string, number | string>> {
  const keys = Object.keys(grid);
  const idx = new Array(keys.length).fill(0);
  const sizes = keys.map((k) => grid[k].length);
  while (true) {
    const point: Record<string, number | string> = {};
    keys.forEach((k, i) => (point[k] = grid[k][idx[i]]));
    yield point;
    let carry = keys.length - 1;
    while (carry >= 0) {
      idx[carry]++;
      if (idx[carry] < sizes[carry]) break;
      idx[carry] = 0;
      carry--;
    }
    if (carry < 0) break;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

function main(): void {
  const onlyFamily = arg("--family");
  const doSeed = flag("--seed");
  const limit = Number(arg("--limit") ?? (doSeed ? 200 : 0));
  const families = onlyFamily ? FAMILIES.filter((f) => f.family === onlyFamily) : FAMILIES;
  if (families.length === 0) {
    console.error(`No family "${onlyFamily}". Known: ${FAMILIES.map((f) => f.family).join(", ")}`);
    process.exit(1);
  }

  let total = 0;
  console.log("strategy-factory — parameter-grid population\n");
  for (const f of families) {
    const n = gridSize(f.grid);
    total += n;
    console.log(`  ${f.family.padEnd(24)} ${n.toLocaleString().padStart(10)} variants  ` + `(${Object.entries(f.grid).map(([k, v]) => `${k}×${v.length}`).join(" · ")})`);
  }
  console.log(`\n  TOTAL: ${total.toLocaleString()} strategy variants across ${families.length} families.`);

  // Show 3 sample specs so the shape is visible without seeding.
  const sampleFamily = families[0];
  const samples: Array<Record<string, number | string>> = [];
  for (const p of enumerateGrid(sampleFamily.grid)) {
    samples.push(p);
    if (samples.length >= 3) break;
  }
  console.log(`\n  sample specs (${sampleFamily.family}):`);
  for (const s of samples) console.log("   ", JSON.stringify({ family: sampleFamily.family, scanner: sampleFamily.scanner, params: s }));

  if (!doSeed) {
    console.log(`\n  DRY RUN — no DB writes. Re-run with --seed [--limit N] to seed a bounded sample at stage:sim.`);
    return;
  }

  // --- Seed a bounded sample as strategy_versions at stage:sim ---
  const handle = db();
  const seed = handle.transaction(() => {
    // one umbrella agent owns all factory strategies
    handle
      .prepare(
        `INSERT INTO agents (slug, name, charter, risk_budget_usd, status)
         VALUES (@slug, @name, @charter, @risk, 'active')
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name`,
      )
      .run({ slug: "strategy-factory", name: "Strategy Factory", charter: "Auto-generated parameter-grid strategy population.", risk: 0 });
    const agentId = (handle.prepare("SELECT id FROM agents WHERE slug = ?").get("strategy-factory") as { id: number }).id;

    let seeded = 0;
    outer: for (const f of families) {
      // one strategy per family; each variant is a strategy_version at stage:sim
      handle
        .prepare(
          `INSERT INTO strategies (agent_id, slug, name, thesis, market_filter, status)
           VALUES (@agent_id, @slug, @name, @thesis, @mf, 'active')
           ON CONFLICT(agent_id, slug) DO UPDATE SET thesis = excluded.thesis`,
        )
        .run({ agent_id: agentId, slug: f.family, name: f.family, thesis: f.thesis, mf: JSON.stringify({ scanner: f.scanner }) });
      const stratId = (handle.prepare("SELECT id FROM strategies WHERE agent_id = ? AND slug = ?").get(agentId, f.family) as { id: number }).id;

      const baseVersion =
        ((handle.prepare("SELECT MAX(version) AS v FROM strategy_versions WHERE strategy_id = ?").get(stratId) as { v: number | null }).v ?? 0);
      let k = 0;
      for (const params of enumerateGrid(f.grid)) {
        const spec = { family: f.family, scanner: f.scanner, params };
        handle
          .prepare(
            `INSERT INTO strategy_versions
               (strategy_id, parent_version_id, version, spec_json, rationale, introduced_by, is_current, stage)
             VALUES (@sid, NULL, @ver, @spec, @rationale, 'machine:strategy-factory', 0, 'sim')`,
          )
          .run({
            sid: stratId,
            ver: baseVersion + k + 1,
            spec: JSON.stringify(spec),
            rationale: `grid variant ${k + 1}: ${Object.entries(params).map(([a, b]) => `${a}=${b}`).join(",")}`,
          });
        k++;
        seeded++;
        if (seeded >= limit) break outer;
      }
    }
    return seeded;
  });

  const seeded = seed();
  console.log(`\n  SEEDED ${seeded} strategy_versions at stage:sim (limit ${limit}). Run \`npm run arena:tick\` to score them.`);
}

main();
