"""
SimPerpBroker — a faithful sim of a perp venue (Hyperliquid-shaped), filled
against REAL replayed candles. No mocks: every fill, stop, and liquidation is
computed from the real OHLC of the bar.

Conventions
-----------
* A position has `margin_usd` collateral and `leverage`; notional = margin*lev.
* qty = notional / entry_price (coin units).
* LONG  pnl = qty * (price - entry);  SHORT pnl = qty * (entry - price).
* Liquidation when position equity (margin + unrealized pnl) <= maintenance.
* Stops/TPs are price levels; intrabar fills use the bar's high/low so a stop
  that the bar traded through is honored (conservative — stop checked before TP
  when both are inside the same bar).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .marketdata import Candle


@dataclass
class Position:
    side: str               # 'LONG' | 'SHORT'
    entry: float
    margin_usd: float
    leverage: float
    stop_price: Optional[float]
    tp_price: Optional[float]
    opened_ts: int
    thesis: str = ""

    @property
    def notional(self) -> float:
        return self.margin_usd * self.leverage

    @property
    def qty(self) -> float:
        return self.notional / self.entry

    def unrealized(self, price: float) -> float:
        if self.side == "LONG":
            return self.qty * (price - self.entry)
        return self.qty * (self.entry - price)

    def equity(self, price: float) -> float:
        return self.margin_usd + self.unrealized(price)


@dataclass
class Fill:
    ts: int
    kind: str               # 'OPEN' | 'CLOSE'
    side: str
    price: float
    margin_usd: float
    leverage: float
    pnl: float
    reason: str


@dataclass
class SimPerpBroker:
    starting_capital: float
    fee_bps: float = 5.0                 # taker fee per side, basis points of notional
    maint_margin_frac: float = 0.10      # liquidate when equity < 10% of margin
    cash: float = field(init=False)      # free collateral
    position: Optional[Position] = field(default=None, init=False)
    fills: List[Fill] = field(default_factory=list, init=False)
    equity_curve: List[tuple] = field(default_factory=list, init=False)  # (ts, equity)

    def __post_init__(self):
        self.cash = self.starting_capital

    # -- valuation --------------------------------------------------------
    def equity(self, price: float) -> float:
        eq = self.cash
        if self.position:
            eq += self.position.equity(price)
        return eq

    def _fee(self, notional: float) -> float:
        return notional * self.fee_bps / 1e4

    # -- actions ----------------------------------------------------------
    def open(self, side: str, margin_usd: float, leverage: float, price: float,
             ts: int, stop_pct: Optional[float], tp_pct: Optional[float],
             thesis: str = "") -> Fill:
        if self.position is not None:
            self.close(price, ts, reason="reverse")
        margin_usd = min(margin_usd, self.cash)
        notional = margin_usd * leverage
        fee = self._fee(notional)
        self.cash -= margin_usd + fee
        stop = tp = None
        if stop_pct:
            stop = price * (1 - stop_pct) if side == "LONG" else price * (1 + stop_pct)
        if tp_pct:
            tp = price * (1 + tp_pct) if side == "LONG" else price * (1 - tp_pct)
        self.position = Position(side=side, entry=price, margin_usd=margin_usd,
                                 leverage=leverage, stop_price=stop, tp_price=tp,
                                 opened_ts=ts, thesis=thesis)
        f = Fill(ts=ts, kind="OPEN", side=side, price=price, margin_usd=margin_usd,
                 leverage=leverage, pnl=-fee, reason=thesis[:80])
        self.fills.append(f)
        return f

    def close(self, price: float, ts: int, reason: str = "manual") -> Optional[Fill]:
        if self.position is None:
            return None
        p = self.position
        pnl = p.unrealized(price)
        fee = self._fee(p.notional)
        self.cash += p.margin_usd + pnl - fee
        f = Fill(ts=ts, kind="CLOSE", side=p.side, price=price, margin_usd=p.margin_usd,
                 leverage=p.leverage, pnl=pnl - fee, reason=reason)
        self.fills.append(f)
        self.position = None
        return f

    def step(self, candle: Candle) -> List[Fill]:
        """Advance one bar: honor stop/TP/liquidation against the bar's range,
        then record equity at the close."""
        events: List[Fill] = []
        p = self.position
        if p is not None:
            # liquidation price (equity hits maintenance)
            liq_move = (1 - self.maint_margin_frac) / p.leverage
            liq = p.entry * (1 - liq_move) if p.side == "LONG" else p.entry * (1 + liq_move)
            hit_liq = candle.low <= liq if p.side == "LONG" else candle.high >= liq
            hit_stop = (p.stop_price is not None and
                        (candle.low <= p.stop_price if p.side == "LONG"
                         else candle.high >= p.stop_price))
            hit_tp = (p.tp_price is not None and
                      (candle.high >= p.tp_price if p.side == "LONG"
                       else candle.low <= p.tp_price))
            # priority: liquidation, then stop (risk-first), then TP
            if hit_liq:
                f = self.close(liq, candle.ts, reason="liquidation")
                if f: events.append(f)
            elif hit_stop:
                f = self.close(p.stop_price, candle.ts, reason="stop")
                if f: events.append(f)
            elif hit_tp:
                f = self.close(p.tp_price, candle.ts, reason="take_profit")
                if f: events.append(f)
        self.equity_curve.append((candle.ts, self.equity(candle.close)))
        return events

    # -- summary ----------------------------------------------------------
    def realized_pnl(self) -> float:
        """Net realized P&L from all closed fills (and open-side fees)."""
        return sum(f.pnl for f in self.fills)

    @property
    def n_closed_trades(self) -> int:
        return sum(1 for f in self.fills if f.kind == "CLOSE")
