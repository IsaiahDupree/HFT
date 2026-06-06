/**
 * smart-money — find COPYABLE skill on Hyperliquid's fully-transparent order flow, not just the biggest PnL.
 * The leaderboard's top-by-PnL is dominated by whales and HFT market-makers (flat, 2000 scalp fills, $20/trade)
 * that you provably cannot replicate. Same discipline as the carry work: don't chase one fat number — require
 * CONSISTENCY (winner across week+month+allTime, not one lucky day), SKIN IN THE GAME (account value), and
 * COPYABILITY (filter out the extreme-turnover MMs whose edge is latency, not direction). Then aggregate the
 * survivors' LIVE positions into a "smart-money consensus" signal, and profile a wallet's fills to tell a
 * copyable swing trader from an un-copyable scalper. Pure + deterministic; the script does the I/O.
 */

export type PerfWindow = { pnl: number; roi: number; vlm: number };
export type LeaderboardRow = { address: string; displayName: string; accountValue: number; day: PerfWindow; week: PerfWindow; month: PerfWindow; allTime: PerfWindow };

const W = (w: unknown): PerfWindow => { const o = (w ?? {}) as Record<string, string>; return { pnl: Number(o.pnl ?? 0), roi: Number(o.roi ?? 0), vlm: Number(o.vlm ?? 0) }; };

/** Parse the raw Hyperliquid leaderboard payload into typed rows. */
export function parseLeaderboard(raw: unknown): LeaderboardRow[] {
  const rows = (raw as { leaderboardRows?: unknown[] })?.leaderboardRows ?? (Array.isArray(raw) ? raw : []);
  return (rows as Array<Record<string, unknown>>).map((r) => {
    const wins = new Map((r.windowPerformances as Array<[string, unknown]> ?? []).map(([k, v]) => [k, v]));
    return {
      address: String(r.ethAddress ?? ""), displayName: String(r.displayName ?? ""), accountValue: Number(r.accountValue ?? 0),
      day: W(wins.get("day")), week: W(wins.get("week")), month: W(wins.get("month")), allTime: W(wins.get("allTime")),
    };
  }).filter((r) => r.address);
}

export type RankOpts = {
  minAccountValue: number;   // skin in the game (filter dust)
  minMonthVlm: number;       // must be actively trading
  maxTurnover: number;       // monthVlm / accountValue — above this ⇒ HFT/MM (edge is latency, not copyable)
  minMonthRoi: number;       // recent profitability (%)
  minMonthPnl: number;       // recent profitability in DOLLARS — kills tiny-base ROI% explosions (200000% on $100)
};
export const DEFAULT_RANK: RankOpts = { minAccountValue: 25_000, minMonthVlm: 250_000, maxTurnover: 300, minMonthRoi: 0, minMonthPnl: 5_000 };

export type WalletScore = LeaderboardRow & { score: number; turnover: number; consistency: number };

/**
 * Rank wallets by COPYABLE skill. Filters dust / inactive / likely-MM, requires a sustained winner, and scores
 * by a blend of all-time and recent ROI. `consistency` = fraction of the 4 windows that are profitable.
 */
export function rankWallets(rows: readonly LeaderboardRow[], opts: RankOpts = DEFAULT_RANK): WalletScore[] {
  const out: WalletScore[] = [];
  for (const r of rows) {
    const turnover = r.accountValue > 0 ? r.month.vlm / r.accountValue : Infinity;
    if (r.accountValue < opts.minAccountValue) continue;
    if (r.month.vlm < opts.minMonthVlm) continue;
    if (turnover > opts.maxTurnover) continue;                       // exclude HFT/MM (un-copyable)
    if (r.month.roi < opts.minMonthRoi || r.allTime.roi <= 0) continue; // sustained + recent winner only
    if (r.month.pnl < opts.minMonthPnl || r.allTime.pnl <= 0) continue; // REAL dollars, not tiny-base ROI% noise
    const consistency = [r.day, r.week, r.month, r.allTime].filter((w) => w.roi > 0).length / 4;
    const score = 0.5 * r.allTime.roi + 0.5 * r.month.roi;           // sustained skill + recent form
    out.push({ ...r, score, turnover, consistency });
  }
  return out.sort((a, b) => b.consistency - a.consistency || b.score - a.score);
}

export type WalletPosition = { wallet: string; coin: string; szi: number; notionalUsd: number; accountValue: number };
export type CoinConsensus = { coin: string; netNotional: number; longWallets: number; shortWallets: number; grossNotional: number; bias: "long" | "short" | "flat" };

