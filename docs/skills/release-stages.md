# Release stages — strategy_version promotion ladder

Every `strategy_versions` row has a `stage` column. The stage is what makes
the sim → paper → live transition explicit, auditable, and reversible.

## Stages

| Stage | What it means | Where it submits |
|-------|---------------|------------------|
| **`sim`** | Never trades real capital. Runs against snapshots only. | SimAdapter (or no submit at all). |
| **`paper`** | Submits through paper/sim venues. | SimAdapter. |
| **`live_eligible`** | Backtest passed; awaiting capsule binding. | None until promoted. |
| **`live`** | Actively trades against allocated capsule capital. | polymarket / coinbase. |
| **`restricted`** | Flagged. Manual hold (drawdown, broken auth, suspected bug). | None. |

## Promotion ladder

```
       sim
        ↓
       paper
        ↓
       live_eligible
        ↓
       live      ⇄ paper (demote)
       any ──────→ restricted
       restricted → sim
```

`setVersionStage()` enforces this ladder. Set `force: true` to skip — but
log a `rationale` when you do.

## API

```bash
# Promote version 42 sim → paper
curl -X POST http://localhost:3000/api/strategies/<strategy_id>/stage \
  -H 'content-type: application/json' \
  -d '{
    "versionId": 42,
    "stage": "paper",
    "rationale": "ready for paper after 7-day sim run"
  }'

# Emergency demote live → paper, bypassing the ladder
curl -X POST http://localhost:3000/api/strategies/<strategy_id>/stage \
  -H 'content-type: application/json' \
  -d '{
    "versionId": 42,
    "stage": "restricted",
    "force": true,
    "rationale": "PnL diverged from backtest — investigate"
  }'
```

Every stage change writes a `stage-change` event to `evolution_log`. Query
the history of a version with:

```sql
SELECT created_at, summary, payload_json
FROM evolution_log
WHERE event_type = 'stage-change' AND to_version_id = 42
ORDER BY created_at;
```

## How to integrate stage into your strategy code

The router doesn't enforce stage today — it's advisory. The pattern is for
the caller to check before submitting:

```ts
import { canTradeLive, canTradePaper } from "@/lib/stages/gate";

if (!canTradeLive(versionId)) {
  // either submit through SimAdapter (venue='sim') or skip
  return;
}
await router.submit({ ..., venue: 'polymarket' });
```

For an even tighter guard, set the capsule's `allowed_venues` to match the
stage:

| Stage | Capsule `allowed_venues` |
|-------|--------------------------|
| `sim` / `paper` | `['sim']` |
| `live_eligible` | `['sim']` (still rejects live submits) |
| `live` | `['polymarket','coinbase']` |

Then a strategy that ignores the stage check and tries to submit to a real
venue gets caught at the capsule gate with `CAPSULE_VENUE_NOT_ALLOWED`.

## Why this exists

Without explicit stages, "I'll test this strategy and then go live" is a
human discipline — easy to skip. With stages:
- `is_current=1` doesn't imply "trades live capital." The stage does.
- Every promotion is a logged decision with rationale.
- A version can sit at `live_eligible` indefinitely without risk; the
  router won't let it touch real capital until both the stage AND a
  capsule with matching allowed_venues say so.
