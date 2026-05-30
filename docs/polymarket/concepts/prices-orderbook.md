> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Prices & Orderbook

> How prices work and how the order book enables peer-to-peer trading

Polymarket uses a **Central Limit Order Book (CLOB)** for trading. Prices aren't set by Polymarket—they emerge from supply and demand as users trade with each other.

<Frame>
  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/core-concepts/orderbook.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=119174bcaaeb3b9abbd4c2d94b7bdae6" alt="" className="dark:hidden" width="1540" height="952" data-path="images/core-concepts/orderbook.png" />

  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/dark/core-concepts/orderbook.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=b940f4b5f28ab6ed5845dda2bfe03edb" alt="" className="hidden dark:block" width="1540" height="952" data-path="images/dark/core-concepts/orderbook.png" />
</Frame>

## Prices Are Probabilities

Every share on Polymarket is priced between `$0.00` and `$1.00`. The price directly represents the market's belief in the probability of that outcome.

| Price  | Implied Probability |
| ------ | ------------------- |
| \$0.25 | 25% chance          |
| \$0.50 | 50% chance          |
| \$0.75 | 75% chance          |

<Note>
  The displayed price is the **midpoint** of the bid-ask spread. If the spread
  is wider than \$0.10, the last traded price is shown instead.
</Note>

### Example

If the best bid for "Yes" is `$0.34` and the best ask is `$0.40`:

```
Displayed price = ($0.34 + $0.40) / 2 = $0.37 (37% probability)
```

You won't necessarily trade at `$0.37`—you'll pay the ask (`$0.40`) when buying or receive the bid (`$0.34`) when selling.

## The Order Book

The order book is a list of all open buy and sell orders for a market. It has two sides:

| Side | Description                                                 |
| ---- | ----------------------------------------------------------- |
| Bids | Buy orders—the highest prices traders are willing to pay    |
| Asks | Sell orders—the lowest prices traders are willing to accept |

The **spread** is the gap between the highest bid and lowest ask. Tighter spreads mean more liquid markets.

## Order Types

### Market Orders

Execute immediately at the best available price. Use when you want instant execution and are willing to pay the spread.

* **Buying**: You pay the lowest ask price
* **Selling**: You receive the highest bid price

### Limit Orders

Execute only at your specified price or better. Use when you want price control and are willing to wait.

* Your order sits in the book until someone trades against it
* Orders can **partially fill** as different traders match portions of your order
* You can cancel unfilled orders at any time

<Note>
  All orders on Polymarket are technically limit orders. A "market order" is
  simply a limit order priced to execute immediately against resting orders.
</Note>

## How Trades Work

Polymarket's CLOB is **hybrid-decentralized**:

1. **Offchain matching** — An operator matches compatible orders
2. **Onchain settlement** — Matched trades settle via smart contracts

<Frame>
  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/core-concepts/trade-lifecycle.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=2acec8befdfbba57fb554170f7d5813c" alt="" className="dark:hidden" width="1540" height="952" data-path="images/core-concepts/trade-lifecycle.png" />

  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/dark/core-concepts/trade-lifecycle.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=d18b22ad7629820ad554dda8cb83ec18" alt="" className="hidden dark:block" width="1540" height="952" data-path="images/dark/core-concepts/trade-lifecycle.png" />
</Frame>

This design gives you the speed of centralized matching with the security of onchain settlement. You always maintain custody of your funds.

## Price Discovery

When a new market launches, there's no initial price. The first price emerges when:

1. Someone places a limit order to buy Yes at a price (e.g., `$0.60`)
2. Someone places a limit order to buy No at the complementary price (e.g., `$0.40`)
3. Since `$0.60` + `$0.40` = `$1.00`, the orders match

When matched, `$1.00` is converted into 1 Yes token and 1 No token, each going to their respective buyers.

## Next Steps

<Note>
  Polymarket's orderbook has **no trading size limits** — it matches willing
  buyers and sellers of any amount. However, large orders may move the price
  significantly. Always check orderbook depth before trading in size.
</Note>

<CardGroup cols={2}>
  <Card title="Positions & Tokens" icon="coins" href="/concepts/positions-tokens">
    Learn about outcome tokens and how positions work.
  </Card>

  <Card title="Order Lifecycle" icon="arrows-spin" href="/concepts/order-lifecycle">
    Understand what happens from order placement to settlement.
  </Card>
</CardGroup>