/** Aggregate the live positions of the ranked wallets into a per-coin smart-money consensus signal. */
export function positionConsensus(positions: readonly WalletPosition[]): CoinConsensus[] {
  const m = new Map<string, { net: number; gross: number; lo: number; sh: number }>();
  for (const p of positions) {
    const e = m.get(p.coin) ?? { net: 0, gross: 0, lo: 0, sh: 0 };
    e.net += p.notionalUsd * Math.sign(p.szi); e.gross += Math.abs(p.notionalUsd);
    if (p.szi > 0) e.lo++; else if (p.szi < 0) e.sh++;
    m.set(p.coin, e);
  }
  return [...m.entries()].map(([coin, e]) => ({
    coin, netNotional: e.net, grossNotional: e.gross, longWallets: e.lo, shortWallets: e.sh,
    bias: e.net > 0 ? "long" : e.net < 0 ? "short" : "flat",
  })).sort((a, b) => Math.abs(b.netNotional) - Math.abs(a.netNotional));
}

export type Fill = { coin: string; dir: string; sz: number; px: number; closedPnl: number; time: number };

export type RealizedStats = { nClosed: number; realizedPnl: number; winRate: number; profitFactor: number };
/**
 * VERIFY a wallet against its OWN realized fills — the leaderboard's ROI rank is not the same as profitable
 * trading. A high win rate can hide negative expectancy (88% wins, profit-factor 0.54 = pennies-in-front-of-a-
 * steamroller). profitFactor = gross wins / gross losses; ≥1 means the closed trades actually net positive.
 */
export function realizedStats(fills: readonly Fill[]): RealizedStats {
  const closes = fills.filter((f) => /Close/i.test(f.dir)).map((f) => f.closedPnl).filter(Number.isFinite);
  const n = closes.length;
  if (!n) return { nClosed: 0, realizedPnl: 0, winRate: 0, profitFactor: 0 };
  const grossWin = closes.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(closes.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  return {
    nClosed: n, realizedPnl: closes.reduce((a, b) => a + b, 0), winRate: closes.filter((x) => x > 0).length / n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
  };
}

/** A wallet's vote counts ONLY if its own realized fills are genuinely profitable (net positive AND pf ≥ 1). */
export function isVerifiedProfitable(s: RealizedStats): boolean { return s.nClosed >= 10 && s.realizedPnl > 0 && s.profitFactor >= 1; }

export type Archetype = "market-maker" | "hft-scalper" | "directional-swing" | "position-trader" | "specialist" | "low-activity";
/**
 * Infer a wallet's STRATEGY archetype from its behavioral fingerprint — the label that "pins out" what it does.
 * Activity (trades/day) splits HFT/MM from swing from position; directionality (long-bias away from neutral)
 * splits a market-maker (neutral, high-activity) from a directional scalper; concentration flags specialists.
 */
export function walletArchetype(s: { tradesPerDay: number; longBias: number; topCoinShare: number }): Archetype {
  const directional = Math.abs(s.longBias - 0.5) > 0.25;
  if (s.tradesPerDay < 0.5) return "low-activity";
  if (s.topCoinShare >= 0.85 && s.tradesPerDay < 50) return "specialist";   // one-market focus, not pure HFT
  if (s.tradesPerDay >= 80) return directional ? "hft-scalper" : "market-maker";
  if (s.tradesPerDay >= 3) return "directional-swing";
  return "position-trader";
}
export type StyleProfile = { nFills: number; spanDays: number; tradesPerDay: number; topCoins: string[]; longBias: number; winRate: number; avgNotional: number; classification: "scalper/MM (un-copyable)" | "active swing" | "position trader" | "thin" };

/** Profile a wallet's fills to judge COPYABILITY — a sub-minute scalper can't be followed; a swing trader can. */
export function fillStyleProfile(fills: readonly Fill[]): StyleProfile {
  const n = fills.length;
  if (n < 5) return { nFills: n, spanDays: 0, tradesPerDay: 0, topCoins: [], longBias: 0.5, winRate: 0, avgNotional: 0, classification: "thin" };
  const times = fills.map((f) => f.time);
  const spanDays = Math.max((Math.max(...times) - Math.min(...times)) / 86_400_000, 1e-6);
  const tradesPerDay = n / spanDays;
  const coinCount = new Map<string, number>();
  let opens = 0, longOpens = 0, closes = 0, wins = 0, notional = 0;
  for (const f of fills) {
    coinCount.set(f.coin, (coinCount.get(f.coin) ?? 0) + 1);
    notional += Math.abs(f.sz * f.px);
    const isOpen = /Open/i.test(f.dir), isClose = /Close/i.test(f.dir);
    if (isOpen) { opens++; if (/Long/i.test(f.dir)) longOpens++; }
    if (isClose) { closes++; if (f.closedPnl > 0) wins++; }
  }
  const topCoins = [...coinCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
  const longBias = opens ? longOpens / opens : 0.5;
  const winRate = closes ? wins / closes : 0;
  const avgNotional = notional / n;
  const classification: StyleProfile["classification"] =
    tradesPerDay >= 50 ? "scalper/MM (un-copyable)" : tradesPerDay >= 3 ? "active swing" : "position trader";
  return { nFills: n, spanDays, tradesPerDay, topCoins, longBias, winRate, avgNotional, classification };
}
