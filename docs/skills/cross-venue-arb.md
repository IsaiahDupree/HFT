# Cross-venue arb — Polymarket ⇄ Coinbase

The `cross_venue_arbs` table links a Polymarket market (`condition_id`) to a
Coinbase product (`product_id`) so a Polymarket binary outcome can be
priced against a real spot price.

## Table shape

```sql
CREATE TABLE cross_venue_arbs (
  id                    INTEGER PRIMARY KEY,
  poly_condition_id     TEXT NOT NULL,
  poly_question         TEXT,
  coinbase_product_id   TEXT NOT NULL,
  pairing_kind          TEXT NOT NULL,  -- 'price_threshold' | 'event_outcome' | 'hedge' | 'pure_arb'
  threshold_value       REAL,            -- e.g. 60000 for "BTC > $60k"
  threshold_direction   TEXT,            -- 'gt' | 'gte' | 'lt' | 'lte'
  expiry_iso            TEXT,
  agent_id              INTEGER,
  strategy_id           INTEGER,
  rationale             TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  ...
);
```

## Pairing kinds

| Kind | Use case |
|------|----------|
| **`price_threshold`** | Polymarket: "BTC > $60k by Dec 31". Coinbase: BTC-USD spot. Compute model probability from spot vs threshold, compare to Polymarket YES price. |
| **`event_outcome`** | Polymarket: "Will Coinbase list X". Pair with the X-USD product for liquidity signal once listed. |
| **`hedge`** | Polymarket: directional bet. Coinbase: futures/spot offset to cap downside. |
| **`pure_arb`** | Identical-payoff instrument on both sides — very rare. |

## Aurora Cross agent

Seeded by `npm run seed:coinbase`. Two strategies:
- **`btc-price-threshold-fade`** — fade YES when Polymarket implied prob >> model prob from BTC spot.
- **`eth-merge-narrative`** — narrative-driven; uses Coinbase ETH-USD trend as a proxy.

Initial seed uses placeholder `seed-*` condition_ids — replace with real
Polymarket condition_ids when the markets are identified.

## Workflow to add a new pairing

1. Find the Polymarket market: browse `/markets` or search via the Gamma API. Capture the `condition_id`.
2. Pick the Coinbase product (`BTC-USD`, `ETH-USD`, …) that prices the underlying.
3. Insert a `cross_venue_arbs` row:
   ```sql
   INSERT INTO cross_venue_arbs
     (poly_condition_id, poly_question, coinbase_product_id, pairing_kind,
      threshold_value, threshold_direction, expiry_iso, agent_id, rationale)
   VALUES (
     '<condition_id>', 'Will BTC be above $80k on 2026-12-31?',
     'BTC-USD', 'price_threshold',
     80000, 'gt',
     '2026-12-31T23:59:59Z',
     <aurora_cross_agent_id>,
     'Threshold market — fade overpriced YES tail'
   );
   ```
4. Add a custom evaluator under `scripts/research-loop.ts:evaluators` if the
   pairing needs strategy-specific logic.

## Submitting cross-venue orders

Submit each leg independently through the router. There's no atomic
two-venue order primitive — they're separate venues, separate adapters.

```ts
const router = getDefaultRouter();

// Leg 1: short the overpriced Polymarket YES via FOK basket
const poly = await router.submit({
  clientOrderId: `arb-poly-${id}`,
  venue: 'polymarket',
  type: 'FOK_BASKET',
  symbol: conditionId,
  side: 'BUY',
  size: 1,
  refPrice: 0.5,
  capsuleId: capId,
  metadata: { arb: <SingleMarketArb>, sizeUsd: 25 },
});

// Leg 2: hedge on Coinbase spot
if (poly.ok) {
  await router.submit({
    clientOrderId: `arb-cb-${id}`,
    venue: 'coinbase',
    type: 'MARKET',
    symbol: 'BTC-USD',
    side: 'BUY',
    size: 0.0004,           // $25 at ~$60k BTC
    refPrice: 60000,
    capsuleId: capId,
  });
}
```

If leg 2 fails after leg 1 succeeded, you have a one-sided position. Add
defensive handling: catch the leg-2 verdict, and if it's not ok, either
retry once or engage the kill switch. **Do NOT submit leg-2 unconditionally
in a loop** — the idempotency gate will reject the duplicate clientOrderId,
which is the right behavior.

## What's NOT done yet

- **Atomic 2-venue submit primitive.** Today you submit each leg
  independently. A `router.submitBundle([leg1, leg2])` wrapper that aborts
  on any leg failure would be a nice add.
- **Spot-price oracle feeding the threshold model.** The strategies need
  current BTC/ETH spot to evaluate. Pulling from `coinbase_snapshots` works
  but is stale up to the last snapshot interval.
