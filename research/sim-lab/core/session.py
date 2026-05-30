"""
session.simulate — the one trading-session engine.

Given a real candle replay, a capsule, and an agent brain, it runs the full
60-second-heartbeat loop (risk-first stop handling → agent intent → risk gate →
sim execution → time-stop flatten → score). The single-agent CLI, the
multi-window evaluator, and the arena all call this one function, so they are
guaranteed to be the same experiment at different scale.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from .marketdata import CandleReplay
from .capsule import Capsule
from .sim_broker import SimPerpBroker
from .risk import vet
from .scoring import RunScore, score_run
from .agents.base import MarketContext, PositionView, TradeDecision


@dataclass
class SessionResult:
    capsule: Capsule
    broker: SimPerpBroker
    score: RunScore
    events: List[dict]
    halted: bool


def _position_view(broker: SimPerpBroker, price: float, now_bar: int,
                   opened_bar: int) -> Optional[PositionView]:
    p = broker.position
    if p is None:
        return None
    return PositionView(side=p.side, entry=p.entry, margin_usd=p.margin_usd,
                        leverage=p.leverage, unrealized_usd=round(p.unrealized(price), 2),
                        age_bars=now_bar - opened_bar)


def simulate(replay: CandleReplay, capsule: Capsule, agent, *, warmup: int = 15,
             heartbeat: int = 3, fee_bps: float = 5.0, window_bars: int = 40,
             timeframe: str = "1m", bar_minutes: int = 1,
             verbose: bool = False, log=print) -> SessionResult:
    broker = SimPerpBroker(starting_capital=capsule.capital, fee_bps=fee_bps)
    total_bars = len(replay)
    events: List[dict] = []
    opened_bar = 0
    halted = False

    for _ in range(min(warmup, total_bars - 2)):
        replay.advance()

    while not replay.finished:
        candle = replay.advance()
        bar_i = replay.index

        # 1) risk-first: stops / TP / liquidation against this real bar.
        for f in broker.step(candle):
            events.append({"bar": bar_i, "type": "auto_close", "reason": f.reason,
                           "price": round(f.price, 2), "pnl": round(f.pnl, 2)})
            if verbose:
                log(f"│   bar {bar_i:>3} ⚠ {f.reason} @ ${f.price:,.2f}  pnl ${f.pnl:+.2f}")

        if (bar_i % heartbeat != 0) or replay.finished \
                or broker.n_closed_trades >= capsule.max_trades:
            continue

        # 2) agent heartbeat → intent.
        equity = broker.equity(candle.close)
        ctx = MarketContext(
            symbol=capsule.label or "PERP", candles=replay.window(window_bars),
            price=candle.close, capsule=capsule.to_dict(), equity=round(equity, 2),
            pnl_usd=round(equity - capsule.capital, 2),
            minutes_left=(total_bars - bar_i) * bar_minutes, timeframe=timeframe,
            position=_position_view(broker, candle.close, bar_i, opened_bar),
            trades_done=broker.n_closed_trades)
        decision: TradeDecision = agent.decide(ctx)

        # 3) the single execution gate.
        gate = vet(decision, capsule, broker, candle.close)
        if gate.halted:
            if verbose:
                log(f"│   bar {bar_i:>3} ⛔ HALT — {gate.reason}")
            halted = True
            break
        if not gate.approved:
            events.append({"bar": bar_i, "type": "rejected", "reason": gate.reason,
                           "intent": decision.to_dict()})
            continue

        d = gate.decision
        if d.action == "CLOSE":
            f = broker.close(candle.close, candle.ts, reason="agent_close")
            if f:
                events.append({"bar": bar_i, "type": "close", "price": round(f.price, 2),
                               "pnl": round(f.pnl, 2), "why": decision.rationale})
                if verbose:
                    log(f"│   bar {bar_i:>3} ✕ close {f.side} @ ${f.price:,.2f}  "
                        f"pnl ${f.pnl:+.2f} — {decision.rationale[:60]}")
        elif d.action == "OPEN":
            f = broker.open(side=d.side, margin_usd=d.margin_usd, leverage=d.leverage,
                            price=candle.close, ts=candle.ts, stop_pct=d.stop_pct,
                            tp_pct=d.tp_pct, thesis=decision.rationale)
            opened_bar = bar_i
            events.append({"bar": bar_i, "type": "open", "side": d.side, "margin": d.margin_usd,
                           "lev": d.leverage, "stop_pct": d.stop_pct, "tp_pct": d.tp_pct,
                           "price": round(f.price, 2), "why": decision.rationale, "gate": gate.reason})
            if verbose:
                log(f"│   bar {bar_i:>3} ▸ {d.side} ${d.margin_usd:.0f}@{d.leverage:.0f}x "
                    f"stop {d.stop_pct*100:.1f}%{(' tp '+format(d.tp_pct*100,'.1f')+'%') if d.tp_pct else ''} "
                    f"@ ${f.price:,.2f} — {decision.rationale[:50]}")
        else:
            events.append({"bar": bar_i, "type": "hold", "why": decision.rationale})

    # time-stop flatten.
    final = replay.current
    fclose = broker.close(final.close, final.ts, reason="time_stop_flatten")
    if fclose:
        events.append({"bar": replay.index, "type": "flatten",
                       "price": round(fclose.price, 2), "pnl": round(fclose.pnl, 2)})
        if verbose:
            log(f"│   ⏹ time-stop flatten @ ${fclose.price:,.2f}  pnl ${fclose.pnl:+.2f}")
    broker.equity_curve.append((final.ts, broker.equity(final.close)))

    return SessionResult(capsule=capsule, broker=broker, score=score_run(broker),
                         events=events, halted=halted)
