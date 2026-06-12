#!/usr/bin/env python3
"""
pmxt_fetch — mirror one (or more) hourly PMXT raw Polymarket L2 parquet files.

The PMXT raw archive is a FREE public Cloudflare R2 bucket pair (no auth):
  v1: https://r2.pmxt.dev/polymarket_orderbook_YYYY-MM-DDTHH.parquet   (2026-02-21T16 -> ~Apr 2026)
  v2: https://r2v2.pmxt.dev/polymarket_orderbook_YYYY-MM-DDTHH.parquet (~Apr 2026 -> now)

One parquet per UTC hour covering EVERY Polymarket market (~0.3-0.7 GB/hour).
Both buckets are probed via HEAD and the larger object wins (mirrors the
evan-kolberg downloader semantics — see docs/research/EVAN-KOLBERG-BACKTESTER-ASSESS.md).

Cache dir: /Volumes/My Passport/hft-data/pmxt/ when the passport is mounted,
else data/pmxt/ in the repo. Skip-if-exists with a size check against the
remote Content-Length; downloads are atomic (tmp file + rename).

Usage:
  python3 scripts/pmxt_fetch.py 2026-06-10T20            # one hour
  python3 scripts/pmxt_fetch.py 2026-06-10T20 2026-06-10T21
  python3 scripts/pmxt_fetch.py --print-path 2026-06-10T20   # resolve cache path only (no download)
"""
from __future__ import annotations

import os
import re
import sys
import time
import urllib.request
import urllib.error

BUCKETS = ["https://r2v2.pmxt.dev", "https://r2.pmxt.dev"]  # v2 first (current era)
HOUR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}$")
PASSPORT_DIR = "/Volumes/My Passport/hft-data/pmxt"
REPO_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "pmxt")
UA = "hft-work-pmxt-fetch/1.0"


def cache_dir() -> str:
    # Passport mount check: the parent must exist and be a directory (not just /Volumes).
    if os.path.isdir(os.path.dirname(PASSPORT_DIR)):
        os.makedirs(PASSPORT_DIR, exist_ok=True)
        return PASSPORT_DIR
    os.makedirs(REPO_DIR, exist_ok=True)
    return REPO_DIR


def filename(hour: str) -> str:
    return f"polymarket_orderbook_{hour}.parquet"


def head_size(url: str) -> int | None:
    """Content-Length via HEAD, or None if the object is missing/unreachable."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status == 200:
                return int(r.headers.get("Content-Length", "0"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError):
        return None
    return None


def pick_bucket(hour: str) -> tuple[str, int] | None:
    """Probe both buckets, keep the larger object (their downloader's rule)."""
    best: tuple[str, int] | None = None
    for base in BUCKETS:
        url = f"{base}/{filename(hour)}"
        size = head_size(url)
        if size and (best is None or size > best[1]):
            best = (url, size)
    return best


def fetch_hour(hour: str, dest_dir: str, retries: int = 3) -> str:
    if not HOUR_RE.match(hour):
        raise SystemExit(f"bad hour {hour!r} — want YYYY-MM-DDTHH (UTC)")
    dest = os.path.join(dest_dir, filename(hour))
    picked = pick_bucket(hour)
    if picked is None:
        raise SystemExit(f"{hour}: not found in either bucket ({', '.join(BUCKETS)})")
    url, remote_size = picked
    if os.path.exists(dest) and os.path.getsize(dest) == remote_size:
        print(f"{hour}: cached OK ({remote_size / 1e6:.0f} MB) -> {dest}")
        return dest
    tmp = dest + ".part"
    for attempt in range(1, retries + 1):
        try:
            print(f"{hour}: GET {url} ({remote_size / 1e6:.0f} MB, attempt {attempt})", flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            got = os.path.getsize(tmp)
            if got != remote_size:
                raise IOError(f"size mismatch: got {got}, want {remote_size}")
            os.replace(tmp, dest)
            print(f"{hour}: done in {time.time() - t0:.0f}s -> {dest}")
            return dest
        except Exception as e:  # noqa: BLE001 — retry any transfer failure
            print(f"{hour}: attempt {attempt} failed: {e}", file=sys.stderr)
            if os.path.exists(tmp):
                os.remove(tmp)
            if attempt == retries:
                raise
            time.sleep(5 * attempt)
    raise SystemExit("unreachable")


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        raise SystemExit(__doc__)
    dest_dir = cache_dir()
    for hour in args:
        if "--print-path" in flags:
            print(os.path.join(dest_dir, filename(hour)))
        else:
            fetch_hour(hour, dest_dir)


if __name__ == "__main__":
    main()
