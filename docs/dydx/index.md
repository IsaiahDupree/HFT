# dYdX Integration Documentation

> Source: https://docs.dydx.xyz/ (the canonical docs host; docs.dydx.exchange and
> docs.dydx.trade both 30x to this URL as of 2026-05-27).

> **Compliance note** — dYdX's terms of service restrict US persons (and persons
> in several other jurisdictions) from using the perpetuals product, and
> explicitly prohibit using VPNs to circumvent geo-restrictions. Mirror these
> docs for reference and read-only Indexer integration only. Do not architect
> trading flow around bypassing the geofence.

This documentation is crafted specifically for developers who want to build
trading applications, bots, analytics tools, or integrate dYdX into their own
platforms.

You'll find everything you need — from REST & WebSocket API references to
integration guides. Whether you're creating a high-frequency trading bot or
building a DeFi dashboard, this doc will help you get up and running quickly
and securely.

## Scenario index

### Build a Trading Bot
Use the libraries to automate trading: fetch market data, place and manage orders.
- [Quick Start Python](https://docs.dydx.xyz/interaction/client/quick-start-py)
- [Quick Start TypeScript](https://docs.dydx.xyz/interaction/client/quick-start-ts)
- [Quick Start Rust](https://docs.dydx.xyz/interaction/client/quick-start-rs)
- [Connecting to dYdX](https://docs.dydx.xyz/interaction/endpoints)
- [Wallet Setup](https://docs.dydx.xyz/interaction/wallet-setup)
- [Trading Guide](https://docs.dydx.xyz/interaction/trading)
- [Third-Party Integrations](https://docs.dydx.xyz/third-party-integrations)

### Stream Real-Time Updates
Receive live market and account data using WebSocket connections.
- [WebSocket Data Feeds](https://docs.dydx.xyz/interaction/data/feeds)
- [WebSocket API Reference](https://docs.dydx.xyz/indexer-client/websockets)
- [Watch Orderbook](https://docs.dydx.xyz/interaction/data/watch-orderbook)
- [Full Node Streaming](https://docs.dydx.xyz/nodes/full-node-streaming)

### Integrate into Your App
Display market, order, and position data directly in your application.
- [Integration Guide](https://docs.dydx.xyz/integration/integration-guide)
- [Indexer HTTP API](https://docs.dydx.xyz/indexer-client/http)
- [Market Data Guide](https://docs.dydx.xyz/interaction/data/market)
- [Account Data Guide](https://docs.dydx.xyz/interaction/data/accounts)
- [Get Perpetual Markets](https://docs.dydx.xyz/indexer-client/http/markets/get_perpetual_markets)

### Access Account Data
Use the Indexer API to query account info, balances, and positions. For actions
requiring authentication, use private Node API methods.
- [Indexer Accounts API](https://docs.dydx.xyz/indexer-client/http/accounts)
- [Private Node API](https://docs.dydx.xyz/node-client/private)
- [Account Management](https://docs.dydx.xyz/interaction/data/accounts)
- [Accounts and Subaccounts](https://docs.dydx.xyz/concepts/trading/accounts)
- [Permissioned Keys](https://docs.dydx.xyz/interaction/permissioned-keys)

### Onboarding FAQ
- [Onboarding FAQs](https://docs.dydx.xyz/concepts/onboarding-faqs)

Last source-page update on dydx.xyz: 3/11/26.
