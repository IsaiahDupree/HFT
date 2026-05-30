> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Overview

> Market making on Polymarket

A Market Maker (MM) on Polymarket is a trader who provides liquidity to prediction markets by continuously posting bid and ask orders. By laying the spread, market makers enable other users to trade efficiently while earning the spread as compensation for the risk they take.

Market makers are essential to Polymarket's ecosystem — they provide liquidity across markets, tighten spreads for better user experience, enable price discovery through continuous quoting, and absorb trading flow from retail and institutional users.

<Note>
  **Not a Market Maker?** If you're building an application that routes orders
  for your users, see the [Builder Program](/builders/overview) instead.
</Note>

***

## Getting Started

<Steps>
  <Step title="Complete Setup">
    Deploy wallets, fund with pUSD, and set token approvals. See the [Getting
    Started](/market-makers/getting-started) guide.
  </Step>

  <Step title="Connect to Data Feeds">
    WebSocket for real-time orderbook updates, Gamma API for market metadata.
    See [Market Data](/market-data/overview).
  </Step>

  <Step title="Start Quoting">
    Post orders via the CLOB REST API. See [Trading ](/market-makers/trading).
  </Step>
</Steps>

***

## Quick Reference

| Action               | Tool           | Documentation                                     |
| -------------------- | -------------- | ------------------------------------------------- |
| Deposit pUSD         | Bridge API     | [Bridge](/trading/bridge/deposit)                 |
| Approve tokens       | Relayer Client | [Getting Started](/market-makers/getting-started) |
| Post limit orders    | CLOB REST API  | [Create Orders](/trading/orders/create)           |
| Monitor orderbook    | WebSocket      | [WebSocket](/market-data/websocket/overview)      |
| Split pUSD to tokens | CTF / Relayer  | [Inventory](/market-makers/inventory)             |
| Merge tokens to pUSD | CTF / Relayer  | [Inventory](/market-makers/inventory)             |

***

## What Is in This Section

<CardGroup cols={2}>
  <Card title="Getting Started" icon="gear" href="/market-makers/getting-started">
    Deposits, token approvals, wallet deployment, API keys
  </Card>

  <Card title="Trading" icon="chart-line" href="/market-makers/trading">
    Quoting best practices, strategies, and risk controls
  </Card>

  <Card title="Inventory Management" icon="boxes-stacked" href="/market-makers/inventory">
    Split, merge, and redeem outcome tokens
  </Card>

  <Card title="Liquidity Rewards" icon="gift" href="/market-makers/liquidity-rewards">
    Earn rewards for providing liquidity
  </Card>
</CardGroup>

## Risks

<Warning>
  Be careful with spread management — if your bid price is higher than your ask
  price (a "negative spread" or "crossed market"), you will lose money on every
  fill. Always validate your quote prices before submission.
</Warning>

## Support

For market maker onboarding and support, contact [support@polymarket.com](mailto:support@polymarket.com).
