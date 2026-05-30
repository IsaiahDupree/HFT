# Polymarket-official repos

Every public repo under [github.com/Polymarket](https://github.com/Polymarket),
with a note on whether/how we should use it. Verified live on 2026-05-25.

## Currently used by this project

- **[Polymarket/clob-client](https://github.com/Polymarket/clob-client)** — TypeScript, **archived**. We currently pin `@polymarket/clob-client@^4.21.0` (this repo). Migration target: clob-client-v2 (see below).

## Should integrate next

### [Polymarket/real-time-data-client](https://github.com/Polymarket/real-time-data-client)
- TS, MIT, 217 stars, v1.4.0 (Jul 25 2025).
- Subscribes to Polymarket's official WS service. Channels:
  - `activity` — trades, orders_matched
  - `comments`, reactions
  - `crypto_prices` / `crypto_prices_chainlink` — BTC, ETH, XRP, SOL, DOGE
  - `equity_prices` — AAPL, TSLA, MSFT, GOOGL, AMZN, META, NVDA, NFLX, PLTR…
  - `clob_user` — **authenticated user channel** (orders, fills)
- We currently have a hand-rolled `src/lib/polymarket/ws.ts`. Switching to the official client gets us the user channel + named topics for free.
- **Action:** add as a dep, build a thin wrapper in `src/lib/polymarket/realtime.ts`, swap `src/app/live` page to use it.

### [Polymarket/clob-client-v2](https://github.com/Polymarket/clob-client-v2)
- TS, MIT, 65 stars, v1.0.6 (May 2026), 18 releases.
- Current-generation CLOB client (we're on v1's archived predecessor).
- Same dual-auth model (L1 EIP-712 + L2 HMAC), same `createOrder`/`cancelAll`/etc surface.
- npm: `@polymarket/clob-client-v2`.
- **Action:** plan a migration. Add the new dep, swap `src/lib/polymarket/execute.ts:getClobClient()` to instantiate v2, run the endpoint sweep (`npm run test:endpoints`), then drop v4.

### [Polymarket/agent-skills](https://github.com/Polymarket/agent-skills)
- 137 stars, multi-language (mostly Markdown).
- A knowledge base of "skills" that AI agents load when integrating with Polymarket. Structure:
  - `SKILL.md` — quick-reference, ~200 lines (loaded first)
  - `authentication.md`, `order-patterns.md`, `market-data.md`, `websocket.md`, `ctf-operations.md`, `bridge.md`, `gasless.md` — progressive-disclosure deep dives
- **Action:** mirror the structure in our own `docs/skills/` for the workspace-specific patterns (capsules, kill switch, release stages, cross-venue arb). The Polymarket files themselves are perfect references for Claude Code when extending Polymarket integration.
- **Bonus:** if we expose our Polymarket Agents control plane via MCP, we could ship our own `polymarket-agents-skill` patterned after this repo.

## Should be aware of

### [Polymarket/ts-sdk](https://github.com/Polymarket/ts-sdk)
- TS, MIT, **0 stars, no releases, in beta**. 472 commits on main.
- Unified SDK consolidating clob-client + relayer + real-time + signing. Replaces the fragmented per-repo clients eventually.
- Monorepo: `packages/client`, `packages/types`, `packages/bindings`, `examples/react`. Requires Node ≥24.
- **Action:** don't migrate yet (pre-release), but track. When it hits 1.0, it likely supersedes `clob-client-v2` AND `real-time-data-client` in one shot.

### [Polymarket/py-sdk](https://github.com/Polymarket/py-sdk)
- Python, May 25 2026. Unified Python SDK — same role as `ts-sdk` but for Python consumers.
- **Action:** N/A for now (we're TS-only). If we ever add a Python research notebook, this is the dep.

### [Polymarket/polymarket-cli](https://github.com/Polymarket/polymarket-cli)
- Rust, April 28 2026. Browse markets, place orders, manage positions from the terminal. JSON output for agent piping.
- **Action:** *pattern* inspiration for our own `npm run` scripts surface. Concretely, the JSON-out pattern is something to copy — most of our scripts already do this implicitly via `console.log(JSON.stringify(...))`.

### [Polymarket/polymarket-subgraph](https://github.com/Polymarket/polymarket-subgraph)
- TS, Feb 13 2026. The Graph subgraph manifest for on-chain trade/volume/user/liquidity/market indexing.
- **Action:** if we ever need historical on-chain queries that the Data API doesn't cover (e.g. wallet-level fill history beyond what `Polygon/onchain.ts` watches), point at the public subgraph endpoint.

### [Polymarket/clob-order-utils](https://github.com/Polymarket/clob-order-utils)
- TS, Apr 27 2026. Utility to generate and sign CLOB orders.
- **Action:** check whether `src/lib/polymarket/sign.ts` could be replaced/thinned by this. If so, win.

### [Polymarket/builder-relayer-client](https://github.com/Polymarket/builder-relayer-client) + [Polymarket/builder-signing-sdk](https://github.com/Polymarket/builder-signing-sdk)
- TS clients for Polymarket's relayer API + builder header signing.
- **Action:** evaluate if these replace our hand-rolled relayer code (search for `relayer` in `src/lib/polymarket/`).

### [Polymarket/rs-clob-client-v2](https://github.com/Polymarket/rs-clob-client-v2)
- Rust CLOB client. May 13 2026.
- **Action:** N/A (we're TS-only). If we ever extract a hot-path Rust sidecar for HF arb, this is the client.

## Should study (official, not currently in our stack)

### [Polymarket/poly-market-maker](https://github.com/Polymarket/poly-market-maker)
- Python, MIT, 302 stars, 225 commits, **not archived** (I missed this in the org listing earlier — corrected here).
- Official market-maker keeper for the CLOB. Two configurable strategies: AMM and Bands. Places + cancels orders to keep open orders near the midpoint. Docker support.
- **Action:** if/when we add a market-making strategy for high-liquidity Polymarket markets, this is the reference implementation. The Bands strategy in particular is a candidate to port directly as a `bands-market-maker` evaluator under `scripts/research-loop.ts`.

## Smart contracts (read-only reference)

### [Polymarket/ctf-exchange-v2](https://github.com/Polymarket/ctf-exchange-v2) (Solidity, Apr 13 2026)
- Core exchange contracts for trading CTF assets. Settlement, signing schemes, wrapped collateral.
- **Action:** read when reasoning about settlement guarantees. Our `src/lib/polymarket/onchain.ts` only watches `OrderFilled` events — the contract sources here explain *when* that event fires.

### [Polymarket/neg-risk-ctf-adapter](https://github.com/Polymarket/neg-risk-ctf-adapter) (Solidity, Jan 8 2026)
- Adapter for negative-risk (multi-outcome) conditional tokens.
- **Action:** read when we extend the arb runner to handle neg-risk markets (we currently flag `negRisk: false` in `executeSingleMarketArb`).

### [Polymarket/exchange-fee-module](https://github.com/Polymarket/exchange-fee-module) (Solidity, Jan 6 2026)
- Dynamic-fee module on the exchange.
- **Action:** read when forecasting fee impact in `signals.ts`.

## US-specific

### [Polymarket/polymarket-us-python](https://github.com/Polymarket/polymarket-us-python) + [Polymarket/polymarket-us-typescript](https://github.com/Polymarket/polymarket-us-typescript)
- Official US-market SDKs (Jan 2026).
- **Action:** N/A unless we add a US-market workspace alongside the main one.

## Unclear / niche

### [Polymarket/vigil](https://github.com/Polymarket/vigil)
- TS Electron app, 2 stars, no description. Files suggest a monitoring/oversight tool.
- **Action:** skip unless a description appears.

## Archived (do not adopt)

| Repo | Status |
|------|--------|
| [Polymarket/clob-client](https://github.com/Polymarket/clob-client) | TS, archived. The thing we currently use — migrate. |
| [Polymarket/py-clob-client](https://github.com/Polymarket/py-clob-client) | Python, archived. |
| [Polymarket/rs-clob-client](https://github.com/Polymarket/rs-clob-client) | Rust, archived. |
| [Polymarket/ctf-exchange](https://github.com/Polymarket/ctf-exchange) | Solidity, archived (superseded by v2). |
