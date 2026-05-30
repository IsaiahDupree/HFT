"""
Capsule — a risk envelope that bounds how an agent operates on its capital.

This is the unit of capital allocation in the whole system (the "capsule of
money"). The ensemble allocator hands a capsule to an agent; the risk gate
enforces the capsule's limits on every intent; the promotion ladder grows or
shrinks a capsule's capital based on proven sim/paper performance.

Stages mirror the proven sim→real ladder:
    SIM → PAPER → LIVE_SMALL → LIVE_SCALED
Only SIM is reachable without real-broker credentials; promotion between stages
is gated on out-of-sample, risk-adjusted performance over time.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from enum import Enum


class Stage(str, Enum):
    SIM = "sim"
    PAPER = "paper"
    LIVE_SMALL = "live_small"
    LIVE_SCALED = "live_scaled"


@dataclass
class Capsule:
    capital: float                       # sim/real capital allocated to this capsule
    capsule_id: str = field(default_factory=lambda: f"cap_{uuid.uuid4().hex[:8]}")
    stage: Stage = Stage.SIM
    # risk envelope
    max_position_pct: float = 0.70       # max margin per trade as fraction of capital
    max_leverage: float = 10.0
    daily_loss_limit_pct: float = 0.25   # halt the capsule if down this much intraday
    default_stop_pct: float = 0.015      # ~1.5% protective stop (from the videos)
    min_stop_pct: float = 0.003
    max_trades: int = 60                 # over the run window
    label: str = ""                      # human/agent name, e.g. persona title

    def max_margin(self) -> float:
        return self.capital * self.max_position_pct

    def daily_loss_floor(self) -> float:
        return self.capital * (1 - self.daily_loss_limit_pct)

    def to_dict(self) -> dict:
        return {
            "capsule_id": self.capsule_id, "label": self.label,
            "stage": self.stage.value, "capital": self.capital,
            "max_position_pct": self.max_position_pct, "max_leverage": self.max_leverage,
            "daily_loss_limit_pct": self.daily_loss_limit_pct,
            "default_stop_pct": self.default_stop_pct, "max_trades": self.max_trades,
        }
