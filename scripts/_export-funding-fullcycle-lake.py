#!/usr/bin/env python3
"""
_export-funding-fullcycle-lake — bridge the My-Passport data lake into the jsonl shapes the
steelman funding script expects (the TimescaleDB warehouse is the normal path; this is the
offline lake path used when TSDB is down OR a longer history than the jsonl snapshot is needed).

Reads:
  /Volumes/My Passport/hft-data/crypto/funding/binance/<COIN>USDT/YYYY-MM.parquet   (8h funding)
  /Volumes/My Passport/hft-data/crypto/ohlcv/binance/um/<COIN>USDT/1d/YYYY-MM.parquet (daily OHLCV)
Writes:
  data/funding-fullcycle/<COIN>.binance.jsonl       {time, rate}      (8h, unix seconds)
  data/candles-fullcycle/<COIN>USDT.ONE_DAY.jsonl   {start_unix,o,h,l,c,v}

  cd /Users/isaiahdupree/Documents/Software/HFT-work && python3 scripts/_export-funding-fullcycle-lake.py
"""
import pyarrow.parquet as pq
import glob, json, os

BASE = "/Volumes/My Passport/hft-data"
OUT = os.path.join(os.path.dirname(__file__), "..", "data")
COINS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "LTC"]

os.makedirs(os.path.join(OUT, "funding-fullcycle"), exist_ok=True)
os.makedirs(os.path.join(OUT, "candles-fullcycle"), exist_ok=True)

for c in COINS:
    sym = c + "USDT"
    # funding (8h) -> {time, rate}
    ff = sorted(glob.glob(f"{BASE}/crypto/funding/binance/{sym}/*.parquet"))
    rows = []
    for f in ff:
        for r in pq.read_table(f).to_pylist():
            rows.append({"time": int(r["ts"]), "rate": float(r["funding_rate"])})
    rows.sort(key=lambda x: x["time"])
    with open(f"{OUT}/funding-fullcycle/{c}.binance.jsonl", "w") as fh:
        fh.write("\n".join(json.dumps(r) for r in rows) + "\n")
    # ohlcv daily -> {start_unix, open, high, low, close, volume}
    of = sorted(glob.glob(f"{BASE}/crypto/ohlcv/binance/um/{sym}/1d/*.parquet"))
    seen = {}
    for f in of:
        for r in pq.read_table(f).to_pylist():
            seen[int(r["ts"])] = {
                "start_unix": int(r["ts"]), "open": float(r["open"]), "high": float(r["high"]),
                "low": float(r["low"]), "close": float(r["close"]), "volume": float(r["volume"]),
            }
    crows = [seen[k] for k in sorted(seen)]
    with open(f"{OUT}/candles-fullcycle/{c}USDT.ONE_DAY.jsonl", "w") as fh:
        fh.write("\n".join(json.dumps(r) for r in crows) + "\n")
    print(f"{c}: {len(rows)} funding, {len(crows)} candles  {crows[0]['start_unix']}..{crows[-1]['start_unix']}")
print("DONE")
