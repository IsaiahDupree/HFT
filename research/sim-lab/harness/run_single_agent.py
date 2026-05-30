#!/usr/bin/env python
"""
run_single_agent.py — THE single-agent proof.

Replicates the source-video pattern on SIM money: one OpenAI LLM-trader gets a
capsule of sim capital and trades a real recent crypto window through a sim perp
broker on a 60-second heartbeat, with a hard time-stop, always-on protective
stops, and a daily-loss kill switch. Scored on realized +$ / drawdown / win-rate
and appended to the treasury ledger.

This is the gate: if one agent can be made to behave and prove an edge over many
real windows, the SAME machinery scales to hundreds of capsules in the arena.
Real data, real model calls, real sim execution — no mocks.

    python harness/run_single_agent.py --symbol BTC-USD --capital 100 \
        --bars 120 --warmup 15 --heartbeat 3 --model gpt-4o
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openai import OpenAI

from core.marketdata import load_replay
from core.capsule import Capsule, Stage
from core.session import simulate
from core.treasury import record_run
from core.agents.openai_trader import OpenAITraderAgent
from harness.openai_key import load_openai_key


def run(args) -> int:
    print(f"\n┌── single-agent sim · {args.symbol} · ${args.capital:.0f} sim capital "
          f"· model={args.model}", flush=True)
    replay = load_replay(product=args.symbol, granularity=60, bars=args.bars)
    print(f"│   loaded {len(replay)} real 1m candles "
          f"(price now ≈ ${replay.current.close:,.2f})", flush=True)

    capsule = Capsule(
        capital=args.capital, stage=Stage.SIM, label=args.symbol,
        max_position_pct=args.max_position_pct, max_leverage=args.max_leverage,
        daily_loss_limit_pct=args.daily_loss_limit, default_stop_pct=args.default_stop,
        max_trades=args.max_trades)
    agent = OpenAITraderAgent(client=OpenAI(api_key=load_openai_key()), model=args.model)

    res = simulate(replay, capsule, agent, warmup=args.warmup, heartbeat=args.heartbeat,
                   fee_bps=args.fee_bps, verbose=True,
                   log=lambda m: print(m, flush=True))

    record_run(capsule=capsule.to_dict(), score=res.score.to_dict(), events=res.events,
               meta={"agent": agent.name, "model": args.model, "symbol": args.symbol,
                     "bars": len(replay), "warmup": args.warmup,
                     "heartbeat_bars": args.heartbeat, "halted": res.halted,
                     "data_source": "coinbase 1m replay", "venue": "sim_perp",
                     "run_kind": "single"})

    print("│")
    print(f"│   RESULT  {res.score.summary()}")
    print(f"│   capsule {capsule.capsule_id} · stage={capsule.stage.value} · "
          f"{'HALTED' if res.halted else 'completed'}")
    print("└── recorded to data/treasury/ledger.jsonl\n", flush=True)

    if res.score.pnl_usd > 0 and res.score.max_drawdown_pct < capsule.daily_loss_limit_pct * 100:
        print(f"✅ PROFITABLE this window (+${res.score.pnl_usd:.2f}). Run the multi-window "
              f"evaluator next — aggregate green is what justifies promotion sim→paper.")
    else:
        print("➖ Not profitable this window. The loop, gate, and ledger all worked — this is "
              "the unit we now tune & evaluate across many windows (harness/run_eval.py).")
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Single-agent sim trading proof.")
    ap.add_argument("--symbol", default="BTC-USD")
    ap.add_argument("--capital", type=float, default=100.0)
    ap.add_argument("--bars", type=int, default=120, help="real 1m candles to replay (<=300)")
    ap.add_argument("--warmup", type=int, default=15, help="history bars before first decision")
    ap.add_argument("--heartbeat", type=int, default=3, help="decide every N bars (minutes)")
    ap.add_argument("--model", default="gpt-4o")
    ap.add_argument("--max-position-pct", type=float, default=0.70)
    ap.add_argument("--max-leverage", type=float, default=10.0)
    ap.add_argument("--daily-loss-limit", type=float, default=0.25)
    ap.add_argument("--default-stop", type=float, default=0.015)
    ap.add_argument("--max-trades", type=int, default=40)
    ap.add_argument("--fee-bps", type=float, default=5.0)
    return ap


if __name__ == "__main__":
    sys.exit(run(build_parser().parse_args()))
