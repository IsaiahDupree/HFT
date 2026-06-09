/**
 * hl-move-watch — "detect a tracked wallet making a move, and copy it live" — done honestly. Polls each
 * copyable wallet's live positions, diffs against the last poll into discrete moves (open/increase/reduce/
 * close/flip), and for each move emits a copy signal GATED by the wallet's measured edge:
 *   • trade-copy   → 🟢 MIRROR NOW (the thesis plays out over hours; your 60s lag is nothing)
 *   • position-copy→ 🟡 adjust the NET book soon
 *   • HFT/scalper  → 🔴 SUPPRESSED with the latency-trap reason (its fill is public only after the edge is spent)
 * Dry-run: prints signals, never sends an order. Stateful (persists last positions) so it works as a cron OR as
 * a live loop (--watch). detection lag is the REAL elapsed time since the prior poll, fed into the alpha gate.
 *
 *   npm run hl:move-watch                       # one poll: grade moves since last run, save state
 *   npm run hl:move-watch -- --watch --interval 60   # live loop, poll every 60s
 *   npm run hl:move-watch -- --include-hft       # also watch un-copyable wallets (to SEE them get suppressed)
 *   npm run hl:move-watch -- --wallets 0xabc,0xdef
 */
import "./_env.ts";
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openWalletDb } from "../src/lib/exec/wallet-store.ts";
import { detectMoves, copySignal, type Position } from "../src/lib/exec/move-detector.ts";
import type { CopyMode } from "../src/lib/exec/strategy-profile.ts";

const has = (f: string) => process.argv.includes(f);
const str = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const WATCH = has("--watch"), INTERVAL = Number(str("--interval") ?? 60), INCLUDE_HFT = has("--include-hft");
const MIN_DELTA = Number(str("--min-delta") ?? 1_000);
const INFO = "https://api.hyperliquid.xyz/info";
const DB_PATH = process.env.MOVEWATCH_DB_PATH ?? (existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/hl-move-watch.db" : resolve(process.cwd(), "data", "hl-move-watch.db"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1000 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS move_state (wallet TEXT PRIMARY KEY, ts INTEGER, positions TEXT);
CREATE TABLE IF NOT EXISTS move_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, iso TEXT, wallet TEXT, coin TEXT, type TEXT, side TEXT, delta_usd REAL, copy_mode TEXT, actionable INTEGER, urgency TEXT, reason TEXT);`);
const getState = db.prepare("SELECT ts, positions FROM move_state WHERE wallet = ?");
const setState = db.prepare("INSERT INTO move_state (wallet,ts,positions) VALUES (?,?,?) ON CONFLICT(wallet) DO UPDATE SET ts=excluded.ts, positions=excluded.positions");
const logMove = db.prepare("INSERT INTO move_log (ts,iso,wallet,coin,type,side,delta_usd,copy_mode,actionable,urgency,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)");

type Tracked = { address: string; copyMode: CopyMode; medianHoldMs: number; verified: boolean };
const ws = openWalletDb();
const override = str("--wallets");
const tracked: Tracked[] = override
  ? override.split(",").map((s) => ({ address: s.trim().toLowerCase(), copyMode: "trade-copy" as CopyMode, medianHoldMs: 8 * 3_600_000, verified: true }))
  : ws.latest()
      .filter((s) => INCLUDE_HFT || s.copyMode !== "none")
      .map((s) => ({ address: s.address, copyMode: (s.copyMode || "none") as CopyMode, medianHoldMs: s.medianHoldMs || 8 * 3_600_000, verified: !!s.verified }));
ws.close();

const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${(Math.abs(n) / 1000).toFixed(0)}k`;
const ICON = { now: "🟢 MIRROR NOW", soon: "🟡 net-book soon", none: "🔴 suppressed" } as const;

async function poll(): Promise<void> {
  const now = Date.now(), iso = new Date(now).toISOString();
  let moves = 0, actionable = 0, trapped = 0, unproven = 0, firstSeen = 0;
  for (const t of tracked) {
    try {
      const st = await info({ type: "clearinghouseState", user: t.address });
      const cur: Position[] = ((st?.assetPositions ?? []) as Array<{ position: { coin: string; szi: string; positionValue?: string } }>)
        .map((a) => ({ coin: a.position.coin, notionalUsd: Number(a.position.szi) >= 0 ? Number(a.position.positionValue ?? 0) : -Number(a.position.positionValue ?? 0) }))
        .filter((p) => p.notionalUsd !== 0);
      const prior = getState.get(t.address) as { ts: number; positions: string } | undefined;
      setState.run(t.address, now, JSON.stringify(cur));
      if (!prior) { firstSeen++; continue; }
      const lag = now - prior.ts;
      for (const mv of detectMoves(JSON.parse(prior.positions), cur, MIN_DELTA)) {
        const sig = copySignal(mv, t.copyMode, t.medianHoldMs, lag);
        moves++;
        // TWO gates: copyMode (can you mechanically mirror it?) AND verified (does the wallet actually make money?).
        // A copyable-but-unproven wallet is WATCH-only — never "act" — so we don't mistake mirrorability for edge.
        const act = sig.actionable && t.verified;
        const icon = sig.actionable && !t.verified ? "⚪ WATCH (unproven)" : ICON[sig.urgency];
        const note = sig.actionable && !t.verified ? `${sig.reason} · BUT wallet not verified-profitable — paper only, no capital` : sig.reason;
        if (act) actionable++; else if (sig.actionable && !t.verified) unproven++; if (sig.latencyTrap) trapped++;
        logMove.run(now, iso, t.address, mv.coin, mv.type, mv.side, mv.deltaUsd, t.copyMode, act ? 1 : 0, sig.urgency, note);
        console.log(`  ${icon}  ${t.address.slice(0, 10)}…  ${mv.type.toUpperCase()} ${mv.coin} ${mv.side} ${usd(mv.deltaUsd)}  [${t.copyMode}${t.verified ? " ✓" : ""}]  — ${note}`);
      }
      await sleep(35);
    } catch { /* skip */ }
  }
  const line = `[${iso.slice(11, 19)}] ${tracked.length} wallets · ${moves} moves · ${actionable} actionable(verified) · ${unproven} watch(unproven) · ${trapped} HFT-suppressed${firstSeen ? ` · ${firstSeen} baselined` : ""}`;
  console.log(moves ? `  ${"-".repeat(4)}\n  ${line}\n` : `  ${line}`);
}

console.log(`\nhl-move-watch — ${tracked.length} tracked wallets (${INCLUDE_HFT ? "incl. HFT, suppressed" : "copyable only"}) · DB ${DB_PATH}\n`);
if (!tracked.length) { console.log("  no tracked wallets — run `npm run hl:wallet-track` first.\n"); db.close(); }
else if (WATCH) {
  console.log(`  live loop every ${INTERVAL}s — Ctrl-C to stop. First pass baselines positions.\n`);
  for (;;) { await poll(); await sleep(INTERVAL * 1000); }
} else { await poll(); console.log(`\n  one poll done. Run again (or --watch) to detect moves since this snapshot.\n`); db.close(); }
