import { NextResponse } from "next/server";
import { safety as pmSafety } from "@/lib/polymarket/execute";
import { cbSafety } from "@/lib/coinbase/execute";
import { authIsAvailable as cbAuthAvailable } from "@/lib/coinbase/auth";

function polyAuthAvailable(): boolean {
  return Boolean(process.env.POLYMARKET_PRIVATE_KEY);
}
import { getDefaultKillSwitch } from "@/lib/risk/kill-switch";
import { getDefaultRouter } from "@/lib/venue/router";
import { getMarketFreshness } from "@/lib/arena/snapshot";
import { listCapsules } from "@/lib/capsules/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/safety/snapshot — single source of truth for the safety dashboard.
 * Aggregates every gate's current state. No mutations. Always safe to call.
 */
export async function GET() {
  // Force adapter registration so kill-switch state reflects every venue.
  getDefaultRouter();
  const ks = getDefaultKillSwitch();

  const polyMode = pmSafety.mode();
  const cbMode = cbSafety.mode();

  // Activation-gate config (env-driven, read-only here).
  const activation = {
    window_days: Number(process.env.ARENA_ACTIVATE_WINDOW_DAYS ?? "14"),
    min_pnl_pct: Number(process.env.ARENA_ACTIVATE_MIN_PNL_PCT ?? "-0.02"),
    max_dd_pct: Number(process.env.ARENA_ACTIVATE_MAX_DD_PCT ?? "0.25"),
    default_bypass: false,
  };

  const fresh = getMarketFreshness({ staleSeconds: 600 });
  const capsules = listCapsules();

  return NextResponse.json({
    polymarket: {
      auth_available: polyAuthAvailable(),
      mode: polyMode,
      max_trade_usd: pmSafety.maxTrade(),
      max_daily_usd: pmSafety.maxDaily(),
      daily_executed_usd: pmSafety.dailyExecutedUsd(),
    },
    coinbase: {
      auth_available: tryBool(cbAuthAvailable),
      mode: cbMode,
      max_trade_usd: cbSafety.maxTrade(),
      max_daily_usd: cbSafety.maxDaily(),
      daily_executed_usd: cbSafety.dailyExecutedUsd(),
    },
    risk_engine: {
      halted: ks.riskEngine.isHalted(),
      halt_reason: ks.riskEngine.getHaltReason(),
      limits: ks.riskEngine.getLimits(),
      last_rejection: ks.riskEngine.getLastRejection(),
    },
    kill_switch: {
      state: ks.getState(),
      registered_brokers: ks.getRegisteredBrokers(),
    },
    activation_gate: activation,
    arena_mutation_mode: (process.env.ARENA_MUTATION_MODE ?? "programmatic").toLowerCase(),
    arena_evolve_every: Number(process.env.ARENA_EVOLVE_EVERY ?? "50"),
    capsules: {
      total: capsules.length,
      by_status: capsules.reduce((acc, c) => { acc[c.status] = (acc[c.status] ?? 0) + 1; return acc; }, {} as Record<string, number>),
    },
    market_freshness: {
      total: fresh.length,
      stale: fresh.filter((f) => f.is_stale).length,
      newest_age_seconds: fresh.length > 0 ? Math.min(...fresh.map((f) => f.age_seconds)) : null,
      oldest_age_seconds: fresh.length > 0 ? Math.max(...fresh.map((f) => f.age_seconds)) : null,
    },
  });
}

function tryBool(fn: () => boolean): boolean {
  try { return fn(); } catch { return false; }
}
