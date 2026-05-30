"""
Risk gate — the single execution gate.

Pattern lifted from the source videos (the Codex/Hyperliquid framework): the
LLM agent never trades directly. It emits an *intent*; this gate is the ONLY
path to the broker. It clamps the intent to the capsule's risk envelope and
can hard-halt the capsule. This is what makes scaling to hundreds of agents and
eventually real money survivable.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Tuple

from .capsule import Capsule
from .sim_broker import SimPerpBroker
from .agents.base import TradeDecision


@dataclass
class GateResult:
    approved: bool
    decision: Optional[TradeDecision]
    reason: str
    halted: bool = False


def vet(decision: TradeDecision, capsule: Capsule, broker: SimPerpBroker,
        current_price: float) -> GateResult:
    """Validate & clamp an agent intent against the capsule's limits."""
    equity = broker.equity(current_price)

    # Hard halt: capsule has breached its daily loss floor → flatten & stand down.
    if equity <= capsule.daily_loss_floor():
        return GateResult(False, None, "daily_loss_limit breached — capsule halted",
                          halted=True)

    if decision.action in ("HOLD", "CLOSE"):
        return GateResult(True, decision, decision.action.lower())

    if decision.action != "OPEN":
        return GateResult(False, None, f"unknown action {decision.action!r}")

    if decision.side not in ("LONG", "SHORT"):
        return GateResult(False, None, f"bad side {decision.side!r}")

    # Clamp leverage and margin into the envelope.
    lev = max(1.0, min(float(decision.leverage or 1.0), capsule.max_leverage))
    req_margin = float(decision.margin_usd or 0.0)
    if req_margin <= 0:
        return GateResult(False, None, "non-positive margin")
    margin = min(req_margin, capsule.max_margin(), broker.cash)
    if margin < 1.0:
        return GateResult(False, None, "insufficient free collateral")

    # Enforce a protective stop always.
    stop_pct = decision.stop_pct or capsule.default_stop_pct
    stop_pct = max(capsule.min_stop_pct, float(stop_pct))

    clamped = TradeDecision(
        action="OPEN", side=decision.side, margin_usd=round(margin, 2),
        leverage=round(lev, 2), stop_pct=round(stop_pct, 4),
        tp_pct=(round(float(decision.tp_pct), 4) if decision.tp_pct else None),
        rationale=decision.rationale, confidence=decision.confidence)

    note = []
    if lev != (decision.leverage or 1.0):
        note.append(f"lev→{lev}")
    if margin != req_margin:
        note.append(f"margin→{margin:.2f}")
    if (decision.stop_pct or 0) != stop_pct:
        note.append(f"stop→{stop_pct:.3f}")
    return GateResult(True, clamped, "approved" + (f" ({', '.join(note)})" if note else ""))
