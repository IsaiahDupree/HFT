"""
Real market data — no mocks.

Sources (no API key required):
  * Coinbase Exchange  — historical 1-minute OHLC candles for replay backtests.
  * Hyperliquid `info` — live perp mid prices (the venue the source videos trade).

A `CandleReplay` streams real candles oldest→newest so a sim run is a faithful
replay of a real recent market window.
"""
from __future__ import annotations

import json
import time
import urllib.request
import urllib.error
from dataclasses import dataclass
from typing import Iterator, List, Optional


@dataclass(frozen=True)
class Candle:
    ts: int          # epoch seconds (bar open time)
    open: float
    high: float
    low: float
    close: float
    volume: float

    def to_dict(self) -> dict:
        return {"ts": self.ts, "open": self.open, "high": self.high,
                "low": self.low, "close": self.close, "volume": self.volume}


def _get(url: str, timeout: float = 12.0) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": "hft-workspace/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def fetch_coinbase_candles(product: str = "BTC-USD", granularity: int = 60,
                           limit: int = 300) -> List[Candle]:
    """Fetch the most-recent `limit` candles (max 300/req) from Coinbase.
    Coinbase rows: [time, low, high, open, close, volume], newest-first."""
    rows = _get(f"https://api.exchange.coinbase.com/products/{product}/candles"
                f"?granularity={granularity}")
    if not isinstance(rows, list):
        raise RuntimeError(f"Coinbase candles error: {rows}")
    candles = [Candle(ts=int(r[0]), low=float(r[1]), high=float(r[2]),
                      open=float(r[3]), close=float(r[4]), volume=float(r[5]))
               for r in rows]
    candles.sort(key=lambda c: c.ts)         # oldest → newest
    return candles[-limit:]


def fetch_hyperliquid_mids() -> dict:
    """Live mid prices for every Hyperliquid perp (real venue, no key)."""
    req = urllib.request.Request(
        "https://api.hyperliquid.xyz/info",
        data=json.dumps({"type": "allMids"}).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "hft-workspace/1.0"},
        method="POST")
    with urllib.request.urlopen(req, timeout=12) as r:
        return json.loads(r.read().decode())


def live_price(coin: str = "BTC") -> float:
    return float(fetch_hyperliquid_mids()[coin])


class CandleReplay:
    """Replays a real candle window one bar at a time.

    `window(n)` returns the last n closed candles up to (and including) the
    current bar — the only information the agent is allowed to see (no lookahead).
    """

    def __init__(self, candles: List[Candle]):
        if len(candles) < 2:
            raise ValueError("need >= 2 candles to replay")
        self._candles = candles
        self._i = 0

    def __len__(self) -> int:
        return len(self._candles)

    @property
    def current(self) -> Candle:
        return self._candles[self._i]

    @property
    def index(self) -> int:
        return self._i

    @property
    def finished(self) -> bool:
        return self._i >= len(self._candles) - 1

    def window(self, n: int) -> List[Candle]:
        lo = max(0, self._i - n + 1)
        return self._candles[lo:self._i + 1]

    def advance(self) -> Optional[Candle]:
        if self.finished:
            return None
        self._i += 1
        return self._candles[self._i]

    def __iter__(self) -> Iterator[Candle]:
        while not self.finished:
            yield self.advance()


def load_replay(product: str = "BTC-USD", granularity: int = 60,
                bars: int = 120, retries: int = 3) -> CandleReplay:
    """Load a real recent candle window for replay, with retry."""
    last_err = None
    for attempt in range(retries):
        try:
            candles = fetch_coinbase_candles(product, granularity, limit=bars)
            if len(candles) >= 2:
                return CandleReplay(candles)
        except (urllib.error.URLError, RuntimeError, ValueError) as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"could not load replay for {product}: {last_err}")
