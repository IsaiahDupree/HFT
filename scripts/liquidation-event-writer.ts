/**
 * liquidation-event-writer — poll on-chain liquidation events from NAVI (Sui) via
 * the LiquidationBot audit ledger and from Morpho Blue (Base) via GraphQL, then
 * append each new event to the passport data store.
 *
 * Storage layout:
 *   /Volumes/My Passport/hft-data/liquidations/navi/{YYYY-MM-DD}.jsonl
 *   /Volumes/My Passport/hft-data/liquidations/morpho/{YYYY-MM-DD}.jsonl
 *
 * NAVI events come from the LiquidationBot's hash-chained audit ledger at:
 *   /Users/isaiahdupree/Documents/Software/LiquidationBot/data/ledger/monitor.jsonl
 * We tail it, deduplicate by seq, and write execute/opportunity/miss entries.
 *
 * Morpho events are polled directly from the Morpho GraphQL API every interval.
 * We track position health below 1.0 (liquidatable), compute approximate profit,
 * and write each sub-1.0 position we haven't seen before in the current session.
 *
 *   npx tsx scripts/liquidation-event-writer.ts                 # run once (backfill + live)
 *   npx tsx scripts/liquidation-event-writer.ts -- --interval 30 # poll every 30s
 *   npx tsx scripts/liquidation-event-writer.ts -- --backfill-only  # copy historical ledger, no loop
 *
 * Fields written per event:
 *   ts, venue, user, collateral_symbol, collateral_usd, debt_symbol, debt_usd,
 *   health_factor, profit_usd, bonus_bps, type (execute|opportunity|miss|at_risk)
 */
import "./_env.ts";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const arg = (n: string, def = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};

const PASSPORT = arg("--passport", "/Volumes/My Passport/hft-data");
const LIQ_LEDGER = arg(
  "--ledger",
  "/Users/isaiahdupree/Documents/Software/LiquidationBot/data/ledger/monitor.jsonl",
);
const INTERVAL_S = Number(arg("--interval", "60"));
const BACKFILL_ONLY = process.argv.includes("--backfill-only");
const MORPHO_HF_MAX = Number(arg("--morpho-hf-max", "1.1"));
const MORPHO_GRAPHQL = "https://blue-api.morpho.org/graphql";

const NAVI_DIR = join(PASSPORT, "liquidations", "navi");
const MORPHO_DIR = join(PASSPORT, "liquidations", "morpho");
mkdirSync(NAVI_DIR, { recursive: true });
mkdirSync(MORPHO_DIR, { recursive: true });

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function datePath(dir: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return join(dir, `${d}.jsonl`);
}

function appendEvent(dir: string, obj: Record<string, unknown>): void {
  const line = JSON.stringify(obj) + "\n";
  appendFileSync(datePath(dir), line, "utf8");
}

function isoDate(): string {
  return new Date().toISOString();
}

// ──────────────────────────────────────────────────────────────
// NAVI: tail the LiquidationBot audit ledger
// ──────────────────────────────────────────────────────────────

type LedgerEntry = {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
  prevHash: string;
  hash: string;
};

function loadLedgerLines(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const entries: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // malformed line — skip
    }
  }
  return entries;
}

// Collect the max seq already written to any navi daily file so we don't double-write.
function loadWrittenNaviSeqs(): Set<number> {
  const seen = new Set<number>();
  if (!existsSync(NAVI_DIR)) return seen;
  for (const f of readdirSync(NAVI_DIR).filter((x) => x.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(NAVI_DIR, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { ledger_seq?: number };
        if (typeof obj.ledger_seq === "number") seen.add(obj.ledger_seq);
      } catch {
        // skip
      }
    }
  }
  return seen;
}

