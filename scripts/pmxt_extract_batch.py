#!/usr/bin/env python3
"""
pmxt_extract_batch — batch companion to pmxt_extract.py for the G3 backtest:
extract EVERY btc/eth-updown-5m window inside a contiguous span of cached PMXT
hours, one JSONL per token, with ONE duckdb scan per hourly parquet (instead of
one scan per market — 166 windows x 2 tokens over 7 hours would otherwise be
several hundred 0.5 GB scans).

Per window it resolves slug -> (conditionId, clobTokenIds, outcomePrices) via
Gamma (closed=true REQUIRED for resolved markets), replays the v2 fixed-column
events per token (book snapshot resets state; price_change `size` is the NEW
ABSOLUTE aggregate at `price`; last_trade_price side = aggressor), and writes
the same JSONL format as pmxt_extract.py. Top-N book lines are DEDUPED (only
emitted when the visible top-N actually changed) — lossless for the queue-fill
model, which only reads the visible size at the quote's price.

A manifest.json is written next to the extracts with window metadata + the
REAL 0/1 settle (Gamma outcomePrices, Up first) for residual marking.

Usage:
  python3 scripts/pmxt_extract_batch.py \
      --hour 2026-06-10T14 --hour 2026-06-10T15 ... --hour 2026-06-10T20 \
      --families btc-updown-5m,eth-updown-5m --top 10 \
      --out-dir "/Volumes/My Passport/hft-data/pmxt/extracts/2026-06-10"

No mock data: hours must already be mirrored by pmxt_fetch.py; slugs that
Gamma cannot resolve (or that lack a settled 0/1 outcome) are SKIPPED and
listed in the manifest, never invented.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

import duckdb

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pmxt_fetch  # noqa: E402 — shared cache-dir/filename logic
from pmxt_extract import GAMMA, http_json, parquet_path, top_n  # noqa: E402

WINDOW_SEC = 300
WARMUP_SEC = 420  # include book events this long before window start (pre-open quotes)


def hour_epoch(hour: str) -> int:
    return int(datetime.strptime(hour, "%Y-%m-%dT%H").replace(tzinfo=timezone.utc).timestamp())


def resolve_window(slug: str) -> dict | None:
    """slug -> window metadata with the REAL settle, or None if not resolvable."""
    try:
        rows = http_json(f"{GAMMA}/markets?slug={slug}&closed=true")
    except Exception as e:  # noqa: BLE001
        print(f"  gamma error for {slug}: {e}", file=sys.stderr)
        return None
    if not rows:
        return None
    m = rows[0]
    try:
        tokens = json.loads(m["clobTokenIds"])
        prices = [float(x) for x in json.loads(m["outcomePrices"])]
    except Exception:  # noqa: BLE001
        return None
    if len(tokens) != 2 or len(prices) != 2 or sorted(prices) != [0.0, 1.0]:
        return None  # not a settled 0/1 binary — never mark residuals against this
    return {
        "slug": slug,
        "question": m.get("question"),
        "conditionId": m["conditionId"],
        "tokenUp": tokens[0],
        "tokenDown": tokens[1],
        "outcomeUp": prices[0],  # 1.0 if Up resolved YES, else 0.0
        "endDate": m.get("endDate"),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hour", action="append", required=True, help="cached UTC hour YYYY-MM-DDTHH (repeatable, chronological)")
    ap.add_argument("--families", default="btc-updown-5m,eth-updown-5m")
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    hours = sorted(args.hour)
    for h in hours:
        parquet_path(h)  # fail fast if any hour is missing from the cache
    families = [f.strip() for f in args.families.split(",") if f.strip()]
    os.makedirs(args.out_dir, exist_ok=True)

    span_start = hour_epoch(hours[0])
    span_end = hour_epoch(hours[-1]) + 3600

    # ── enumerate candidate windows: starts aligned to 5 min, warmup + full window inside the span ──
    windows: list[dict] = []
    skipped: list[str] = []
    start = ((span_start + WARMUP_SEC + WINDOW_SEC - 1) // WINDOW_SEC) * WINDOW_SEC
    starts = list(range(start, span_end - WINDOW_SEC + 1, WINDOW_SEC))
    print(f"span {hours[0]}..{hours[-1]} -> {len(starts)} window starts x {len(families)} families")
    for s in starts:
        for fam in families:
            slug = f"{fam}-{s}"
            w = resolve_window(slug)
            time.sleep(0.12)  # be polite to Gamma
            if w is None:
                skipped.append(slug)
                continue
            w["startSec"] = s
            w["endSec"] = s + WINDOW_SEC
            w["family"] = fam
            windows.append(w)
    print(f"resolved {len(windows)} windows ({len(skipped)} skipped)")
    if not windows:
        raise SystemExit("no windows resolved — check the span / Gamma availability")

    # ── token bookkeeping ──
    token_meta: dict[str, dict] = {}
    for w in windows:
        for side, tok in (("up", w["tokenUp"]), ("down", w["tokenDown"])):
            token_meta[tok] = {
                "cid": w["conditionId"],
                "file": os.path.join(args.out_dir, f"{w['slug']}-{side}.jsonl"),
                "t0": (w["startSec"] - WARMUP_SEC) * 1000,
                "t1": (w["endSec"] + 30) * 1000,  # small tail past expiry (settle collapse visible, harmless)
            }
    # fresh outputs
    for meta in token_meta.values():
        open(meta["file"], "w").close()

    # ── one scan per hour, all tokens relevant to that hour, state persists across hours ──
    ladders: dict[str, tuple[dict, dict]] = {t: ({}, {}) for t in token_meta}
    last_emit: dict[str, str] = {}
    stats: dict[str, dict] = {t: {"book": 0, "pc": 0, "trades": 0, "emitted": 0} for t in token_meta}
    con = duckdb.connect()
    for h in hours:
        h0, h1 = hour_epoch(h) * 1000, (hour_epoch(h) + 3600) * 1000
        toks = [t for t, m in token_meta.items() if m["t0"] < h1 and m["t1"] > h0]
        if not toks:
            continue
        print(f"{h}: scanning for {len(toks)} tokens …", flush=True)
        rows = con.execute(
            """
            SELECT asset_id, epoch_ms(timestamp) AS ts, event_type, bids, asks,
                   CAST(price AS DOUBLE) AS price, CAST(size AS DOUBLE) AS size, side
            FROM read_parquet(?)
            WHERE asset_id IN (SELECT UNNEST(?::VARCHAR[]))
              AND event_type IN ('book', 'price_change', 'last_trade_price')
            ORDER BY asset_id, timestamp, timestamp_received
            """,
            [parquet_path(h), toks],
        )
        sinks: dict[str, object] = {}
        try:
            while True:
                batch = rows.fetchmany(20_000)
                if not batch:
                    break
                for tok, ts, etype, bjson, ajson, price, size, side in batch:
                    meta = token_meta[tok]
                    if ts < meta["t0"] or ts > meta["t1"]:
                        continue
                    if tok not in sinks:
                        sinks[tok] = open(meta["file"], "a")
                    out = sinks[tok]
                    bids, asks = ladders[tok]
                    st = stats[tok]
                    emit_book = False
                    if etype == "book":
                        bids.clear(); asks.clear()
                        bids.update({float(px): float(sz) for px, sz in json.loads(bjson)})
                        asks.update({float(px): float(sz) for px, sz in json.loads(ajson)})
                        st["book"] += 1
                        emit_book = True
                    elif etype == "price_change":
                        ladder = bids if side == "BUY" else asks
                        if size <= 0:
                            ladder.pop(price, None)
                        else:
                            ladder[price] = size
                        st["pc"] += 1
                        emit_book = True
                    else:  # last_trade_price
                        st["trades"] += 1
                        out.write(json.dumps({"type": "trade", "ts": ts, "price": price,
                                              "size": size, "aggressor": side}) + "\n")
                    if emit_book:
                        line = json.dumps({"type": "book", "ts": ts,
                                           "bids": top_n(bids, args.top, True),
                                           "asks": top_n(asks, args.top, False)})
                        # dedupe: only emit when the visible top-N changed
                        key = line[line.index('"bids"'):]
                        if last_emit.get(tok) != key:
                            out.write(line + "\n")
                            last_emit[tok] = key
                            st["emitted"] += 1
        finally:
            for f in sinks.values():
                f.close()

    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "hours": hours,
        "families": families,
        "top": args.top,
        "warmupSec": WARMUP_SEC,
        "windows": [
            {**w, "fileUp": token_meta[w["tokenUp"]]["file"], "fileDown": token_meta[w["tokenDown"]]["file"],
             "statsUp": stats[w["tokenUp"]], "statsDown": stats[w["tokenDown"]]}
            for w in windows
        ],
        "skippedSlugs": skipped,
    }
    mpath = os.path.join(args.out_dir, "manifest.json")
    with open(mpath, "w") as f:
        json.dump(manifest, f, indent=1)
    n_empty = sum(1 for w in manifest["windows"] if w["statsUp"]["emitted"] == 0 or w["statsDown"]["emitted"] == 0)
    print(f"manifest -> {mpath} | {len(windows)} windows, {n_empty} with an empty leg, {len(skipped)} skipped")


if __name__ == "__main__":
    main()
