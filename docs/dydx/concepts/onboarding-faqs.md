# Onboarding FAQs – dYdX Documentation

> Source: https://docs.dydx.xyz/concepts/onboarding-faqs

## Background

**How does the network work?**
dYdX Chain consists of full nodes maintaining in-memory order books. Validators with delegated tokens participate in block building, taking turns proposing trade blocks every ~1 second. The proposer creates matches from their mempool, which validators accept/reject via CometBFT consensus. An indexer application reads data from full nodes and exposes it through REST and WebSocket APIs.

**Full node vs validator?**
Full nodes receive network data via gossip but don't participate in consensus. Validators participate in consensus by broadcasting signed votes.

**Benefits of running your own full node as a market maker?**
Eliminates latency between order placement and network gossip. Also enables full-node streaming for real-time orderbook updates and fills.

**Block time?** ~1 second.

**What is an indexer?**
A read-only service consuming real-time dYdX Chain data into a database. Exposes data via HTTPS REST + WebSocket streaming.

**Finality?**
On fill, a block proposer proposes a block containing the fill (visible to the whole network), which then undergoes consensus. After validators vote and the block finalises, indexer services communicate the fill. Place orders with "Good-Til-Block" at current height and adjust prices once per block.

## Trading

**Order types?** Short-Term (programmatic, low-latency, short expirations) and stateful (retail, longer expirations, exist on-chain).

**Orderbook for short-term orders?** Each validator runs an in-memory orderbook. Users place trades via decentralized front-ends or TS/Py clients directly to full nodes. Matches proposed by the selected block proposer; committed if accepted by ⅔+ of validator stake weight.

**Why should market makers only use short-term orders?** Short-Term orders match immediately on entering the mempool. Stateful only after block inclusion. Short-Term have superior time priority, less restrictive rate limits, support replacement, allow immediate cancellation, no sequence numbers.

**How to place a short-term order?** Use the latest typescript client; see `order.proto` for parameter definitions. Reference validator clients for advanced cases.

**Confirm proposer placed your order?** Either the proposer proposed/filled it in a block, or has it in their mempool.

**Confirm cancellation?** Best-effort until expiry. Block height is the only reliable finality. The indexer does **not** send a websocket notification when a short-term order expires.

**Replace an order?** Reuse the short-term order placement function with same order ID + good_til_block ≥ previous. Previous fill amounts count.

**Fills computed on block finalisation?** Yes. Short-term order place/cancel events stream when the full node receives them.

**Matched between blocks?** Each node attempts to match orders as they arrive. Removal across the whole network only happens at expiry.

**Order priority and cancels?** Short-term matches when received. Stateful are matched at end of block when received. Stateful placements/cancels process after short-term operations.

**Cancellation mechanism?** Short-term: validators remove from their book on receipt (if no match exists). Long-term: once a stateful cancellation is included in a block, the order is canceled.

**Why is cancel slower than place?** A placement only needs to reach a single validator to match; a cancel must reach all future block proposers.

**Order status transitions (Indexer)?**
- Short-term: `BEST_EFFORT_OPENED` → `OPEN` (if matched in block) → `FILLED` | `BEST_EFFORT_CANCELED` | `CANCELED` (on expiry).
- Long-term: `OPEN` (after block inclusion) → `FILLED` | `CANCELED` (after cancellation block inclusion).

**Subaccounts on dYdX Chain?** Each address has subaccounts `subaccount0`, `subaccount1`, … Fund subaccounts via frontend auto-sweep or backend USDC transfers.

**Gas to create new subaccount?** Yes. Both USDC and native dYdX can pay gas. USDC must be in the main wallet, not another subaccount.

**Subaccount impact on rate limits?** Rate limits are per account, not per subaccount.

**Competing for liquidation orders?** Running a full-node gives access to a liquidations daemon with metrics on eligible accounts. Not documented — read the code.

## Full Nodes & Validators

**Throughput / latency on a self-hosted full node?** Up to 1500 orders/sec under load testing. Latency depends on the block proposer's location.

**Validator P2P?** Public P2P network.

**Order-to-trade latency?** Time to reach the proposer (location-dependent) plus matching time ≥ ~0.8 s per block.

**Direct submit vs broadcast?** Direct to proposer is faster. Otherwise full-node vs validator is negligible unless that validator is the proposer.

**Validators with RPC for orders?** No — validators don't expose RPC endpoints for order submission.

## Indexer

**Reconstruct orderbook on start?** A co-located full node sends messages to the indexer when it receives orders via RPC or gossip. Updates on expire/match/cancel.

**Initial orderbook visibility?** Stateful orders are retained by full nodes and sent on cold-start. Short-term orders are not — within ~20 blocks the indexer achieves accurate visibility.

## MEV

**How will dYdX Chain handle MEV?** Cosmos infrastructure enables MEV-specific solutions. dYdX Chain measures MEV via a dashboard; initial steps include validator slashing.

**Finality of fills?** After block consensus finalises. Via full node you see each step; via indexer, you receive WebSocket updates as blocks confirm.

**Deliberately taking canceled orders?** Nodes should respect cancels as soon as they receive them. Failure to do so is treated as MEV; the dashboard tracks it.

## Pricing

**Oracle price?** Composed of Slinky (sidecar pulling external price data), Vote Extensions (validators submit price beliefs during Precommit), Consensus (Slinky aggregates), `x/prices` Module (state), and Params (external source configuration).

**Update frequency?** Slinky commits with a one-block delay. Most blocks see price updates when over ⅔ of validators correctly run Slinky.

**Historical prices in Slinky?** No. The `x/oracle` module stores only the most recently posted price. Use blockchain indexers or past blocks for history.

## Rewards

**Trading rewards?** Not controlled by dYdX. Recommendation: based primarily on total taker fees paid, with additional variables.

**Liquidity-provider rewards?** Not controlled by dYdX. Recommendation: maker rebate 0.5–1.1 bps based on nominal volume and volume share.
