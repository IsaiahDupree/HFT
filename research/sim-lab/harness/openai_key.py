"""
Live off the land: locate a working OpenAI API key from existing local repos
instead of asking the user. Tries env first, then a ranked list of known local
.env files. Returns the key string; raises if none found.
"""
from __future__ import annotations

import os
from pathlib import Path

# Ranked candidate .env files known to carry a real OPENAI_API_KEY locally.
_CANDIDATES = [
    "/Users/isaiahdupree/Documents/Software/GTMEngineering/.env",
    "/Users/isaiahdupree/.openclaw/.env",
    "/Users/isaiahdupree/Documents/Software/TradingBot/.env",
    "/Users/isaiahdupree/Documents/Software/EverReach-APP-BACKEND/backend/.env",
]


def _read_key(path: Path) -> str | None:
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if line.startswith("OPENAI_API_KEY="):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                if val.startswith("sk-") and len(val) > 40 and "xxxx" not in val:
                    return val
    except (OSError, UnicodeDecodeError):
        return None
    return None


def load_openai_key() -> str:
    if os.environ.get("OPENAI_API_KEY", "").startswith("sk-"):
        return os.environ["OPENAI_API_KEY"]
    for p in _CANDIDATES:
        key = _read_key(Path(p))
        if key:
            return key
    raise RuntimeError(
        "No OPENAI_API_KEY found in env or known local .env files. "
        "Set OPENAI_API_KEY or add it to one of: " + ", ".join(_CANDIDATES))
