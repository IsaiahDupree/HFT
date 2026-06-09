/**
 * hl-wallet-track — the spine of the wallet-copy program. On every run it: (1) pulls the top-N Hyperliquid
 * leaderboard wallets, (2) fetches each wallet's fill history (paginated, ~30d), (3) REVERSE-ENGINEERS the
 * backing strategy (profileStrategy: round-trips → hold-time → directionality → copyability), (4) appends a
 * timestamped snapshot + the closed round-trips into the LONGITUDINAL dataset (wallets.db), and (5) writes a
 * per-wallet markdown DOSSIER to docs/wallets/<addr>.md plus a ranked index. Run it on a cron and the dataset +
 * documentation accrue over time — exactly: capture every wallet → reverse-engineer → document every one.
 *
 *   npm run hl:wallet-track [-- --top 60 --days 30]
 *
 * Honest scope: Hyperliquid only (on-chain). Binance/Coinbase expose NO per-wallet data; dYdX has no public
 * leaderboard (needs seed addresses). Copyability is MEASURED per wallet — slow swings copyable, HFT not.
 */
import "./_env.ts";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLeaderboard, realizedStats, isVerifiedProfitable, walletArchetype, type Fill } from "../src/lib/exec/smart-money.ts";
import { netCapitalFlow, flowDistortion, type LedgerUpdate } from "../src/lib/exec/capital-flow.ts";
import { profileStrategy, fmtHold, reconstructRoundTrips } from "../src/lib/exec/strategy-profile.ts";
import { openWalletDb, type WalletSnapshot, type TripRow } from "../src/lib/exec/wallet-store.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const str = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const TOP = num("--top", 60), DAYS = num("--days", 30), SEEDS = str("--seeds");
const NOW = Date.now(), ISO = new Date(NOW).toISOString();
const INFO = "https://api.hyperliquid.xyz/info", LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const DOCS = resolve(process.cwd(), "docs", "wallets");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function jget(u: string): Promise<any> { const r = await fetch(u, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); }
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1000 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

