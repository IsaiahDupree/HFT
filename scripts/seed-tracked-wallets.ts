/**
 * Seed tracked_wallets with named wallets cited by external sources.
 *
 *   npm run seed:tracked-wallets
 *
 * Idempotent — uses ON CONFLICT(handle) DO UPDATE so re-running is safe.
 * Each row records the source so we can re-verify or revoke. The actual
 * proxy_wallet 0x address is left NULL initially; `scripts/resolve-tracked-wallets.ts`
 * (run separately) resolves handles via the Polymarket leaderboard API.
 *
 * Three sources today:
 *   - Lunar 2026-03-30 article (paid partnership)
 *   - Lunar 2026-05-25 thread
 *   - antpalkin/cvxv666 2026-05-25 thread
 *
 * NONE of these PnL claims are independently verified. They're stored as
 * `claimed_profit_usd` so it's obvious they're hearsay, not measured.
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { insertEvolutionEvent } from "../src/lib/db/queries.ts";

type Seed = {
  handle: string;
  proxyWallet?: string;
  claimedProfitUsd?: number;
  strategyLabel?: string;
  note: string;
};

const SEEDS: Seed[] = [
  // From the Lunar 2026-03-30 article. PnL figures are the article's claims.
  {
    handle: "HorizonSplendidView",
    claimedProfitUsd: 4_016_108,
    strategyLabel: "crypto+macro high-freq",
    note: "Lunar 2026-03-30: 'crypto and macro markets. High-frequency, small edges, massive volume.' Claim unverified — sum closed-positions cashPnl from Data API to confirm.",
  },
  {
    handle: "beachboy4",
    claimedProfitUsd: 6_120_000,
    strategyLabel: "sports (one-session windfall)",
    note: "Lunar 2026-03-30: '$6.12M profit in a single day. Mostly sports — Tottenham + Sunderland matches netted $1M+ each. Was deep in the red before this. One session changed everything.' Pattern smells like single-event variance, not repeatable edge.",
  },
  {
    handle: "majorexploiter",
    claimedProfitUsd: 2_416_975,
    strategyLabel: "geopolitics+elections only",
    note: "Lunar 2026-03-30: '+$2,416,975 in March 2026. Geopolitics and elections only. Doesn't touch crypto. Doesn't touch sports. Laser focus.' Category specialist — single-category bots are easier to fingerprint via scan-leaderboard.",
  },
  {
    handle: "CemeterySun",
    strategyLabel: "market-making (high volume)",
    note: "Lunar 2026-03-30: '$36.6M volume traded. Tiny edge per trade. Thousands of trades. Market making on steroids.' MM strategies are capacity-constrained — copying erodes the edge.",
  },

  // From Lunar's 2026-05-25 thread + bot/promo profile.
  {
    handle: "xuanxuan008",
    strategyLabel: "unknown — featured wallet",
    note: "Lunar 2026-05-25 thread (paid partnership). 'Copytrade wallet'. Profile featured without verifiable strategy claims — fingerprint via /wallets/[address] before treating as signal.",
  },
  {
    handle: "googoogaga23",
    strategyLabel: "Lunar's own promo bot",
    note: "Lunar's 'profile bot' across multiple posts. Affiliated with paid kreo.app CTAs — treat performance claims as marketing, not signal.",
  },

  // From the antpalkin/cvxv666 2026-05-25 thread (Hermes/Polymarket bot post).
  {
    handle: "0xb55fa1296E6ec55D0cE53d93B9237389f11764d4",
    proxyWallet: "0xb55fa1296E6ec55D0cE53d93B9237389f11764d4",
    claimedProfitUsd: 236_913,
    strategyLabel: "directional crypto intraday (correlated basket)",
    note: "@antpalkin 2026-05-25: claimed '$3K → $236,913 in 23 days' using 'Hermes Agent by NousResearch'. Wallet IS real and active (~19K trades, $9.9K biggest win). Our /wallets fingerprint classified as correlated_basket — multiple crypto assets traded same direction in same window.",
  },
];

(async () => {
  console.log(`[seed-tracked-wallets] upserting ${SEEDS.length} wallets...`);
  const handle = db();

  // Ensure the unique index on handle exists (created by helpers/db.ts schema; production uses
  // the schema file which doesn't have it as UNIQUE by default — be defensive).
  let inserted = 0;
  let updated = 0;
  for (const s of SEEDS) {
    const existing = handle.prepare("SELECT id FROM tracked_wallets WHERE handle = ?").get(s.handle) as { id: number } | undefined;
    if (existing) {
      handle
        .prepare(
          `UPDATE tracked_wallets
              SET proxy_wallet = COALESCE(proxy_wallet, ?),
                  claimed_profit_usd = COALESCE(?, claimed_profit_usd),
                  strategy_label = COALESCE(?, strategy_label),
                  note = ?,
                  last_resolved = COALESCE(last_resolved, datetime('now'))
            WHERE id = ?`,
        )
        .run(s.proxyWallet ?? null, s.claimedProfitUsd ?? null, s.strategyLabel ?? null, s.note, existing.id);
      updated++;
      console.log(`  ↻ ${s.handle}`);
    } else {
      handle
        .prepare(
          `INSERT INTO tracked_wallets (handle, proxy_wallet, claimed_profit_usd, strategy_label, note, last_resolved)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(s.handle, s.proxyWallet ?? null, s.claimedProfitUsd ?? null, s.strategyLabel ?? null, s.note, s.proxyWallet ? new Date().toISOString() : null);
      inserted++;
      console.log(`  + ${s.handle}`);
    }
  }

  // Bug #3 (Survivorship Bias) guardrail: warn loudly when seeds have
  // unverified claimed PnL with no measured baseline. PRD §6.6.R6.
  const SURVIVORSHIP_WARN_USD = 1_000_000;
  let warned = 0;
  for (const s of SEEDS) {
    const claimed = s.claimedProfitUsd ?? 0;
    if (claimed >= SURVIVORSHIP_WARN_USD) {
      console.warn(`  ⚠️  ${s.handle}: claimed_profit_usd=$${claimed.toLocaleString()} is hearsay (no measured PnL yet). Run \`npm run backfill:wallet ${s.proxyWallet ?? s.handle}\` + verify per project_research_ingestion.md before treating as signal. Article likely shows the WINNERS — survivorship bias.`);
      warned += 1;
    }
  }

  insertEvolutionEvent({
    event_type: "seed-tracked-wallets",
    summary: `seed: +${inserted} new, ${updated} updated (Lunar 2026-03-30 article + antpalkin 2026-05-25)${warned > 0 ? ` · ${warned} survivorship-warned` : ""}`,
    payload_json: JSON.stringify({ inserted, updated, survivorship_warned: warned, sources: ["lunar-2026-03-30", "lunar-2026-05-25", "antpalkin-2026-05-25"] }),
  });

  console.log(`[seed-tracked-wallets] done: inserted=${inserted} updated=${updated}${warned > 0 ? `, survivorship-warned=${warned}` : ""}`);
  console.log("[seed-tracked-wallets] next: run `npm run resolve:tracked` to resolve handle → proxy_wallet via leaderboard API, then `npm run backfill:wallet <handle>` per row.");
})().catch((err) => {
  console.error("[seed-tracked-wallets] FAILED:", err);
  process.exit(1);
});
