> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Markets & Events

> Understanding the fundamental building blocks of Polymarket

Every prediction on Polymarket is structured around two core concepts: **markets** and **events**. Understanding how they relate is essential for building on the platform.

<Frame>
  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/core-concepts/event-market.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=4c62bd08a405868307cdd6799b368ca5" alt="" className="dark:hidden" width="1540" height="952" data-path="images/core-concepts/event-market.png" />

  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/dark/core-concepts/event-market.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=2eb5c9b0f8a2afe52bc2e717b7b796a2" alt="" className="hidden dark:block" width="1540" height="952" data-path="images/dark/core-concepts/event-market.png" />
</Frame>

## Markets

A **market** is the fundamental tradable unit on Polymarket. Each market represents a single binary question with Yes/No outcomes.

<Frame>
  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/core-concepts/event.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=0c9a264aec9a22ce5a20c4cc7980806d" alt="" className="dark:hidden" width="1540" height="952" data-path="images/core-concepts/event.png" />

  <img src="https://mintcdn.com/polymarket-292d1b1b/FOMte3ewbG-LVy3k/images/dark/core-concepts/event.png?fit=max&auto=format&n=FOMte3ewbG-LVy3k&q=85&s=912e41bebfe8c1a43ef53b89685ca3d2" alt="" className="hidden dark:block" width="1540" height="952" data-path="images/dark/core-concepts/event.png" />
</Frame>

Every market has:

| Identifier       | Description                                                              |
| ---------------- | ------------------------------------------------------------------------ |
| **Condition ID** | Unique identifier for the market's condition in the CTF contracts        |
| **Question ID**  | Hash of the market question used for resolution                          |
| **Token IDs**    | ERC1155 token IDs used for trading on the CLOB — one for Yes, one for No |

<Note>
  Markets can only be traded via the CLOB if `enableOrderBook` is `true`. Some
  markets may exist onchain but not be available for order book trading.
</Note>

### Market Example

A simple market might be:

> **"Will Bitcoin reach \$150,000 by December 2026?"**

This creates two outcome tokens:

* **Yes token** - Redeemable for `$1` if Bitcoin reaches `$150k`
* **No token** - Redeemable for `$1` if Bitcoin doesn't reach `$100k`

## Events

An **event** is a container that groups one or more related markets together. Events provide organizational structure and enable multi-outcome predictions.

### Single-Market Events

When an event contains just one market, it creates a simple market pair. The event and market are essentially equivalent.

```
Event: Will Bitcoin reach $100,000 by December 2024?
└── Market: Will Bitcoin reach $100,000 by December 2024? (Yes/No)
```

### Multi-Market Events

When an event contains two or more markets, it creates a grouped market pair. This enables mutually exclusive multi-outcome predictions.

```
Event: Who will win the 2024 Presidential Election?
├── Market: Donald Trump? (Yes/No)
├── Market: Joe Biden? (Yes/No)
├── Market: Kamala Harris? (Yes/No)
└── Market: Other? (Yes/No)
```

## Identifying Markets

Every market and event has a unique **slug** that appears in the Polymarket URL:

```
https://polymarket.com/event/fed-decision-in-october
                              └── slug: fed-decision-in-october
```

You can use slugs to fetch specific markets or events from the API:

```bash theme={null}
# Fetch event by slug
curl "https://gamma-api.polymarket.com/events?slug=fed-decision-in-october"
```

## Sports Markets

Specifically for sports markets, outstanding limit orders are **automatically cancelled** once the game begins, clearing the order book at the official start time. However, game start times can shift — if a game starts earlier than scheduled, orders may not be cleared in time. Always monitor your orders closely around game start times.

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Prices & Orderbook" icon="chart-line" href="/concepts/prices-orderbook">
    Learn how prices are determined and how the order book works.
  </Card>

  <Card title="Fetching Market Data" icon="code" href="/market-data/overview">
    Start querying markets and events from the API.
  </Card>
</CardGroup>
