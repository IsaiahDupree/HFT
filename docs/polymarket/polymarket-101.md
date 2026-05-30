> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Polymarket 101

> An intro to Polymarket - the world's largest prediction market

Polymarket is a prediction market platform where users trade on the outcomes of real-world events. Instead of betting against a house, you trade shares with other users in an open, peer-to-peer market. Prices reflect the market's collective belief in the probability of an event occurring.

The platform is non-custodial, meaning you always control your funds. All trades are settled through smart contracts on the blockchain, ensuring transparent and trustless operation.

## Self-Custody

Polymarket operates on a non-custodial model. You maintain full control of your funds at all times.

* **You control your funds** - Assets are held in your wallet, secured by your private key
* **Smart contract enforcement** - Trades execute automatically through audited smart contracts
* **No intermediary risk** - Polymarket never takes possession of your funds — you maintain full control through your private key
* **Full transparency** - All trades and positions are recorded onchain and publicly verifiable
* **Trustless execution** - Settlement happens automatically based on market resolution

<Warning>
  Keep your private key safe and never share it with anyone. If you lose your
  private key, you lose access to your funds. If you signed up via Magic Link or
  have a proxy wallet, recovery may be possible through
  [recovery.polymarket.com](https://recovery.polymarket.com).
</Warning>

## How Polymarket Works

<Frame>
  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/core-concepts/polymarket-101.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=059e9831d1c51b99996d9747c0139d49" alt="Polymarket Overview" className="dark:hidden" width="1526" height="952" data-path="images/core-concepts/polymarket-101.png" />

  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/dark/core-concepts/polymarket-101.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=4e929eca98a2bb83ef7421f7bbaf9f1d" alt="Polymarket Overview" className="hidden dark:block" width="1526" height="952" data-path="images/dark/core-concepts/polymarket-101.png" />
</Frame>

### Prices Are Probabilities

Every share on Polymarket is priced between `$0.00` and `$1.00`. The price represents the market's belief in the probability of that outcome occurring.

For example, if "Yes" shares for an event are trading at `$0.65`, the market believes there's approximately a `65%` chance the event will happen.

### Collateral and Tokens

Polymarket uses pUSD (Polymarket USD) as collateral. Every Yes/No pair is fully backed:

* `$1 pUSD` creates one Yes share and one No share
* Winning shares are redeemable for `$1.00`
* Losing shares are worth `$0.00`

Shares are represented as tokens using the [Gnosis Conditional Token Framework](https://github.com/gnosis/conditional-tokens-contracts/) (ERC1155 standard), enabling seamless onchain trading and settlement.

### Trading

Polymarket uses a peer-to-peer order book (CLOB) for trading. You trade directly with other users, not against the house.

* **Buy shares** when you think the market underestimates the probability
* **Sell shares** when you think the market overestimates the probability
* **Exit anytime** - Sell your position before resolution to lock in profits or cut losses

| Action  | When to Use                           | Profit Scenario           |
| ------- | ------------------------------------- | ------------------------- |
| Buy Yes | You think the probability is too low  | Event occurs              |
| Buy No  | You think the probability is too high | Event does not occur      |
| Sell    | Lock in gains or limit losses         | Price moves in your favor |

### Resolution

When an event concludes, markets are resolved through the **UMA Optimistic Oracle**:

1. A proposer submits the outcome with a bond
2. There's a challenge period where anyone can dispute
3. If disputed, UMA token holders vote on the correct resolution
4. Winning tokens become redeemable for \$1 pUSD

This community-driven process ensures fair and accurate market resolution.

## Why Blockchain

Polymarket is built on **Polygon**, a blockchain network, for several key reasons:

* **Global accessibility** - Anyone with an internet connection can participate
* **Non-custodial** - You control your funds, not a centralized entity
* **Transparent** - All activity is publicly verifiable onchain
* **Fast and affordable** - Polygon enables quick, low-cost transactions
* **Stable value** - pUSD is a standard ERC-20 backed by USDC, with backing enforced onchain by the smart contract — avoiding crypto volatility

## Smart Wallets

Polymarket uses smart wallets so users can trade without manually submitting
every onchain transaction. New API users use deposit wallets. Existing Safe and
Proxy users can continue using their current wallet.

Deposit wallets hold the user's pUSD and outcome tokens on Polygon and validate
orders through ERC-1271. Safe and Proxy wallets remain supported for existing
users and integrations.

Using smart wallets allows Polymarket to provide an improved UX where multi-step
transactions can be executed atomically and transactions can be relayed by
Polymarket's relayer. If you are a developer looking to programmatically access
positions accumulated through an existing Polymarket account, continue using
that account's current smart wallet type.

### Deployments

Each smart-wallet user has their own wallet address. See
[Contracts](/resources/contracts) for all deployed factory and trading contract
addresses on Polygon.

<Tip>
  For details on signature types (`EOA`, `POLY_PROXY`, `GNOSIS_SAFE`,
  `POLY_1271`) and how to configure your trading client for each wallet type,
  see [Signature Types](/trading/overview#signature-types).
</Tip>

***

## Getting Started

Ready to start trading?

<CardGroup cols={2}>
  <Card title="Quickstart Guide" icon="rocket" href="/quickstart">
    Set up your account and make your first trade.
  </Card>

  <Card title="Explore Markets" icon="chart-line" href="https://polymarket.com">
    Browse active prediction markets on Polymarket.
  </Card>
</CardGroup>