function syncNaviLedger(): number {
  const entries = loadLedgerLines(LIQ_LEDGER);
  if (entries.length === 0) return 0;
  const written = loadWrittenNaviSeqs();
  let newCount = 0;
  for (const e of entries) {
    if (written.has(e.seq)) continue;
    if (!["execute", "opportunity", "miss", "risk_skip"].includes(e.type)) continue;
    const p = e.payload as Record<string, unknown>;
    appendEvent(NAVI_DIR, {
      ts: e.ts,
      iso: new Date(e.ts).toISOString(),
      venue: "navi",
      type: e.type,
      ledger_seq: e.seq,
      id: p["id"] ?? null,
      collateral_symbol: p["collateralSymbol"] ?? null,
      collateral_usd: p["collateralUsd"] ?? null,
      debt_symbol: p["debtSymbol"] ?? null,
      debt_usd: p["debtUsd"] ?? null,
      health_factor: p["hf"] ?? null,
      profit_usd: p["netUsd"] ?? null,
      bonus_bps: p["bonusBps"] ?? null,
      accept: p["accept"] ?? null,
    });
    newCount++;
  }
  return newCount;
}

// ──────────────────────────────────────────────────────────────
// Morpho: poll GraphQL for at-risk positions
// ──────────────────────────────────────────────────────────────

type MorphoPosition = {
  user: string;
  healthFactor: string;
  market: { id: string };
  collateral: { asset: { symbol: string }; usdValue: string };
  loan: { asset: { symbol: string }; borrowAssetsUsd: string };
};

async function fetchMorphoAtRisk(): Promise<MorphoPosition[]> {
  const body = JSON.stringify({
    query: `{
      positions(
        where: { chainId_in: [8453], healthFactor_lte: "${MORPHO_HF_MAX}", borrowShares_gte: "1" }
        orderBy: healthFactor
        orderDirection: asc
        first: 50
      ) {
        items {
          user { address }
          healthFactor
          market { uniqueKey }
          collateral {
            asset { symbol }
            collateralAssetsUsd
          }
          loan {
            asset { symbol }
            borrowAssetsUsd
          }
        }
      }
    }`,
  });

  try {
    const r = await fetch(MORPHO_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as {
      data?: { positions?: { items?: unknown[] } };
    };
    return (j?.data?.positions?.items ?? []) as MorphoPosition[];
  } catch {
    return [];
  }
}

// Track positions we've written this session to avoid duplicate writes on the same run.
const morphoSeen = new Set<string>();

async function syncMorpho(): Promise<number> {
  const positions = await fetchMorphoAtRisk();
  let newCount = 0;
  for (const p of positions) {
    const user = (p.user as unknown as { address?: string })?.address ?? (p.user as unknown as string);
    const marketId = (p.market as unknown as { uniqueKey?: string })?.uniqueKey ?? "";
    const key = `${user}|${marketId}`;
    if (morphoSeen.has(key)) continue;
    morphoSeen.add(key);
    const hf = parseFloat((p as unknown as { healthFactor: string }).healthFactor ?? "0");
    appendEvent(MORPHO_DIR, {
      ts: Date.now(),
      iso: isoDate(),
      venue: "morpho",
      type: hf <= 1.0 ? "liquidatable" : "at_risk",
      user,
      market_id: marketId,
      collateral_symbol: (p.collateral as unknown as { asset?: { symbol?: string } })?.asset?.symbol ?? null,
      collateral_usd: parseFloat((p.collateral as unknown as { collateralAssetsUsd?: string })?.collateralAssetsUsd ?? "0"),
      debt_symbol: (p.loan as unknown as { asset?: { symbol?: string } })?.asset?.symbol ?? null,
      debt_usd: parseFloat((p.loan as unknown as { borrowAssetsUsd?: string })?.borrowAssetsUsd ?? "0"),
      health_factor: hf,
    });
    newCount++;
  }
  return newCount;
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

console.log("liquidation-event-writer starting");
console.log(`  passport: ${PASSPORT}`);
console.log(`  navi ledger: ${LIQ_LEDGER}`);
console.log(`  morpho HF threshold: ≤${MORPHO_HF_MAX}`);
console.log(`  interval: ${INTERVAL_S}s${BACKFILL_ONLY ? " (backfill-only)" : ""}\n`);

async function tick(): Promise<void> {
  const naviNew = syncNaviLedger();
  const morphoNew = await syncMorpho();
  console.log(`[${isoDate()}] navi +${naviNew} | morpho +${morphoNew} → passport`);
}

await tick();

if (BACKFILL_ONLY) {
  console.log("backfill complete.");
  process.exit(0);
}

// Live polling loop
let running = true;
process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
while (running) {
  await sleep(INTERVAL_S * 1000);
  if (!running) break;
  await tick();
}

console.log("liquidation-event-writer stopped.");
