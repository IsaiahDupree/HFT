"""
Real unit tests for the sim perp broker P&L / stop / liquidation math.
No mocks — synthetic but exact candles with hand-computed expected outcomes.
Run: python -m pytest tests/ -q   (or)   python tests/test_sim_broker.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.marketdata import Candle
from core.sim_broker import SimPerpBroker


def _c(ts, o, h, l, cl):
    return Candle(ts=ts, open=o, high=h, low=l, close=cl, volume=1.0)


def test_long_profit_no_fee():
    b = SimPerpBroker(starting_capital=100.0, fee_bps=0.0)
    b.open("LONG", margin_usd=100, leverage=1, price=100.0, ts=0, stop_pct=None, tp_pct=None)
    # +10% move on qty=1 → +$10
    b.close(110.0, ts=60)
    assert round(b.realized_pnl(), 6) == 10.0
    assert round(b.equity(110.0), 6) == 110.0


def test_short_profit_no_fee():
    b = SimPerpBroker(starting_capital=100.0, fee_bps=0.0)
    b.open("SHORT", margin_usd=100, leverage=1, price=100.0, ts=0, stop_pct=None, tp_pct=None)
    b.close(90.0, ts=60)               # price down 10% → short gains $10
    assert round(b.realized_pnl(), 6) == 10.0


def test_stop_triggers_intrabar():
    b = SimPerpBroker(starting_capital=100.0, fee_bps=0.0)
    b.open("LONG", margin_usd=100, leverage=1, price=100.0, ts=0, stop_pct=0.05, tp_pct=None)
    # stop at 95; a bar that dips to 94 must fill the stop at 95 → -$5
    b.step(_c(60, 99, 99, 94, 98))
    assert b.position is None
    assert round(b.realized_pnl(), 6) == -5.0


def test_leverage_amplifies_and_fees_apply():
    b = SimPerpBroker(starting_capital=100.0, fee_bps=10.0)   # 10 bps/side
    b.open("LONG", margin_usd=50, leverage=4, price=100.0, ts=0, stop_pct=None, tp_pct=None)
    # notional 200 → qty 2; +1% to 101 → +$2 gross; fees = 200*0.001*2 sides = $0.40
    b.close(101.0, ts=60)
    assert round(b.realized_pnl(), 6) == round(2.0 - 0.40, 6)


def test_liquidation_caps_loss():
    b = SimPerpBroker(starting_capital=100.0, fee_bps=0.0, maint_margin_frac=0.0)
    b.open("LONG", margin_usd=100, leverage=10, price=100.0, ts=0, stop_pct=None, tp_pct=None)
    # 10x → liquidation ~10% down (=90). A crash bar to 80 must liquidate at ~90, not 80.
    b.step(_c(60, 95, 95, 80, 82))
    assert b.position is None
    assert round(b.realized_pnl(), 4) == -100.0      # lose exactly the margin, not more


def _run():
    fns = [v for k, v in globals().items() if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n{len(fns)} sim-broker tests passed.")


if __name__ == "__main__":
    _run()
