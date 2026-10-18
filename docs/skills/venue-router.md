# Venue router — submitting orders + adding venues

The router is the only sanctioned path to submit an order. It enforces
idempotency, halt, capsule, and global risk gates before dispatching to a
`VenueAdapter`.

## Submitting an order

```ts
import { getDefaultRouter } from "@/lib/venue/router";

const router = getDefaultRouter();
const verdict = await router.submit({
  clientOrderId: crypto.randomUUID(),  // idempotency key — MUST be fresh
  venue: "sim",                         // 'sim' | 'polymarket' | 'coinbase'
  symbol: "BTC-USD",
  side: "BUY",                          // 'BUY' | 'SELL'
  type: "MARKET",                       // 'MARKET' | 'LIMIT' | 'FOK_BASKET'
  size: 1,
  refPrice: 100,                        // last/mid for risk math
  capsuleId: "<uuid-or-omit>",
  agentId: 5,                            // optional, for attribution
  strategyVersionId: 42,                 // optional, ties order to a version
  metadata: { note: "optional free-form" },
});
```

`verdict` is one of:
- `{ ok: true, brokerOrderId, status: 'filled', usdEquivalent, raw }`
- `{ ok: true, status: 'dry_run', reason, usdEquivalent }`
- `{ ok: false, code, reason, usdEquivalent? }`

See [safety-gates.md](./safety-gates.md) for every reject code.

## REST equivalent

```bash
curl -X POST http://localhost:3000/api/venue/submit \
  -H 'content-type: application/json' \
  -d '{
    "clientOrderId": "demo-1",
    "venue": "sim",
    "symbol": "BTC-USD",
    "side": "BUY",
    "type": "MARKET",
    "size": 1,
    "refPrice": 100,
    "capsuleId": "<uuid>"
  }'
```

## Adapter capabilities (ccxt-style)

Each adapter declares what it supports. The router rejects with
`UNSUPPORTED` if a capability doesn't match the order type.

| Adapter | market | limit | fok | cancel | cancelAll | userChannelWs |
|---------|:------:|:-----:|:---:|:------:|:---------:|:-------------:|
| **sim** | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| **polymarket** | – | – | ✓ | – | ✓ | – |
| **coinbase** | ✓ | – | – | ✓ | ✓ | – |

`userChannelWs` is reserved for the upcoming integration with `@polymarket/real-time-data-client`.

## Health + audit chain

```bash
curl http://localhost:3000/api/venue/health | jq
```

Returns:
```json
{
  "adapters": [{ "ok": true, "name": "sim", "details": {...} }, ...],
  "risk_engine": { "halted": false, "halt_reason": "" },
  "order_event_chain": { "ok": true, "nChecked": 17, "brokenAtSeq": null, ... }
}
```

`order_event_chain.ok=false` means someone tampered with the `order_events`
table. The audit log is hash-chained: any row whose recomputed hash doesn't
match (or whose `prev_hash` doesn't point at the previous row's `hash`)
breaks the chain at that seq.

## Adding a third venue

1. Create `src/lib/venue/adapters/<venue>.ts` implementing `VenueAdapter`:
   ```ts
   export class FooAdapter implements VenueAdapter {
     readonly name = "foo";
     readonly capabilities: VenueCapabilities = {
       market: true, limit: false, fok: false,
       cancel: true, cancelAll: true, userChannelWs: false,
     };
     isAvailable() { return Boolean(process.env.FOO_API_KEY); }
     async submit(order: UnifiedOrder): Promise<SubmitVerdict> { ... }
     async cancel(brokerOrderId: string) { ... }
     async cancelAll() { ... }
     async health() { ... }
   }
   ```

2. Register in `src/lib/venue/router.ts:getDefaultRouter()`:
   ```ts
   router.registerAdapter(new FooAdapter());
   ```

3. Add per-venue safety gates **inside `submit()`** (FOO_ALLOW_TRADE etc.) —
   same pattern as `executeCoinbaseMarket()`.

4. Add tests under `tests/unit/foo-*.test.ts` and `tests/integration/foo-execute-safety.test.ts`.

5. Add a sweep script `scripts/test-foo-endpoints.ts` if the venue has more
   than one or two endpoints worth verifying.

6. Update [SKILL.md](./SKILL.md) capabilities table + this file.

The adapter auto-registers with the kill switch on `router.registerAdapter()`,
so `haltAll()` cancels its open orders without extra wiring.

## Don't

- **Don't reach into adapters directly** — go through the router. The router
  is what writes `order_events`. Bypassing means missing audit rows.
- **Don't construct `ExecutionRouter` outside of `getDefaultRouter()`** in
  production code. Tests can construct their own with mocked adapters.
- **Don't omit `clientOrderId`** — even a Math.random() string is better
  than nothing. Without it, the router treats every call as a unique order
  (which is fine) but you lose the ability to dedup retries.
