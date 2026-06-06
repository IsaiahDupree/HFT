/**
 * consensus:paper — the FORWARD, survivorship-free test of the Polymarket consensus edge. Each run:
 *   1. detect live consensus signals from tracked-wallet activity (same detector as consensus:backtest);
 *   2. RECORD each one on a still-OPEN market with its entry price + timestamp (skip already-resolved markets —
 *      those would be retro/circular);
 *   3. GRADE every previously-recorded signal whose market has since resolved, using the INDEPENDENT Gamma
 *      winningIndex (NOT the cohort's own positions) — this is what breaks the survivorship loop.
 * Accumulated daily it turns `survivorship_suspect` into a real verdict. Persists to the Polymarket DB.
 *
 *   npm run consensus:paper            # detect + record + grade resolved
 *   npm run consensus:paper -- --show  # print the accumulating forward track, no detection
 */
import "./_env.ts";
import { db } from "../src/lib/db/client.ts";
import { poly } from "../src/lib/polymarket/client.ts";
import { detectConsensus, type ConsensusTrade } from "../src/lib/wallets/consensus.ts";
import { walletStatsFromClosed, verifyWalletStats } from "../src/lib/wallets/wallet-verification.ts";
import { classifyDirection } from "../src/lib/wallets/consensus-backtest.ts";
import { parseGammaResolvedMarket } from "../src/lib/wallets/copy-backtest.ts";
import { gradeForwardSignal, forwardTrackRecord, type RecordedSignal, type GradedSignal } from "../src/lib/wallets/consensus-paper.ts";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const flag = (n: string, d: number) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d; };
const DAYS = flag("days", 3), WINDOW_MIN = flag("window", 60), MIN_WALLETS = flag("min", 3), MIN_TRUST = flag("trust", 3), STEP_MIN = flag("step", 30), PER_WALLET_LIMIT = flag("limit", 200);

const handle = db();
handle.exec(`CREATE TABLE IF NOT EXISTS consensus_paper_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, condition_id TEXT, dir_idx INTEGER, entry_price REAL, wallet_count INTEGER,
  detected_ts INTEGER, resolved INTEGER DEFAULT 0, winning_index INTEGER, won INTEGER, copy_return REAL, resolved_ts INTEGER,
  UNIQUE(condition_id, dir_idx));`);

function gradedRows(): GradedSignal[] {
  return (handle.prepare(`SELECT condition_id, dir_idx, entry_price, wallet_count, detected_ts, winning_index, won, copy_return, resolved_ts FROM consensus_paper_signals WHERE resolved=1`).all() as any[])
    .map((r) => ({ conditionId: r.condition_id, dirIdx: r.dir_idx as 0 | 1, entryPrice: r.entry_price, walletCount: r.wallet_count, detectedTs: r.detected_ts, winningIndex: r.winning_index, won: !!r.won, copyReturn: r.copy_return, resolvedTs: r.resolved_ts }));
}

if (show) {
  const t = forwardTrackRecord(gradedRows());
  const pending = (handle.prepare(`SELECT COUNT(*) n FROM consensus_paper_signals WHERE resolved=0`).get() as { n: number }).n;
  console.log(`\nconsensus:paper — FORWARD track · ${t.n} graded · ${pending} pending resolution`);
  console.log(`  win ${(t.winRate * 100).toFixed(0)}% · implied ${(t.impliedWinRate * 100).toFixed(0)}% · edge ${t.edgeVsImplied >= 0 ? "+" : ""}${(t.edgeVsImplied * 100).toFixed(0)}pts · cum ${(t.cumReturn * 100).toFixed(0)}%`);
  console.log(`  VERDICT: ${t.verdict} — ${t.reason}\n`);
  process.exit(0);
}

const wallets = handle.prepare(`SELECT proxy_wallet, strategy_label, claimed_profit_usd FROM tracked_wallets WHERE proxy_wallet IS NOT NULL`).all() as Array<{ proxy_wallet: string; strategy_label: string | null; claimed_profit_usd: number | null }>;
if (!wallets.length) { console.log("No tracked wallets — run `npm run seed:tracked-wallets` first."); process.exit(0); }
const trustTier = (r: { strategy_label: string | null; claimed_profit_usd: number | null }) => Math.min(4, 1 + (r.strategy_label?.startsWith("auto-leaderboard") ? 1 : 0) + ((r.claimed_profit_usd ?? 0) > 1e6 ? 1 : 0) + ((r.claimed_profit_usd ?? 0) > 5e6 ? 1 : 0));

