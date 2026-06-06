/**
 * hl-smart-money — track COPYABLE smart money on Hyperliquid's transparent order flow. Ranks the leaderboard
 * by sustained, risk-adjusted, COPYABLE skill (not raw PnL — that surfaces whales + un-followable HFT MMs),
 * pulls each top wallet's LIVE positions + recent fills, classifies copyability (swing vs scalper), and
 * aggregates the survivors' positions into a "smart-money consensus" — what skilled, copyable wallets are
 * actually positioned in right now. Intelligence only; places no orders. Mind the bias: even a clean rank is
 * survivorship-selected — yesterday's consistent winner is not guaranteed tomorrow's.
 *
 *   npm run hl:smart [-- --top 20 --min-acct 25000 --min-vlm 250000 --max-turnover 300]
 */
import "./_env.ts";
import { parseLeaderboard, rankWallets, positionConsensus, fillStyleProfile, realizedStats, isVerifiedProfitable, DEFAULT_RANK, type WalletPosition, type Fill } from "../src/lib/exec/smart-money.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const TOP = num("--top", 20);
const rank = { ...DEFAULT_RANK, minAccountValue: num("--min-acct", 25_000), minMonthVlm: num("--min-vlm", 250_000), maxTurnover: num("--max-turnover", 300) };
const INFO = "https://api.hyperliquid.xyz/info";
const LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
async function jget(url: string): Promise<any> { const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${url.slice(0, 50)} ${r.status}`); return r.json(); }
const info = async (body: unknown): Promise<any> => { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`info ${r.status}`); return r.json(); };

console.log(`\nhl-smart-money — ranking Hyperliquid by COPYABLE skill (top ${TOP})`);
console.log(`  filters: acct ≥$${(rank.minAccountValue / 1000).toFixed(0)}k · month vlm ≥$${(rank.minMonthVlm / 1000).toFixed(0)}k · turnover ≤${rank.maxTurnover}× (excludes HFT/MM) · sustained winner\n`);

const rows = parseLeaderboard(await jget(LB));
const ranked = rankWallets(rows, rank).slice(0, TOP);
console.log(`  scanned ${rows.length} wallets → ${ranked.length} copyable candidates\n`);

// pull live positions + fills for each top wallet
const positions: WalletPosition[] = [];
type Card = { addr: string; acctLive: number; monthRoi: number; consistency: number; style: string; realizedPnl: number; pf: number; verified: boolean; topPos: string };
const cards: Card[] = [];
for (const w of ranked) {
  try {
    const st = await info({ type: "clearinghouseState", user: w.address });
    const acctLive = Number(st?.marginSummary?.accountValue ?? 0);
    const aps = (st?.assetPositions ?? []) as Array<{ position: { coin: string; szi: string; positionValue?: string; entryPx?: string; unrealizedPnl?: string } }>;
    const posList = aps.map((a) => ({ coin: a.position.coin, szi: Number(a.position.szi), notionalUsd: Number(a.position.positionValue ?? Math.abs(Number(a.position.szi)) * Number(a.position.entryPx ?? 0)) }));
    for (const p of posList) positions.push({ wallet: w.address, coin: p.coin, szi: p.szi, notionalUsd: p.notionalUsd, accountValue: acctLive });
    const fills = ((await info({ type: "userFills", user: w.address })) as Array<Record<string, unknown>>).map((f) => ({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), closedPnl: Number(f.closedPnl ?? 0), time: Number(f.time) } as Fill));
    const style = fillStyleProfile(fills), rs = realizedStats(fills);
    const top = posList.sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
    cards.push({ addr: w.address, acctLive, monthRoi: w.month.roi, consistency: w.consistency, style: style.classification, realizedPnl: rs.realizedPnl, pf: rs.profitFactor, verified: isVerifiedProfitable(rs), topPos: top ? `${top.szi >= 0 ? "L" : "S"} ${top.coin} $${(top.notionalUsd / 1000).toFixed(0)}k` : "flat" });
    await new Promise((r) => setTimeout(r, 60));
  } catch { /* skip wallet */ }
}

console.log(`  ${"wallet".padEnd(13)} ${"acct".padEnd(7)} ${"moROI".padEnd(6)} ${"realizedPnL".padEnd(12)} ${"PF".padEnd(6)} ${"verified".padEnd(9)} ${"style".padEnd(24)} top`);
for (const c of cards) {
  const pf = c.pf === Infinity ? "∞" : c.pf.toFixed(2);
  console.log(`  ${(c.addr.slice(0, 10) + "…").padEnd(13)} ${`$${(c.acctLive / 1000).toFixed(0)}k`.padEnd(7)} ${`${(c.monthRoi * 100).toFixed(0)}%`.padEnd(6)} ${`$${(c.realizedPnl / 1000).toFixed(1)}k`.padEnd(12)} ${pf.padEnd(6)} ${(c.verified ? "✓ real" : "✗ fake").padEnd(9)} ${c.style.padEnd(24)} ${c.topPos}`);
}

// smart-money consensus — ONLY copyable (non-scalper) AND realized-profitable (verified by own fills) wallets vote.
const copyablePositions = positions.filter((p) => {
  const card = cards.find((c) => c.addr === p.wallet);
  return card && !card.style.includes("scalper") && card.verified;
});
const consensus = positionConsensus(copyablePositions).filter((c) => c.longWallets + c.shortWallets >= 2).slice(0, 12);
console.log(`\n  ── SMART-MONEY CONSENSUS (VERIFIED-profitable + copyable wallets only, ≥2 per coin) ──`);
if (!consensus.length) console.log(`    no coin has ≥2 verified-profitable copyable wallets positioned the same way right now.`);
for (const c of consensus) console.log(`    ${c.coin.padEnd(8)} ${c.bias.toUpperCase().padEnd(5)} net $${(c.netNotional / 1000).toFixed(0)}k  (${c.longWallets}L / ${c.shortWallets}S, gross $${(c.grossNotional / 1000).toFixed(0)}k)`);
console.log(`\n  ⚠ intelligence only, NOT auto-copy. Bias: the rank is survivorship-selected; size tiny, verify each wallet's`);
console.log(`    style + drawdown before following, and remember a consistent past ≠ a guaranteed future.\n`);
