# Migration targets — concrete next moves

A shortlist of actions backed by the verified repos. Each has an effort
estimate (relative — assumes the operator's familiar with the codebase) and a
clear deliverable. **Do these in order**; #1 is the highest leverage.

---

## 1. Subscribe to Polymarket's official real-time WS — ~1 day

**Why:** [`Polymarket/real-time-data-client`](https://github.com/Polymarket/real-time-data-client)
exposes named channels we don't have today, especially `clob_user` (authenticated
user-level fills/orders). Our hand-rolled `src/lib/polymarket/ws.ts` reads
top-of-book only.

**Deliverable:**
- Add `@polymarket/real-time-data-client` dependency.
- Create `src/lib/polymarket/realtime.ts` thin wrapper exposing typed `subscribeTrades()`, `subscribeUserChannel()`, `subscribeCryptoPrices()`.
- New page `/realtime` that streams `activity` + `crypto_prices` + (when authed) `clob_user` events into the UI.
- Reconciler bonus: subscribe to `clob_user` and update local `trades` table on every fill received instead of relying on poll-based reconciliation.

**Files to touch:**
- `package.json` — add dep
- `src/lib/polymarket/realtime.ts` — new
- `src/app/realtime/page.tsx` — new
- `src/app/api/realtime/route.ts` — new (SSE endpoint)
- `src/lib/reconcile/loop.ts` — add `reconcilePolymarketUser()` that reads recent user-channel events

---

## 2. Mirror `agent-skills` for our own workspace — ~half a day

**Why:** [`Polymarket/agent-skills`](https://github.com/Polymarket/agent-skills)
established a great format for AI-agent-consumable knowledge:
`SKILL.md` (≤200 lines, loaded first) + topic-specific `*.md` (loaded on
demand). When Claude Code opens this repo in a fresh session, having our
patterns in that format makes deep work cheap.

**Deliverable:**
- `docs/skills/SKILL.md` — quick reference: env vars, key surfaces, the
  3-line "how to add a venue", "how to halt", "how to backtest".
- `docs/skills/safety-gates.md` — the 5-gate router pipeline, every reject code, when each fires.
- `docs/skills/cross-venue-arb.md` — how `cross_venue_arbs` rows + Aurora
  Cross agent work.
- `docs/skills/release-stages.md` — the promotion ladder.
- `docs/skills/capsules.md` — capsule shape, gates, lifecycle.

Each skill file is ~200 lines or less. The structure should be consumable by
any LLM (not Claude-specific) — they're docs first.

**Bonus:** Polymarket's own files (auth, market-data, websocket, ctf-operations,
bridge, gasless) are also worth copying verbatim into `docs/skills/polymarket/`
as we extend integration. They're MIT-licensed.

---

## 3. Migrate to `@polymarket/clob-client-v2` — ~half a day

**Why:** We pin `@polymarket/clob-client@^4.21.0`. That npm package corresponds
to [`Polymarket/clob-client`](https://github.com/Polymarket/clob-client) which
is **archived**. The current generation lives at
[`Polymarket/clob-client-v2`](https://github.com/Polymarket/clob-client-v2)
(npm: `@polymarket/clob-client-v2`).

**Deliverable:**
- Add `@polymarket/clob-client-v2` alongside the old dep.
- Build a feature-flagged switch in `src/lib/polymarket/execute.ts:getClobClient()` (env: `POLYMARKET_CLOB_V2=1`).
- Run `npm run test:endpoints` against both.
- Run a live destructive sweep against both with `ALLOW_TRADE=1` + a tiny size.
- Once green, remove the v4 dep.

**Risk:** the API surface in v2 may differ — the `createAndPostMarketOrder`
signature might change. Read the v2 README + run the sweep before swapping
the production path.

---

## 4. Add a `SimAdapter` venue — ~1 hour

**Why:** Patterned after Hummingbot's `paper_trade_exchange`. Our
release-stages ladder has `sim` → `paper` → `live` but no actual `sim` venue
adapter exists. A no-op adapter that records intended orders to
`order_events` with `venue=sim` lets a `sim`-staged strategy submit through
the router without touching real venues.

**Deliverable:**
- `src/lib/venue/adapters/sim.ts` — `SimAdapter implements VenueAdapter` that
  always succeeds, records the order, returns a fake `brokerOrderId`.
- Register in `getDefaultRouter()`.
- Add test in `tests/integration/router.test.ts`.

---

## 5. Add fill-realism layer to backtester — ~2 days

**Why:** Borrowing from
[`nkaz001/hftbacktest`](https://github.com/nkaz001/hftbacktest). Our backtester
fills at midpoint, which over-counts profitability on Coinbase strategies.

**Deliverable:**
- `src/lib/backtest/fill-model.ts` exporting:
  - `latencyDelay(ms)` — pushes the fill decision N snapshots forward
  - `walkBook(side, size, snapshotBook)` — fills against the visible bid/ask in `coinbase_snapshots` instead of midpoint
- Wire as a `runBacktest()` option: `runBacktest(snaps, decide, { fillModel: 'midpoint' | 'walk_book' })`.
- Add tests.

This is concept-port, not code-port — hftbacktest is Rust.

---

## 6. Add capability flags to `VenueAdapter` — ~1 hour

**Why:** Borrowed from ccxt. As we add venues, the router needs a way to skip
asking adapters about features they don't support.

**Deliverable:**
- Add to `VenueAdapter`:
  ```ts
  readonly capabilities: {
    market: boolean;
    limit: boolean;
    fok: boolean;
    cancel: boolean;
    cancelAll: boolean;
    userChannelWs: boolean;
  };
  ```
- Router checks `adapter.capabilities[order.type.toLowerCase()]` before calling submit.
- Surface in `/api/venue/health`.

---

## Notes on what we're NOT doing

- **Visual strategy builders (Superalgos)** — we have spec-as-JSON. Visual is a different paradigm and adds complexity without payoff for our scale.
- **Telegram bot (OctoBot)** — out of scope until we have multi-operator ops.
- **`Polymarket/ts-sdk`** — pre-release. Re-evaluate when it hits 1.0; it likely supersedes clob-client-v2 + real-time-data-client as a unified replacement.
- **Cryptofeed normalization** — overkill at 2 venues. Reconsider at 5+.
- **freqtrade-style hyperopt** — could be a research-loop extension later, but not until we have enough `market_snapshots` for backtest results to be meaningful.
