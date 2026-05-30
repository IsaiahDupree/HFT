"""
Risk-adjusted scoring — how the arena ranks agents and decides who keeps a
capsule. Mirrors the foundation engine's score (pnl_pct − k·max_dd_pct) and adds
the metrics needed to promote across the sim→real ladder responsibly.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Tuple

from .sim_broker import SimPerpBroker


@dataclass
class RunScore:
    starting_capital: float
    final_equity: float
    pnl_usd: float
    pnl_pct: float
    max_drawdown_pct: float
    win_rate: float
    n_trades: int
    sharpe: float
    score: float            # the ranking number: pnl_pct − dd_penalty·max_dd_pct

    def to_dict(self) -> dict:
        return self.__dict__.copy()

    def summary(self) -> str:
        sign = "+" if self.pnl_usd >= 0 else ""
        return (f"PnL {sign}${self.pnl_usd:,.2f} ({sign}{self.pnl_pct:.2f}%) | "
                f"maxDD {self.max_drawdown_pct:.2f}% | win {self.win_rate*100:.0f}% | "
                f"trades {self.n_trades} | Sharpe {self.sharpe:.2f} | score {self.score:.2f}")


def _max_drawdown_pct(equity_curve: List[Tuple[int, float]]) -> float:
    peak = -math.inf
    mdd = 0.0
    for _, eq in equity_curve:
        peak = max(peak, eq)
        if peak > 0:
            mdd = max(mdd, (peak - eq) / peak)
    return mdd * 100.0


def _sharpe(equity_curve: List[Tuple[int, float]]) -> float:
    if len(equity_curve) < 3:
        return 0.0
    rets = []
    for i in range(1, len(equity_curve)):
        prev = equity_curve[i - 1][1]
        if prev > 0:
            rets.append((equity_curve[i][1] - prev) / prev)
    if len(rets) < 2:
        return 0.0
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    sd = math.sqrt(var)
    if sd == 0:
        return 0.0
    return (mean / sd) * math.sqrt(len(rets))   # per-run annualization proxy


def score_run(broker: SimPerpBroker, dd_penalty: float = 2.0) -> RunScore:
    final_eq = broker.equity_curve[-1][1] if broker.equity_curve else broker.cash
    pnl = final_eq - broker.starting_capital
    pnl_pct = pnl / broker.starting_capital * 100.0
    mdd = _max_drawdown_pct(broker.equity_curve)
    closes = [f for f in broker.fills if f.kind == "CLOSE"]
    wins = sum(1 for f in closes if f.pnl > 0)
    win_rate = (wins / len(closes)) if closes else 0.0
    return RunScore(
        starting_capital=broker.starting_capital, final_equity=round(final_eq, 2),
        pnl_usd=round(pnl, 2), pnl_pct=round(pnl_pct, 3),
        max_drawdown_pct=round(mdd, 3), win_rate=round(win_rate, 3),
        n_trades=len(closes), sharpe=round(_sharpe(broker.equity_curve), 3),
        score=round(pnl_pct - dd_penalty * mdd, 3))
