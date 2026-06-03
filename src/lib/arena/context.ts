/**
 * TickContext builder — reads recent market_snapshots + coinbase_snapshots and
 * groups them into the per-market history windows the sim engine expects.
 *
 * Two callers:
 *   - `arena-tick` (live mode): pulls the latest tick row per market_id
 *   - `arena-replay` (replay mode): caller iterates `iterTickContexts` to walk
 *     a window of historical snapshots in tick order.
 */
import { db } from "@/lib/db/client";
import { enrichContextWithCrossVenue } from "./cross-venue";
import { latestRealtimeTicks } from "./realtime-ticks";
import type { Snapshot, SnapshotWindow, TickContext, Venue } from "./types";
import type { DecisionContext } from "@/lib/decision/types";

const DEFAULT_HISTORY_DAYS = 7;

/**
 * Build the decision-pipeline snapshot from a per-market SnapshotWindow — the SHARED
 * mapper used by BOTH the sim shadow-gate and the live-capsule path, so their regime /
 * data-quality / edge features are derived from IDENTICAL code (train/serve parity; the
 * fix for the F2 finding). `win.history` (oldest→newest) feeds the regime classifier;
 * `win.latest` bid/ask feed the spread / data-quality gates.
 */
export function snapshotFromWindow(win: SnapshotWindow, midPrice: number): NonNullable<DecisionContext["snapshot"]> {
  return {
    midPrice,
    bestBid: win.latest.bid,
    bestAsk: win.latest.ask,
    ticks: win.history.slice(-100).map((s) => {
      const t = Date.parse(s.captured_at);
      return { ts: Number.isFinite(t) ? Math.floor(t / 1000) : 0, price: s.price };
    }),
  };
}

function isoMinus(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Normalize SQLite's bare "YYYY-MM-DD HH:MM:SS" (which IS UTC under
 *  CURRENT_TIMESTAMP semantics) to a Z-suffixed ISO 8601 string so JS
 *  `new Date(...)` parses it as UTC instead of local time. Without this,
 *  every `new Date(captured_at).getTime()` downstream was off by the
 *  user's local-TZ offset. The fix: replace the space separator with 'T'
 *  and append 'Z'. Already-ISO inputs are passed through unchanged.
 *  Bug-fix 2026-05-26 (bug #10). */
function toIsoZ(s: string): string {
  if (!s) return s;
  if (s.endsWith("Z")) return s;
  if (s.includes("T")) return s.endsWith("Z") ? s : s + "Z";
  return s.replace(" ", "T") + "Z";
}

function loadPolySnapshots(sinceIso: string): Snapshot[] {
  // Use SQLite's datetime() to normalize the input bound so it compares
  // correctly against captured_at (which is stored as bare UTC text).
  return (db().prepare(
    `SELECT token_id AS market_id, midpoint AS price, yes_price, no_price, spread, category, captured_at
       FROM market_snapshots WHERE captured_at >= datetime(?) AND midpoint IS NOT NULL`,
  ).all(sinceIso) as any[]).map((r): Snapshot => ({
    venue: "sim-poly" as Venue, market_id: r.market_id,
    price: Number(r.price ?? 0), captured_at: toIsoZ(r.captured_at),
    category: r.category ?? undefined,
  }));
}

function loadCbSnapshots(sinceIso: string): Snapshot[] {
  return (db().prepare(
    `SELECT product_id AS market_id, midpoint AS price, best_bid, best_ask, captured_at
       FROM coinbase_snapshots WHERE captured_at >= datetime(?) AND midpoint IS NOT NULL`,
  ).all(sinceIso) as any[]).map((r): Snapshot => ({
    venue: "sim-coinbase" as Venue, market_id: r.market_id,
    price: Number(r.price ?? 0),
    bid: r.best_bid != null ? Number(r.best_bid) : undefined,
    ask: r.best_ask != null ? Number(r.best_ask) : undefined,
    captured_at: toIsoZ(r.captured_at),
  }));
}

function group(snaps: Snapshot[]): Map<string, Snapshot[]> {
  const out = new Map<string, Snapshot[]>();
  for (const s of snaps) {
    if (!out.has(s.market_id)) out.set(s.market_id, []);
    out.get(s.market_id)!.push(s);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  return out;
}

/** Build a live TickContext using the most recent snapshot per market. WS
 *  realtime ticks (last 90s) override the `latest.price` for matching CB
 *  products — history stays from REST snapshots, only the "now" price gets
 *  the sub-minute freshness boost. PRD §6.3.L3 + Phase 7. */
export function buildLiveTickContext(opts: { historyDays?: number; enrichCrossVenue?: boolean; wsMaxAgeSec?: number } = {}): TickContext {
  const sinceIso = isoMinus(opts.historyDays ?? DEFAULT_HISTORY_DAYS);
  const allSnaps = [...loadPolySnapshots(sinceIso), ...loadCbSnapshots(sinceIso)];
  const grouped = group(allSnaps);
  const windows = new Map<string, SnapshotWindow>();
  for (const [mid, arr] of grouped) {
    windows.set(mid, { history: arr, latest: arr[arr.length - 1] });
  }
  // Override `latest.price` with the freshest WS tick when one exists for the
  // product. History remains unchanged — we don't pollute it with WS data.
  const fresh = latestRealtimeTicks(opts.wsMaxAgeSec ?? 90);
  for (const [productId, tick] of fresh) {
    const win = windows.get(productId);
    if (!win) continue;
    const overridden: Snapshot = {
      ...win.latest,
      price: tick.price,
      captured_at: new Date(tick.ts_unix * 1000).toISOString(),
    };
    windows.set(productId, { history: win.history, latest: overridden });
  }
  const ctx: TickContext = { now: new Date().toISOString(), snapshots: windows };
  if (opts.enrichCrossVenue !== false) enrichContextWithCrossVenue(ctx);
  return ctx;
}

/**
 * Yield one TickContext per simulated tick over the [start, end] window. Each
 * tick treats `tickAt` as "now" and trims history to snapshots <= tickAt.
 *
 * `tickIntervalMin` controls how often we yield a context (typically 5).
 */
export function* iterTickContexts(opts: { start: string; end: string; tickIntervalMin: number; historyDays?: number }): Generator<TickContext, void, void> {
  const startMs = new Date(opts.start).getTime();
  const endMs = new Date(opts.end).getTime();
  const stepMs = opts.tickIntervalMin * 60_000;
  const lookbackDays = opts.historyDays ?? DEFAULT_HISTORY_DAYS;
  // Pull a single fat window once; trim per tick.
  const allSnaps = [
    ...loadPolySnapshots(new Date(startMs - lookbackDays * 86_400_000).toISOString()),
    ...loadCbSnapshots(new Date(startMs - lookbackDays * 86_400_000).toISOString()),
  ];
  const grouped = group(allSnaps);

  for (let tMs = startMs; tMs <= endMs; tMs += stepMs) {
    const nowIso = new Date(tMs).toISOString();
    const windows = new Map<string, SnapshotWindow>();
    for (const [mid, arr] of grouped) {
      const upto = arr.filter((s) => s.captured_at <= nowIso);
      if (upto.length === 0) continue;
      windows.set(mid, { history: upto, latest: upto[upto.length - 1] });
    }
    if (windows.size > 0) yield { now: nowIso, snapshots: windows };
  }
}
