"""
Agent brain interface — pluggable so the SAME harness can run an OpenAI
LLM-trader (built first), a Claude-Code-as-trader subprocess (exact video
replica), or a deterministic coded strategy. They all consume a MarketContext
and emit a TradeDecision (an "intent"); the risk gate does the rest.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Protocol

from ..marketdata import Candle


@dataclass
class TradeDecision:
    """An intent emitted by an agent. Never reaches the broker un-vetted."""
    action: str                         # 'OPEN' | 'CLOSE' | 'HOLD'
    side: Optional[str] = None          # 'LONG' | 'SHORT' (for OPEN)
    margin_usd: Optional[float] = None
    leverage: Optional[float] = None
    stop_pct: Optional[float] = None
    tp_pct: Optional[float] = None
    rationale: str = ""
    confidence: float = 0.5

    def to_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class PositionView:
    side: str
    entry: float
    margin_usd: float
    leverage: float
    unrealized_usd: float
    age_bars: int


@dataclass
class MarketContext:
    symbol: str
    candles: List[Candle]               # recent window, oldest→newest (no lookahead)
    price: float                        # current close
    capsule: dict                       # capsule.to_dict()
    equity: float                       # current capsule equity
    pnl_usd: float                      # equity − starting capital
    minutes_left: float                 # until the run's hard time-stop
    position: Optional[PositionView]    # current open position, if any
    trades_done: int
    timeframe: str = "1m"               # candle timeframe label (1m/5m/15m/1h)


class TraderBrain(Protocol):
    name: str

    def decide(self, ctx: MarketContext) -> TradeDecision:
        ...
