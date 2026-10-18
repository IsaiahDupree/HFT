/**
 * GET /api/polymarket/account-status
 *
 * Lightweight summary that powers the top-bar PolymarketStatusBar component.
 * Returns:
 *   - On-chain Polygon balances at POLYMARKET_FUNDER_ADDRESS (USDC.e, native
 *     USDC, MATIC for gas)
 *   - Polymarket data-API portfolio value (positions notional + cash)
 *   - Live capsules with their bound paper-agent names + last-known signal
 *   - Last live-trade event from evolution_log (so the bar can show "fired
 *     2m ago" or "rejected 30s ago")
 *
 * Read-only. Designed to be polled every 15-30s.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import {
  readPolygonBalances, POLYGON_USDC_E, POLYGON_USDC_NATIVE,
} from "@/lib/polymarket/deposit";
import { poly } from "@/lib/polymarket/client";

export const dynamic = "force-dynamic";

type CapsuleSummary = {
  capsule_id: string;
  capsule_name: string;
  status: string;
  is_auto: boolean;             // true if created by runAutoPromote (name starts with 'auto-live-')
  capital_available_usd: number;
  capital_allocated_usd: number;
  daily_pnl_usd: number;
  current_pnl_usd: number;
  agent_id: number | null;
  agent_name: string | null;
  agent_alive: boolean;
  agent_kind: string | null;
  open_positions: number;
  last_action_at: string | null;
  last_action_summary: string | null;
};

export async function GET() {
  const funder = process.env.POLYMARKET_FUNDER_ADDRESS;
  if (!funder) {
    return NextResponse.json({ error: "POLYMARKET_FUNDER_ADDRESS not set" }, { status: 400 });
  }

  // Run the cheap DB queries first (synchronous), then await the on-chain read.
  const capsules = db().prepare(
    `SELECT c.id AS capsule_id, c.name AS capsule_name, c.status,
            c.capital_available_usd, c.capital_allocated_usd,
            c.daily_pnl_usd, c.current_pnl_usd, c.open_positions,
            c.paper_agent_id AS agent_id,
            pa.name AS agent_name, pa.alive AS agent_alive,
            json_extract(pa.genome_json, '$.kind') AS agent_kind
       FROM capsules c
       LEFT JOIN paper_agents pa ON pa.id = c.paper_agent_id
      WHERE c.status IN ('paper', 'live', 'paused')
      ORDER BY c.activated_at DESC NULLS LAST`,
  ).all() as Array<{
    capsule_id: string; capsule_name: string; status: string;
    capital_available_usd: number; capital_allocated_usd: number;
    daily_pnl_usd: number; current_pnl_usd: number; open_positions: number;
    agent_id: number | null; agent_name: string | null;
    agent_alive: 0 | 1 | null; agent_kind: string | null;
  }>;

  // For each capsule, pull the most recent live-router or single-side event for context.
  const capsuleRows: CapsuleSummary[] = capsules.map((c) => {
    const lastAction = c.capsule_id ? db().prepare(
      `SELECT created_at, event_type, summary FROM evolution_log
         WHERE (event_type LIKE 'live-capsule-%' OR event_type LIKE 'single-%')
           AND summary LIKE ?
         ORDER BY id DESC LIMIT 1`,
    ).get('%' + c.capsule_id.slice(0, 8) + '%') as { created_at: string; event_type: string; summary: string } | undefined : undefined;
    return {
      capsule_id: c.capsule_id,
      capsule_name: c.capsule_name,
      is_auto: (c.capsule_name ?? "").startsWith("auto-live-"),
      status: c.status,
      capital_available_usd: c.capital_available_usd,
      capital_allocated_usd: c.capital_allocated_usd,
      daily_pnl_usd: c.daily_pnl_usd,
      current_pnl_usd: c.current_pnl_usd,
      agent_id: c.agent_id,
      agent_name: c.agent_name,
      agent_alive: c.agent_alive === 1,
      agent_kind: c.agent_kind,
      open_positions: c.open_positions,
      last_action_at: lastAction?.created_at ?? null,
      last_action_summary: lastAction
        ? `${lastAction.event_type.replace(/^(live-capsule|single)-/, "")}: ${lastAction.summary.slice(0, 80)}`
        : null,
    };
  });

  // Polymarket portfolio value via the data API (positions notional). Falls
  // back to 0 on error so the UI never crashes.
  let portfolioValueUsd = 0;
  try {
    // Route through Webshare proxy — data-api.polymarket.com is geo-restricted.
    const { polyFetch } = await import("@/lib/polymarket/proxy-routing");
    const r = await polyFetch(`https://data-api.polymarket.com/value?user=${funder.toLowerCase()}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      const data = (await r.json()) as Array<{ user: string; value: number }>;
      portfolioValueUsd = data[0]?.value ?? 0;
    }
  } catch {
    // swallow — the rest of the response is still useful
  }

  // CLOB-recognized collateral balance — the AUTHORITATIVE value for "money
  // I can trade with". On-chain proxy balance is misleading because Polymarket
  // auto-routes deposits into their CTF Exchange (you see balanceOf(proxy) = 0
  // even though Polymarket sees the collateral). Wrap in try/catch — the
  // endpoint can 401 if auth headers don't match exactly.
  let clobCollateralUsd: number | null = null;
  let clobOpenOrdersCount: number | null = null;
  try {
    const orders = await poly.myOpenOrders();
    if (Array.isArray(orders)) clobOpenOrdersCount = orders.length;
  } catch { /* leave null */ }
  // Try a few balance endpoints — the right shape depends on signature type.
  for (const path of [
    `/balance-allowance?asset_type=COLLATERAL&signature_type=1`,
    `/balance-allowance?asset_type=COLLATERAL`,
  ]) {
    try {
      const r = await poly.clobAuthGet(path) as { balance?: string; allowance?: string };
      if (r?.balance != null) {
        // CLOB returns balance in 6-decimal USDC units as string
        clobCollateralUsd = Number(r.balance) / 1e6;
        break;
      }
    } catch { /* try next */ }
  }

  // Polygon on-chain balances at the proxy (this is the authoritative source
  // for "do I have funds the bot can trade with").
  const balances = await readPolygonBalances(funder);

  // env-derived caps (for the UI header)
  const allowTrade = process.env.ALLOW_TRADE === "1";
  const maxTrade = Number(process.env.MAX_TRADE_USD ?? "5");
  const maxDaily = Number(process.env.MAX_DAILY_USD ?? "15");

  return NextResponse.json({
    funder,
    balances: {
      usdc_e: balances.usdc_e,
      usdc_native: balances.usdc_native,
      matic: balances.matic,
    },
    /** Authoritative trading balance — what Polymarket sees, including any
     *  funds auto-routed into the CTF Exchange. null if the auth path failed. */
    clob_collateral_usd: clobCollateralUsd,
    clob_open_orders: clobOpenOrdersCount,
    portfolio_value_usd: portfolioValueUsd,
    capsules: capsuleRows,
    safety: {
      allow_trade: allowTrade,
      max_trade_usd: maxTrade,
      max_daily_usd: maxDaily,
    },
    tokens: {
      usdc_e: POLYGON_USDC_E,
      usdc_native: POLYGON_USDC_NATIVE,
    },
    fetched_at: new Date().toISOString(),
  });
}
