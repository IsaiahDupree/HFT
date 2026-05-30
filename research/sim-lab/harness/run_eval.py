#!/usr/bin/env python
"""
run_eval.py — prove it OVER TIME, not on one lucky window.

Runs the same agent across several real markets (different recent price action),
each as an independent capsule, then aggregates. A single green window means
nothing; consistent risk-adjusted green across windows is what earns a promotion
sim→paper. This is the scientific gate before any real money.

    python harness/run_eval.py --symbols BTC-USD,ETH-USD,SOL-USD,DOGE-USD,XRP-USD \
        --capital 100 --bars 120 --heartbeat 3 --model gpt-4o
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openai import OpenAI

from core.marketdata import load_replay
from core.capsule import Capsule, Stage
from core.session import simulate
from core.treasury import record_run
from core.agents.openai_trader import OpenAITraderAgent
from harness.openai_key import load_openai_key


_TF = {60: ("1m", 1), 300: ("5m", 5), 900: ("15m", 15), 3600: ("1h", 60)}


def eval_symbol(symbol: str, args, client) -> dict:
    try:
        replay = load_replay(product=symbol, granularity=args.granularity, bars=args.bars)
    except Exception as e:
        return {"symbol": symbol, "error": str(e)}
    capsule = Capsule(capital=args.capital, stage=Stage.SIM, label=symbol,
                      max_position_pct=args.max_position_pct, max_leverage=args.max_leverage,
                      daily_loss_limit_pct=args.daily_loss_limit,
                      default_stop_pct=args.default_stop, max_trades=args.max_trades)
    agent = OpenAITraderAgent(client=client, model=args.model)
    tf, bar_min = _TF.get(args.granularity, ("1m", 1))
    res = simulate(replay, capsule, agent, warmup=args.warmup, heartbeat=args.heartbeat,
                   fee_bps=args.fee_bps, timeframe=tf, bar_minutes=bar_min, verbose=False)
    record_run(capsule=capsule.to_dict(), score=res.score.to_dict(), events=res.events,
               meta={"agent": agent.name, "model": args.model, "symbol": symbol,
                     "halted": res.halted, "data_source": "coinbase 1m replay",
                     "venue": "sim_perp", "run_kind": "eval"})
    return {"symbol": symbol, "score": res.score, "halted": res.halted}


def run(args) -> int:
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    client = OpenAI(api_key=load_openai_key())
    print(f"\n══ multi-window eval · agent=openai-trader · model={args.model} · "
          f"{len(symbols)} markets · ${args.capital:.0f} each ══\n", flush=True)

    results = []
    with ThreadPoolExecutor(max_workers=min(6, len(symbols))) as ex:
        futs = {ex.submit(eval_symbol, s, args, client): s for s in symbols}
        for fut in as_completed(futs):
            r = fut.result()
            results.append(r)
            if "error" in r:
                print(f"  {r['symbol']:<10} ERROR {r['error'][:60]}", flush=True)
            else:
                sc = r["score"]
                mark = "✅" if sc.pnl_usd > 0 else "➖"
                print(f"  {mark} {r['symbol']:<10} {sc.summary()}"
                      f"{'  [HALTED]' if r['halted'] else ''}", flush=True)

    scored = [r for r in results if "score" in r]
    if not scored:
        print("\nNo successful windows."); return 1
    n = len(scored)
    green = sum(1 for r in scored if r["score"].pnl_usd > 0)
    total_pnl = sum(r["score"].pnl_usd for r in scored)
    avg_pnl_pct = sum(r["score"].pnl_pct for r in scored) / n
    avg_dd = sum(r["score"].max_drawdown_pct for r in scored) / n
    avg_win = sum(r["score"].win_rate for r in scored) / n
    mean_score = sum(r["score"].score for r in scored) / n

    print("\n  " + "─" * 60)
    print(f"  AGGREGATE  windows={n}  green={green}/{n}  total PnL ${total_pnl:+.2f}  "
          f"avg PnL {avg_pnl_pct:+.2f}%  avg maxDD {avg_dd:.2f}%  "
          f"avg win {avg_win*100:.0f}%  mean score {mean_score:.2f}")

    promote = (green / n >= 0.6) and (avg_pnl_pct > 0) and (avg_dd < args.daily_loss_limit * 100)
    if promote:
        print(f"  ✅ PROMOTION-WORTHY: ≥60% green, net positive, drawdown in budget. "
              f"Repeat over more days → graduate this agent sim→paper.")
    else:
        print(f"  ➖ NOT yet promotion-worthy. Tune persona/heartbeat/edge filters and re-evaluate. "
              f"(This is the honest, real-data verdict — exactly the gate we want.)")
    print(flush=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description="Multi-window agent evaluation.")
    ap.add_argument("--symbols", default="BTC-USD,ETH-USD,SOL-USD,DOGE-USD,XRP-USD")
    ap.add_argument("--capital", type=float, default=100.0)
    ap.add_argument("--bars", type=int, default=120)
    ap.add_argument("--granularity", type=int, default=300, choices=[60, 300, 900, 3600],
                    help="candle seconds: 60=1m, 300=5m, 900=15m, 3600=1h")
    ap.add_argument("--warmup", type=int, default=15)
    ap.add_argument("--heartbeat", type=int, default=2)
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
