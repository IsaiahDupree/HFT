"""
Treasury — the append-only capital ledger.

Every agent run (sim or real) writes one immutable record here: which capsule,
which agent/persona, the score, and the decisions made (the "why"). This is the
audit trail the ensemble allocator reads to decide who gets more capital, and
the record a human can inspect before any real money is risked.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List

LEDGER = Path(__file__).resolve().parents[1] / "data" / "treasury" / "ledger.jsonl"


def record_run(capsule: Dict[str, Any], score: Dict[str, Any],
               events: List[Dict[str, Any]], meta: Dict[str, Any]) -> dict:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    rec = {
        "recorded_at": int(time.time()),
        "capsule": capsule,
        "score": score,
        "n_events": len(events),
        "events": events,
        "meta": meta,
    }
    with LEDGER.open("a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def read_runs() -> List[dict]:
    if not LEDGER.exists():
        return []
    return [json.loads(ln) for ln in LEDGER.read_text().splitlines() if ln.strip()]
