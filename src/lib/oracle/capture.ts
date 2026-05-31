/**
 * Oracle snapshot capture — gather the independent price sources HFT-work CAN
 * reach (Coinbase ticker mid, OKX candle close, CoinDesk spot, Chainlink onchain)
 * and persist the agreement score + Chainlink update-age per crypto asset. This
 * is the data the polymarket-2dollar-bot couldn't capture (geo-blocked Binance +
 * public-RPC 401); run it on the snapshot cadence so the oracle/spot-agreement
 * (#2) and Chainlink-update-age (#1) strategies become measurable.
 *
 * Each source is best-effort (null on failure); rows land in oracle_snapshots.
 */
import { cb } from "@/lib/coinbase/client";
import { okx } from "@/lib/okx/client";
import { coindesk } from "@/lib/coindesk/client";
import { db } from "@/lib/db/client";
import { oracleAgreement, stalenessZone } from "./agreement";
import { chainlinkLatestRound } from "./chainlink";

async function coinbaseSpot(asset: string): Promise<number | null> {
  try {
    const t = await cb.getMarketTrades(`${asset}-USD`, { limit: 1 });
    const bid = Number(t.best_bid), ask = Number(t.best_ask);
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  } catch {
    return null;
  }
}

async function okxSpot(asset: string): Promise<number | null> {
  try {
    const c = await okx.publicGetCandles(`${asset}-USDT`, { limit: 1 });
    return c.length ? c[c.length - 1].close : null;
  } catch {
    return null;
  }
}

async function coindeskSpot(asset: string): Promise<number | null> {
  try {
    const r = await coindesk.price(asset, ["USD"]);
    return r && typeof r.USD === "number" ? r.USD : null;
  } catch {
    return null;
  }
}

export type OracleSnapshot = {
  asset: string;
  captured_at: number; // unix seconds
  coinbase: number | null;
  okx: number | null;
  coindesk: number | null;
  chainlink: number | null;
  agreement_score: number;
  side_agree: boolean;
  n_sources: number;
  chainlink_update_age: number | null;
  chainlink_zone: string | null;
};

/** Capture one asset's oracle snapshot (no DB write). priceToBeat optional → the
 *  side-agreement check is skipped when absent (snapshot cadence has no window). */
export async function captureOracle(
  asset: string,
  priceToBeat?: number | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<OracleSnapshot> {
  const [coinbase, okxp, coindeskp, cl] = await Promise.all([
    coinbaseSpot(asset),
    okxSpot(asset),
    coindeskSpot(asset),
    chainlinkLatestRound(asset),
  ]);
  const ag = oracleAgreement(
    { coinbase, okx: okxp, coindesk: coindeskp, chainlink: cl?.price ?? null },
    { priceToBeat },
  );
  const age = cl ? Math.max(0, nowSec - cl.updatedAt) : null;
  return {
    asset: asset.toUpperCase(),
    captured_at: nowSec,
    coinbase,
    okx: okxp,
    coindesk: coindeskp,
    chainlink: cl?.price ?? null,
    agreement_score: ag.score,
    side_agree: ag.sideAgree,
    n_sources: ag.nSources,
    chainlink_update_age: age,
    chainlink_zone: age != null ? stalenessZone(age) : null,
  };
}

const INSERT_SQL = `INSERT INTO oracle_snapshots
  (asset, captured_at, coinbase, okx, coindesk, chainlink, agreement_score, side_agree, n_sources, chainlink_update_age, chainlink_zone)
  VALUES (@asset, @captured_at, @coinbase, @okx, @coindesk, @chainlink, @agreement_score, @side_agree, @n_sources, @chainlink_update_age, @chainlink_zone)`;

/** Capture + persist oracle snapshots for a set of assets. Defaults to the
 *  ARENA_SNAPSHOT_CB_PRODUCTS bases (e.g. BTC,ETH,SOL). Best-effort end-to-end. */
export async function captureOracleSnapshots(
  assets?: string[],
): Promise<{ written: number; rows: OracleSnapshot[] }> {
  const list =
    assets ??
    (process.env.ARENA_SNAPSHOT_CB_PRODUCTS ?? "BTC-USD,ETH-USD,SOL-USD")
      .split(",")
      .map((s) => s.split("-")[0].trim().toUpperCase())
      .filter(Boolean);
  const rows: OracleSnapshot[] = [];
  for (const a of list) {
    try {
      rows.push(await captureOracle(a));
    } catch {
      /* skip this asset */
    }
  }
  let written = 0;
  try {
    const stmt = db().prepare(INSERT_SQL);
    const tx = db().transaction((batch: OracleSnapshot[]) => {
      for (const r of batch) {
        stmt.run({ ...r, side_agree: r.side_agree ? 1 : 0 });
        written++;
      }
    });
    tx(rows);
  } catch {
    /* DB unavailable → return the rows anyway (caller may log) */
  }
  return { written, rows };
}
