#!/usr/bin/env python3
"""
pmxt_extract — PMXT hourly parquet -> chronological top-N L2 book-update JSONL
for one Polymarket market/token.

Input: the hourly full-market parquet mirrored by scripts/pmxt_fetch.py
(v2 fixed-column schema; see docs/research/PMXT-LOADER.md):
  event_type='book'              full ladder snapshot (bids/asks JSON ladders)
  event_type='price_change'      one level update; side BUY=bid SELL=ask;
                                 `size` is the NEW ABSOLUTE aggregate size at
                                 `price` (0 removes the level)
  event_type='last_trade_price'  trade print; side = taker (aggressor) side
  `market` BLOB = condition id (0x...); `asset_id` = CLOB token id; two tokens
  per binary market (Up/Yes first in Gamma's clobTokenIds).

Output JSONL (one event per line, time-sorted, ts = epoch ms, UTC):
  {"type":"book","ts":...,"bids":[[px,sz],...],"asks":[[px,sz],...]}   top-N; bids
      best-first (desc px), asks best-first (asc px). Emitted after every
      book/price_change event -> a full book-update stream.
  {"type":"trade","ts":...,"price":px,"size":sz,"aggressor":"BUY"|"SELL"}  (with --trades)

Book state RESETS on every 'book' snapshot (honest gap semantics — never
interpolate across a reset). price_change rows before the first snapshot are
applied to an empty ladder; the venue sends snapshots frequently so the warmup
is short.

Usage:
  python3 scripts/pmxt_extract.py --hour 2026-06-10T20 --slug btc-updown-5m-1781121900 \
      --top 5 --trades --out data/pmxt/btc-updown-5m-1781121900.jsonl
  python3 scripts/pmxt_extract.py --hour 2026-06-10T20 --condition-id 0xd79e... --token <asset_id>
  python3 scripts/pmxt_extract.py --discover-updown 2026-06-10T20      # list Up/Down slugs ending in the hour

Slug resolution uses Gamma (markets?slug=...&closed=true — closed=true is
REQUIRED for resolved markets, the bare slug query returns []). Default token =
first clobTokenIds entry (Up/Yes); --outcome down picks the second.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

import duckdb

GAMMA = "https://gamma-api.polymarket.com"
UA = "hft-work-pmxt-extract/1.0"


def http_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def resolve_slug(slug: str) -> tuple[str, list[str]]:
    """slug -> (condition_id, [token_id_up, token_id_down]) via Gamma."""
    for suffix in ("&closed=true", ""):
        rows = http_json(f"{GAMMA}/markets?slug={slug}{suffix}")
        if rows:
            m = rows[0]
            return m["conditionId"], json.loads(m["clobTokenIds"])
    raise SystemExit(f"slug {slug!r} not found on Gamma (tried closed=true and open)")


def discover_updown(hour: str) -> None:
    """Print Up/Down markets whose endDate falls inside the given UTC hour."""
    t0 = datetime.strptime(hour, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc)
    t1 = t0 + timedelta(hours=1)
    seen: set[str] = set()
    for offset in range(0, 2000, 100):
        rows = http_json(
            f"{GAMMA}/markets?closed=true&end_date_min={t0:%Y-%m-%dT%H:%M:%SZ}"
            f"&end_date_max={t1:%Y-%m-%dT%H:%M:%SZ}&limit=100&offset={offset}"
        )
        if not rows:
            break
        for m in rows:
            if "Up or Down" in m.get("question", "") and m["slug"] not in seen:
                seen.add(m["slug"])
                print(f"{m['slug']}\t{m['conditionId']}\t{m['question']}")


def parquet_path(hour: str) -> str:
    import os

    import pmxt_fetch  # sibling script (same dir is on sys.path) — shares the cache-dir logic

    p = os.path.join(pmxt_fetch.cache_dir(), pmxt_fetch.filename(hour))
    if not os.path.exists(p):
        raise SystemExit(f"{p} not cached — run: python3 scripts/pmxt_fetch.py {hour}")
    return p


def top_n(ladder: dict[float, float], n: int, reverse: bool) -> list[list[float]]:
    """Best-first top-N [[price, size], ...]; bids reverse=True, asks reverse=False."""
    return [[px, ladder[px]] for px in sorted(ladder, reverse=reverse)[:n]]


def extract(hours: list[str], cid: str, token: str, top: int, want_trades: bool, out) -> dict:
    """Replay one token's events across the given hours, emit JSONL, return stats."""
    stats = {"book_snapshots": 0, "price_changes": 0, "trades": 0, "book_updates_emitted": 0,
             "first_ts": None, "last_ts": None}
    bids: dict[float, float] = {}
    asks: dict[float, float] = {}
    con = duckdb.connect()
    for hour in hours:
        p = parquet_path(hour)
        rows = con.execute(
            """
            SELECT epoch_ms(timestamp) AS ts, event_type, bids, asks,
                   CAST(price AS DOUBLE) AS price, CAST(size AS DOUBLE) AS size, side
            FROM read_parquet(?)
            WHERE decode(market) = ? AND asset_id = ?
              AND event_type IN ('book', 'price_change', 'last_trade_price')
            ORDER BY timestamp, timestamp_received
            """,
            [p, cid, token],
        )
        while True:
            batch = rows.fetchmany(10_000)
            if not batch:
                break
            for ts, etype, bjson, ajson, price, size, side in batch:
                emit_book = False
                if etype == "book":
                    # Snapshot resets state (also the missing-hour recovery rule).
                    bids = {float(px): float(sz) for px, sz in json.loads(bjson)}
                    asks = {float(px): float(sz) for px, sz in json.loads(ajson)}
                    stats["book_snapshots"] += 1
                    emit_book = True
                elif etype == "price_change":
                    ladder = bids if side == "BUY" else asks
                    if size <= 0:
                        ladder.pop(price, None)
                    else:
                        ladder[price] = size
                    stats["price_changes"] += 1
                    emit_book = True
                else:  # last_trade_price
                    stats["trades"] += 1
                    if want_trades:
                        out.write(json.dumps({"type": "trade", "ts": ts, "price": price,
                                              "size": size, "aggressor": side}) + "\n")
                if emit_book:
                    out.write(json.dumps({"type": "book", "ts": ts,
                                          "bids": top_n(bids, top, True),
                                          "asks": top_n(asks, top, False)}) + "\n")
                    stats["book_updates_emitted"] += 1
                stats["first_ts"] = stats["first_ts"] if stats["first_ts"] is not None else ts
                stats["last_ts"] = ts
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hour", action="append", default=[], help="UTC hour YYYY-MM-DDTHH (repeatable, chronological)")
    ap.add_argument("--slug", help="Gamma market slug, e.g. btc-updown-5m-1781121900")
    ap.add_argument("--condition-id", help="condition id 0x... (skips Gamma)")
    ap.add_argument("--token", help="CLOB token id (asset_id); default = Up/Yes token from Gamma")
    ap.add_argument("--outcome", choices=["up", "down"], default="up", help="which token when resolving via --slug")
    ap.add_argument("--top", type=int, default=10, help="book depth N per side (default 10)")
    ap.add_argument("--trades", action="store_true", help="also emit last_trade_price prints")
    ap.add_argument("--out", help="output JSONL path (default stdout)")
    ap.add_argument("--discover-updown", metavar="HOUR", help="list Up/Down slugs ending in this UTC hour, then exit")
    args = ap.parse_args()

    if args.discover_updown:
        discover_updown(args.discover_updown)
        return
    if not args.hour:
        ap.error("--hour required")

    if args.slug:
        cid, tokens = resolve_slug(args.slug)
        token = args.token or tokens[0 if args.outcome == "up" else 1]
    elif args.condition_id and args.token:
        cid, token = args.condition_id, args.token
    else:
        ap.error("need --slug, or --condition-id with --token")

    sink = open(args.out, "w") if args.out else sys.stdout
    try:
        stats = extract(args.hour, cid, token, args.top, args.trades, sink)
    finally:
        if args.out:
            sink.close()
    print(json.dumps({"market": args.slug or args.condition_id, "token": token, **stats}), file=sys.stderr)


if __name__ == "__main__":
    main()