const toFill = (f: Record<string, unknown>): Fill => ({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), closedPnl: Number(f.closedPnl ?? 0), time: Number(f.time) });
/** Paginate userFillsByTime forward over the lookback window so hold-time stats aren't truncated to last 2000. */
async function fetchFills(user: string, startTime: number, maxPages = 6): Promise<Fill[]> {
  const out: Fill[] = []; let cursor = startTime;
  for (let p = 0; p < maxPages; p++) {
    const batch = ((await info({ type: "userFillsByTime", user, startTime: cursor })) ?? []) as Array<Record<string, unknown>>;
    if (!batch.length) break;
    out.push(...batch.map(toFill));
    const last = Math.max(...batch.map((b) => Number(b.time)));
    if (batch.length < 2000 || last <= cursor) break;
    cursor = last + 1; await sleep(40);
  }
  // de-dup by (time,coin,dir,px,sz) — pagination boundaries can overlap
  const seen = new Set<string>();
  return out.filter((f) => { const k = `${f.time}|${f.coin}|${f.dir}|${f.px}|${f.sz}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const f0 = (n: number, d = 0) => (Number.isFinite(n) ? n : 0).toFixed(d);
const usd = (n: number) => `$${(n / 1000).toFixed(1)}k`;

function dossier(s: WalletSnapshot, reasons: string[], hist: WalletSnapshot[]): string {
  const drift = hist.length > 1 ? `\n## History\n${hist.length} snapshots since ${hist[0].iso.slice(0, 10)}. Account value: ${usd(hist[0].accountValue)} → ${usd(s.accountValue)}. Copyability verdict trail: ${hist.map((h) => h.copyabilityVerdict).join(" → ")}.\n` : `\n## History\nFirst snapshot — drift study begins next run.\n`;
  return `# Wallet \`${s.address}\`

**Strategy:** ${s.label}
**Archetype:** ${s.archetype} · **Copyability:** ${s.copyabilityVerdict} (${s.copyabilityScore.toFixed(2)})
**Verified profitable (own fills):** ${s.verified ? "✓ yes" : "✗ no"} · **Capital flow:** ${s.flowDistorted ? `⚠ withdrew ${usd(s.withdrawnUsd)} (ROI distorted)` : "clean"}

> _${s.iso.slice(0, 10)} — Hyperliquid on-chain. Copyability is measured from mechanics (hold time, turnover), not from how profitable the wallet looks._

## Snapshot
| metric | value |
|---|---|
| account value | ${usd(s.accountValue)} |
| realized PnL (window) | ${usd(s.realizedPnl)} |
| round-trips (closed) | ${s.nTrips} |
| win rate | ${f0(s.winRate * 100)}% |
| expectancy / trade | $${f0(s.expectancyUsd)} |
| median hold | ${fmtHold(s.medianHoldMs)} |
| trades / day | ${f0(s.tradesPerDay, 1)} |
| directionality | ${s.directionality} (long-share ${f0(s.longShare * 100)}%) |
| horizon | ${s.horizon} |
| coins traded | ${s.nCoins} (top ${s.topCoin} ${f0(s.topCoinShare * 100)}%) |
| open positions | ${s.openPositions || "flat"} |

## Copyability verdict — ${s.copyabilityVerdict}
${reasons.map((r) => `- ${r}`).join("\n")}

## How to copy — mode: ${s.copyMode}
${s.copyMode === "trade-copy"
      ? `Trade-copy: mirror each ${s.directionality === "momentum-short" ? "short" : "long"} entry on ${s.topCoin}${s.nCoins > 1 ? " and its other coins" : ""} one-for-one, ~${fmtHold(s.medianHoldMs)} expected hold; size as a fraction of their notional, model slippage, replicate exits in-window. Paper-track first (\`npm run hl:copy-paper\`).`
      : s.copyMode === "position-copy"
        ? `Position-copy ONLY: ${f0(s.tradesPerDay, 0)} trades/day is too many to mirror fill-by-fill — this is a large concurrent book. Track their NET exposure per coin and match the *aggregate* daily, not each trade. The reported hold may be FIFO-inflated; treat hold as approximate. Higher slippage/cost risk — paper-track before any capital.`
        : "Do NOT copy — sub-5min churn; the edge is latency/fee-rebate a follower can't capture. Watch only."}
${drift}
---
_Auto-generated by \`npm run hl:wallet-track\`. One file per wallet; re-run to refresh + accrue history._
`;
}

type Seeded = { address: string; accountValue: number };
let ranked: Seeded[];
if (SEEDS) {
  const parsed = JSON.parse(readFileSync(resolve(SEEDS), "utf8"));
  const addrs: string[] = Array.isArray(parsed) ? parsed : (parsed.seeds ?? []).map((s: { wallet: string }) => s.wallet);
  ranked = addrs.slice(0, TOP).map((address) => ({ address, accountValue: 0 })); // accountValue filled from clearinghouseState
  console.log(`\nhl-wallet-track — profiling ${ranked.length} SEED wallets from ${SEEDS} (${DAYS}d fills)\n`);
} else {
  ranked = parseLeaderboard(await jget(LB)).slice(0, TOP);
  console.log(`\nhl-wallet-track — capture + reverse-engineer + document top ${TOP} HL wallets (${DAYS}d fills)\n`);
}
const store = openWalletDb();
const startTime = Math.floor(NOW - DAYS * 86_400_000);
mkdirSync(DOCS, { recursive: true });
const index: WalletSnapshot[] = [];

for (const w of ranked) {
  try {
    const st = await info({ type: "clearinghouseState", user: w.address });
    const acct = Number(st?.marginSummary?.accountValue ?? w.accountValue);
    const aps = (st?.assetPositions ?? []) as Array<{ position: { coin: string; szi: string; positionValue?: string } }>;
    const openPos = aps.map((a) => ({ coin: a.position.coin, szi: Number(a.position.szi), notional: Number(a.position.positionValue ?? 0) }))
      .sort((a, b) => b.notional - a.notional).slice(0, 3).map((p) => `${p.szi >= 0 ? "L" : "S"} ${p.coin} ${usd(p.notional)}`).join(", ");
    const fills = await fetchFills(w.address, startTime);
    if (fills.length < 5) continue;
    const prof = profileStrategy(fills);
    const rs = realizedStats(fills);
    const ledger = (await info({ type: "userNonFundingLedgerUpdates", user: w.address, startTime })) as LedgerUpdate[];
    const flow = netCapitalFlow(ledger), dist = flowDistortion(flow, acct);
    const tradesPerDay = fills.length / Math.max((Math.max(...fills.map((f) => f.time)) - Math.min(...fills.map((f) => f.time))) / 86_400_000, 1e-6);

    const snap: WalletSnapshot = {
      ts: NOW, iso: ISO, address: w.address, accountValue: acct,
      archetype: walletArchetype({ tradesPerDay, longBias: prof.longShare, topCoinShare: prof.topCoinShare }),
      label: prof.label, horizon: prof.horizon, directionality: prof.directionality,
      copyabilityScore: prof.copyability.score, copyabilityVerdict: prof.copyability.verdict, copyMode: prof.copyability.mode,
      tradesPerDay, medianHoldMs: prof.hold.medianHoldMs, longShare: prof.longShare, topCoin: prof.topCoin, topCoinShare: prof.topCoinShare, nCoins: prof.nCoins,
      nTrips: prof.hold.nTrips, winRate: prof.winRate, expectancyUsd: prof.expectancyUsd, realizedPnl: rs.realizedPnl,
      verified: isVerifiedProfitable(rs), flowDistorted: dist.distorted, withdrawnUsd: flow.withdrawals, openPositions: openPos,
    };
    store.saveSnapshot(snap);
    const trips = reconstructRoundTrips(fills);
    store.saveTrips(trips.map((t): TripRow => ({ address: w.address, coin: t.coin, side: t.side, entryTime: t.entryTime, exitTime: t.exitTime, holdMs: t.holdMs, entryPx: t.entryPx, exitPx: t.exitPx, sz: t.sz, pnl: t.pnl })));
    writeFileSync(resolve(DOCS, `${w.address}.md`), dossier(snap, prof.copyability.reasons, store.history(w.address)));
    index.push(snap);
    process.stdout.write(`  ${w.address.slice(0, 10)} ${snap.copyabilityVerdict.padEnd(11)} ${snap.label}\n`);
    await sleep(40);
  } catch { /* skip */ }
}

// ranked index — verified + score first
index.sort((a, b) => (Number(b.verified) - Number(a.verified)) || (b.copyabilityScore - a.copyabilityScore));
const row = (s: WalletSnapshot) => `| [\`${s.address.slice(0, 10)}…\`](./${s.address}.md) | ${s.copyMode} | ${s.verified ? "✓" : "·"}${s.flowDistorted ? " ⚠flow" : ""} | ${s.label} | ${fmtHold(s.medianHoldMs)} | ${usd(s.realizedPnl)} | ${f0(s.tradesPerDay, 1)} |`;
const hdr = `| wallet | copy-mode | flags | strategy | median hold | realized | trades/day |\n|---|---|---|---|---|---|---|`;
const tradeCopy = index.filter((s) => s.copyMode === "trade-copy" && s.verified && !s.flowDistorted);
const positionCopy = index.filter((s) => s.copyMode === "position-copy" && s.verified && !s.flowDistorted);
const readme = `# Hyperliquid Wallet Dossiers

Auto-generated by \`npm run hl:wallet-track\`. ${index.length} wallets tracked (top ${TOP} leaderboard). Longitudinal dataset: \`wallets.db\` (${store.snapshotCount()} snapshots total). One markdown file per wallet.

**Honest scope:** Hyperliquid only — fully on-chain. Binance & Coinbase are centralized (no public per-wallet data); dYdX is on-chain but has no public leaderboard. Copyability is MEASURED per wallet from hold-time + turnover, not assumed.

**Two copy modes** (they need different rails): _trade-copy_ = low turnover, mirror each fill one-for-one (the clean case). _position-copy_ = long net hold but high turnover (a big concurrent book) — mirror only the NET exposure daily; reported hold is likely FIFO-inflated. _un-copyable_ = sub-5min churn, latency edge you can't capture.

## A. Trade-copy follow-list — low-turnover, verified-profitable, clean flow (${tradeCopy.length})
The genuinely clean ones: you can mirror each trade.
${tradeCopy.length ? `${hdr}\n${tradeCopy.map(row).join("\n")}` : "_None this run. Clean low-turnover trade-copyable wallets are rare on the PnL leaderboard — they rank below the algos. Scan deeper (--top 300) or seed from position-consensus to find them._"}

## B. Position-copy candidates — verified + clean, but track NET book only (${positionCopy.length})
Real edge, but NOT trade-by-trade copyable. Mirror aggregate exposure; higher cost/slippage risk; hold-time approximate.
${positionCopy.length ? `${hdr}\n${positionCopy.map(row).join("\n")}` : "_None this run._"}

## All tracked wallets (verified + score first)
${hdr}
${index.map(row).join("\n")}

_✓ = verified-profitable on own fills · ⚠flow = withdrew >25% of equity (ROI distorted)._
`;
writeFileSync(resolve(DOCS, "README.md"), readme);
const totalSnaps = store.snapshotCount();
store.close();

const m = (k: string) => index.filter((s) => s.copyMode === k).length;
console.log(`\n  tracked ${index.length} · trade-copy ${m("trade-copy")} · position-copy ${m("position-copy")} · un-copyable ${m("none")}`);
console.log(`  A. trade-copy follow-list (clean, mirror each fill): ${tradeCopy.length}`);
console.log(`  B. position-copy candidates (net-book only): ${positionCopy.length}`);
console.log(`  dossiers → ${DOCS}/  ·  dataset → wallets.db (${totalSnaps} snapshots)\n`);
