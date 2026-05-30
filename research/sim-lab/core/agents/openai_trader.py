"""
OpenAITraderAgent — the LLM-as-trader brain (the video pattern, OpenAI edition).

Each heartbeat it sends the persona + the live market context to OpenAI and gets
back ONE structured intent. The key is scavenged off the land from local repos
(see harness/openai_key.py). The brain is deliberately thin: all risk enforcement
lives in core/risk.py, all execution in core/sim_broker.py — so the exact same
agent can later trade paper, then real, without touching this file.
"""
from __future__ import annotations

import json
from typing import Optional

from openai import OpenAI

from .base import MarketContext, TradeDecision
from .prompts import DEFAULT_PERSONA, DECISION_INSTRUCTION, build_context_block


class OpenAITraderAgent:
    def __init__(self, client: OpenAI, model: str = "gpt-4o",
                 persona: str = DEFAULT_PERSONA, name: str = "openai-trader",
                 temperature: float = 0.4):
        self.client = client
        self.model = model
        self.persona = persona
        self.name = name
        self.temperature = temperature
        self.last_error: Optional[str] = None

    def decide(self, ctx: MarketContext) -> TradeDecision:
        messages = [
            {"role": "system", "content": self.persona},
            {"role": "user", "content": build_context_block(ctx) + "\n\n" + DECISION_INSTRUCTION},
        ]
        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                temperature=self.temperature,
                max_tokens=400,
                response_format={"type": "json_object"},
                messages=messages,
            )
            raw = resp.choices[0].message.content or "{}"
            data = json.loads(raw)
        except Exception as e:                       # network/parse → safe HOLD
            self.last_error = str(e)
            return TradeDecision(action="HOLD", rationale=f"brain_error: {e}", confidence=0.0)

        action = str(data.get("action", "HOLD")).upper()
        if action not in ("OPEN", "CLOSE", "HOLD"):
            action = "HOLD"
        side = data.get("side")
        side = side.upper() if isinstance(side, str) else None
        return TradeDecision(
            action=action,
            side=side if side in ("LONG", "SHORT") else None,
            margin_usd=_num(data.get("margin_usd")),
            leverage=_num(data.get("leverage")),
            stop_pct=_num(data.get("stop_pct")),
            tp_pct=_num(data.get("tp_pct")),
            confidence=_num(data.get("confidence")) or 0.5,
            rationale=str(data.get("rationale", ""))[:240],
        )


def _num(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None
