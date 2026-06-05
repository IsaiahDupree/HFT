/**
 * binance — full Binance adapter over the per-host proxy (proxy-fetch.ts). api.binance.com /
 * fapi.binance.com answer 451 direct from US IPs; routed through the Webshare proxy they work,
 * which unlocks what the public mirror (data-api.binance.vision) can't serve — notably FUNDING
 * RATES (fapi/v1/fundingRate). Pure parsers + thin proxied fetchers. Klines normalize to the
 * shared VenueCandle shape; funding to {time, rate} (rate = fraction the long pays per interval).
 */
import { sanitizeCandles, type VenueCandle } from "./venue-candles";
import { proxiedFetch } from "./proxy-fetch";

const SPOT = "https://api.binance.com";
const FAPI = "https://fapi.binance.com";

/** Binance kline row: [openTime_ms, o, h, l, c, v, closeTime_ms, ...]. */
export function parseBinanceKlines(raw: ReadonlyArray<ReadonlyArray<number | string>>, opts: { nowSec?: number } = {}): VenueCandle[] {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const out: VenueCandle[] = [];
  for (const k of raw) {
    const start = Math.floor(Number(k[0]) / 1000);
    const closeSec = Math.floor(Number(k[6]) / 1000);
    if (Number.isFinite(closeSec) && closeSec > nowSec) continue; // drop the in-progress candle
    out.push({ start_unix: start, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +(k[5] ?? 0) });
  }
  return sanitizeCandles(out);
}

export type FundingPoint = { time: number; rate: number };

/** fapi/v1/fundingRate row: [{ symbol, fundingTime(ms), fundingRate(string), markPrice }]. */
export function parseBinanceFunding(raw: ReadonlyArray<{ fundingTime: number | string; fundingRate: number | string }>): FundingPoint[] {
  return raw
    .map((r) => ({ time: Math.floor(Number(r.fundingTime) / 1000), rate: +r.fundingRate }))
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.rate))
    .sort((a, b) => a.time - b.time);
}

async function getJson(url: string): Promise<unknown> {
  const r = await proxiedFetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`binance ${new URL(url).pathname} → HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r.json();
}

/** Spot daily (or any-interval) klines, normalized + sanitized. `startUnix` is a unix-seconds floor. */
export async function fetchBinanceKlines(symbol: string, interval = "1d", opts: { startUnix?: number; limit?: number } = {}): Promise<VenueCandle[]> {
  const p = new URLSearchParams({ symbol, interval, limit: String(opts.limit ?? 1000) });
  if (opts.startUnix != null) p.set("startTime", String(opts.startUnix * 1000));
  return parseBinanceKlines((await getJson(`${SPOT}/api/v3/klines?${p}`)) as Array<Array<number | string>>);
}

/** PERP (USD-M futures) klines from fapi — the price leg of a basis trade. Normalized + sanitized. */
export async function fetchBinancePerpKlines(symbol: string, interval = "1d", opts: { startUnix?: number; limit?: number } = {}): Promise<VenueCandle[]> {
  const p = new URLSearchParams({ symbol, interval, limit: String(opts.limit ?? 1000) });
  if (opts.startUnix != null) p.set("startTime", String(opts.startUnix * 1000));
  return parseBinanceKlines((await getJson(`${FAPI}/fapi/v1/klines?${p}`)) as Array<Array<number | string>>);
}

/** Perp FUNDING history (the geo-blocked prize). Ascending by time; rate = fraction longs pay. */
export async function fetchBinanceFunding(symbol: string, opts: { startUnix?: number; limit?: number } = {}): Promise<FundingPoint[]> {
  const p = new URLSearchParams({ symbol, limit: String(opts.limit ?? 1000) });
  if (opts.startUnix != null) p.set("startTime", String(opts.startUnix * 1000));
  return parseBinanceFunding((await getJson(`${FAPI}/fapi/v1/fundingRate?${p}`)) as Array<{ fundingTime: number; fundingRate: string }>);
}

/** Current mark price + last/next funding for a perp (fapi/v1/premiumIndex). */
export async function fetchBinancePremiumIndex(symbol: string): Promise<{ markPrice: number; lastFundingRate: number; nextFundingTime: number }> {
  const d = (await getJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`)) as { markPrice: string; lastFundingRate: string; nextFundingTime: number };
  return { markPrice: +d.markPrice, lastFundingRate: +d.lastFundingRate, nextFundingTime: Number(d.nextFundingTime) };
}