// 1) gather trades + VERIFY each wallet's realized track record (anti-delusion: only verified wallets vote)
const allTrades: ConsensusTrade[] = [];
const verified = new Set<string>();
for (const w of wallets) {
  try {
    const acts = (await poly.userActivity(w.proxy_wallet, { limit: PER_WALLET_LIMIT })) as any[];
    const tier = trustTier(w);
    for (const t of acts.filter((a) => String(a.type ?? "TRADE").toUpperCase() === "TRADE")) {
      const tsRaw = Number(t.timestamp); if (!Number.isFinite(tsRaw) || tsRaw <= 0) continue;
      const ms = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
      allTrades.push({ proxyWallet: w.proxy_wallet, trustTier: tier, marketKey: String(t.conditionId ?? ""), marketTitle: t.title ?? undefined, direction: String(t.outcome ?? (t.side ?? "")).trim() || "Yes", usd: Number(t.usdcSize ?? 0) || Number(t.size ?? 0) * Number(t.price ?? 0), price: Number(t.price ?? 0), ts: new Date(ms).toISOString() });
    }
    // verify from realized CLOSED positions (real profit on resolved markets, not leaderboard ROI)
    const closed = (await (await fetch(`https://data-api.polymarket.com/closed-positions?user=${w.proxy_wallet}&limit=${PER_WALLET_LIMIT}`, { signal: AbortSignal.timeout(20_000) })).json()) as any[];
    if (verifyWalletStats(walletStatsFromClosed((closed ?? []).map((r) => ({ realizedPnl: Number(r.realizedPnl ?? 0), curPrice: Number(r.curPrice) })))).verified) verified.add(w.proxy_wallet);
  } catch (e) { console.warn(`  ${w.proxy_wallet}: ${(e as Error).message}`); }
}
console.log(`consensus:paper — ${verified.size}/${wallets.length} wallets VERIFIED-profitable (only these vote)`);
allTrades.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
const nowMs = Date.now(), startMs = nowMs - DAYS * 86_400_000;
const inRange = allTrades.filter((t) => { const ms = Date.parse(t.ts); return ms >= startMs && ms <= nowMs; });
const seen = new Set<string>(); const signals = [] as ReturnType<typeof detectConsensus>;
for (let s = startMs; s + WINDOW_MIN * 60_000 <= nowMs; s += STEP_MIN * 60_000) {
  const slice = inRange.filter((t) => { const ms = Date.parse(t.ts); return ms >= s && ms <= s + WINDOW_MIN * 60_000; });
  if (slice.length < MIN_WALLETS) continue;
  for (const sig of detectConsensus(slice, { windowMinutes: WINDOW_MIN, minWallets: MIN_WALLETS, minCombinedTrust: MIN_TRUST, verifiedWallets: verified })) {
    const key = `${sig.marketKey}|${sig.direction.toLowerCase()}`; if (seen.has(key)) continue; seen.add(key); signals.push(sig);
  }
}
console.log(`consensus:paper — detected ${signals.length} live consensus signals`);

// 2) record signals on STILL-OPEN markets (skip already-resolved → those would be retro/circular)
const cids = [...new Set(signals.map((s) => s.marketKey).filter(Boolean))];
const resolvedNow = new Map<string, number>();              // conditionId → winningIndex (independent Gamma)
for (let i = 0; i < cids.length; i += 25) {
  try { for (const m of await poly.marketsByCondition(cids.slice(i, i + 25), { closed: true })) { const r = parseGammaResolvedMarket(m); if (r) resolvedNow.set(r.conditionId, r.winningIndex); } } catch { /* */ }
  await new Promise((r) => setTimeout(r, 200));
}
const ins = handle.prepare(`INSERT OR IGNORE INTO consensus_paper_signals (condition_id, dir_idx, entry_price, wallet_count, detected_ts) VALUES (?,?,?,?,?)`);
let recorded = 0;
for (const sig of signals) {
  const dirIdx = classifyDirection(sig.direction); if (dirIdx == null) continue;
  if (resolvedNow.has(sig.marketKey)) continue;             // already resolved at detection → not a forward signal
  const entry = dirIdx === 0 ? sig.avgPrice : 1 - sig.avgPrice;
  if (!(entry > 0 && entry < 1)) continue;
  const r = ins.run(sig.marketKey, dirIdx, entry, sig.effectiveWallets, nowMs); recorded += r.changes;
}
console.log(`  recorded ${recorded} NEW forward signals on open markets`);

// 3) grade every pending recorded signal whose market has since resolved (independent Gamma winningIndex)
const pending = handle.prepare(`SELECT condition_id, dir_idx, entry_price, wallet_count, detected_ts FROM consensus_paper_signals WHERE resolved=0`).all() as any[];
const pcids = [...new Set(pending.map((p) => p.condition_id))];
const pres = new Map<string, number>();
for (let i = 0; i < pcids.length; i += 25) {
  try { for (const m of await poly.marketsByCondition(pcids.slice(i, i + 25), { closed: true })) { const r = parseGammaResolvedMarket(m); if (r) pres.set(r.conditionId, r.winningIndex); } } catch { /* */ }
  await new Promise((r) => setTimeout(r, 200));
}
const upd = handle.prepare(`UPDATE consensus_paper_signals SET resolved=1, winning_index=?, won=?, copy_return=?, resolved_ts=? WHERE condition_id=? AND dir_idx=?`);
let graded = 0;
for (const p of pending) {
  const wi = pres.get(p.condition_id); if (wi == null) continue;
  const g = gradeForwardSignal({ conditionId: p.condition_id, dirIdx: p.dir_idx as 0 | 1, entryPrice: p.entry_price, walletCount: p.wallet_count, detectedTs: p.detected_ts }, wi, nowMs);
  upd.run(wi, g.won ? 1 : 0, g.copyReturn, nowMs, p.condition_id, p.dir_idx); graded++;
}
console.log(`  graded ${graded} newly-resolved signals (independent resolution)`);

const t = forwardTrackRecord(gradedRows());
console.log(`\n  FORWARD TRACK: ${t.n} graded · win ${(t.winRate * 100).toFixed(0)}% · implied ${(t.impliedWinRate * 100).toFixed(0)}% · edge ${t.edgeVsImplied >= 0 ? "+" : ""}${(t.edgeVsImplied * 100).toFixed(0)}pts · cum ${(t.cumReturn * 100).toFixed(0)}%`);
console.log(`  VERDICT: ${t.verdict} — ${t.reason}`);
console.log(`  (run daily; this is the ONLY non-circular test — resolution is independent of the cohort. ${(handle.prepare(`SELECT COUNT(*) n FROM consensus_paper_signals WHERE resolved=0`).get() as { n: number }).n} pending.)\n`);
