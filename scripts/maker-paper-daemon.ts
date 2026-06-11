/**
 * maker-paper-daemon — the G2 forward track, made continuous (POLYMARKET-STACK-AUDIT §5).
 * The single-market paper maker proves the loop; the GATE needs ≥2 weeks of forward
 * paper across many markets. This daemon supplies that: it rolls from one BTC/ETH
 * Up/Down market to the next, unattended.
 *
 * Loop, forever:
 *   1. discover the soonest open BTC (or ETH) "Up or Down" market via Gamma
 *      (both the hourly series and the 15-minute series — the 15-min family is
 *      back as of 2026-06-10 and is the highest-delta venue we have),
 *   2. derive the STRIKE = the open of the market's candle, from the Binance 1m
 *      kline at the candle start (works for any series duration),
 *   3. run scripts/binary-maker-paper.ts on it until ~20s before expiry
 *      (--fv enhanced; every tick also snapshots the baseline → live model A/B),
 *   4. repeat. If no market is found, sleep and re-probe.
 *
 * PAPER ONLY: public data, no keys, no orders — same guarantees as the paper
 * script it wraps. Sessions accumulate in binary-maker-paper.db (passport);
 * judge the gate with maker:paper:report.
 *
 *   npx tsx scripts/maker-paper-daemon.ts -- --symbol BTC --min-tau-sec 240
 *
 * Scheduled by ~/Library/LaunchAgents/com.isaiahdupree.hft.makerpaper.plist
 * (KeepAlive — relaunches on crash; logs: /tmp/hft-makerpaper.log).
 */
import "./_env.ts";
import { spawn } from "node:child_process";
import { poly } from "../src/lib/polymarket/client.ts";
import { proxiedFetch } from "../src/lib/data/proxy-fetch.ts";
import { rangeDurationMinutes } from "../src/lib/strategies/updown-title.ts";

const flag = (n: string, d = ""): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const SYMBOL = flag("--symbol", "BTC").toUpperCase() as "BTC" | "ETH";
const MIN_TAU_SEC = Number(flag("--min-tau-sec", "240")); // skip markets about to expire
const STOP_BEFORE_SEC = Number(flag("--stop-before-sec", "20"));
const PROBE_SLEEP_SEC = Number(flag("--probe-sleep-sec", "45"));
const TICK_MS = flag("--tick-ms", "2000");

const NAME = SYMBOL === "BTC" ? "bitcoin" : "ethereum";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);

type Target = { question: string; tokenId: string; startMs: number; endMs: number };

// tokens whose session aborted STRIKE-SUSPECT — never re-enter (would loop until expiry)
const blacklisted = new Set<string>();

/** Soonest-expiring open Up/Down market for the symbol with τ ≥ MIN_TAU_SEC. */
async function discover(): Promise<Target | null> {
  const now = Date.now();
  let events: any[];
  try {
    events = await poly.events({
      limit: 200, closed: false,
      end_date_min: new Date(now).toISOString(),
      end_date_max: new Date(now + 3 * 3600e3).toISOString(),
      order: "endDate", ascending: true,
    });
  } catch (e) {
    log(`gamma discover failed: ${(e as Error).message.slice(0, 100)}`);
    return null;
  }

  for (const ev of events ?? []) {
    for (const m of ev?.markets ?? []) {
      const q: string = m?.question ?? "";
      if (!new RegExp(`${NAME}.*up or down`, "i").test(q) || m?.closed === true || m?.active === false) continue;
      const endMs = Date.parse(m?.endDate ?? "");
      if (!Number.isFinite(endMs) || endMs - now < MIN_TAU_SEC * 1000) continue;

      let tokenId = "";
      try {
        const ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
        tokenId = Array.isArray(ids) && ids[0] ? String(ids[0]) : "";
      } catch { /* skip */ }
      if (!tokenId || blacklisted.has(tokenId)) continue;

      // Candle start = endMs − the market's true duration, parsed from the title.
      // The Up/Down family runs THREE series at once (hourly "11PM ET", 15-min
      // "11:15PM-11:30PM ET", AND 5-min "11:30PM-11:35PM ET" — the 5-min series
      // is back as of 2026-06-10). Assuming a fixed duration derives the strike
      // from the WRONG candle — the bug that poisoned the first night of G2
      // sessions. Parse both range endpoints; skip what we can't parse.
      const durMin = rangeDurationMinutes(q);
      if (durMin === null) { log(`unparseable duration, skipping: "${q}"`); continue; }
      const startMs = endMs - durMin * 60e3;
      return { question: q, tokenId, startMs, endMs };
    }
  }
  return null;
}

/** STRIKE for an Up/Down market = the candle's open = the 1m kline open at startMs. */
async function candleOpen(startMs: number): Promise<number | null> {
  try {
    const r = await proxiedFetch(
      `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}USDT&interval=1m&startTime=${startMs}&limit=1`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const k = (await r.json()) as any[];
    const open = Number(k?.[0]?.[1]);
    // sanity: the returned kline must actually be the candle-start minute
    if (Number(k?.[0]?.[0]) !== startMs || !(open > 0)) return null;
    return open;
  } catch (e) {
    log(`kline open failed: ${(e as Error).message.slice(0, 100)}`);
    return null;
  }
}

function runPaper(t: Target, strike: number): Promise<number> {
  const seconds = Math.max(30, Math.floor((t.endMs - Date.now()) / 1000) - STOP_BEFORE_SEC);
  log(`session start: "${t.question}" strike ${strike} τ ${(seconds / 60).toFixed(1)}min token …${t.tokenId.slice(-8)}`);
  return new Promise((resolveP) => {
    const child = spawn(
      "npx",
      ["tsx", "scripts/binary-maker-paper.ts", "--token", t.tokenId, "--symbol", SYMBOL,
        "--strike", String(strike), "--expiry-iso", new Date(t.endMs).toISOString(),
        "--seconds", String(seconds), "--tick-ms", TICK_MS, "--fv", "enhanced",
        "--question", t.question, "--abort-divergence", "35"],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    const killer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* */ } }, (seconds + 90) * 1000);
    child.on("exit", (code) => { clearTimeout(killer); resolveP(code ?? 1); });
    child.on("error", () => { clearTimeout(killer); resolveP(1); });
  });
}

log(`maker-paper-daemon up — ${SYMBOL} Up/Down (hourly + 15min series), fv enhanced, PAPER ONLY`);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

while (!stopping) {
  const target = await discover();
  if (!target) {
    log(`no eligible ${SYMBOL} Up/Down market — sleeping ${PROBE_SLEEP_SEC}s`);
    await sleep(PROBE_SLEEP_SEC * 1000);
    continue;
  }
  // 5/15-min markets are listed BEFORE their candle opens — wait for the open
  // (that's also the ideal entry: the session covers the market's whole life).
  const untilOpenMs = target.startMs - Date.now();
  if (untilOpenMs > 0) {
    log(`waiting ${(untilOpenMs / 1000).toFixed(0)}s for candle open of "${target.question}"`);
    await sleep(untilOpenMs + 2_000);
  }
  const strike = await candleOpen(target.startMs);
  if (strike === null) {
    log(`strike unavailable for "${target.question}" — re-probing in 10s`);
    await sleep(10_000);
    continue;
  }
  const code = await runPaper(target, strike);
  if (code === 2) {
    blacklisted.add(target.tokenId);
    log(`session ABORTED strike-suspect — token blacklisted, skipping market`);
  } else {
    log(`session end (exit ${code})`);
  }
  await sleep(5_000); // breathe before the next probe
}
log("daemon stopped.");
