> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Orderbook

> Reading the orderbook, prices, spreads, and midpoints

The orderbook is a public endpoint — no authentication required. You can read prices and liquidity using the SDK or REST API directly.

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { ClobClient } from "@polymarket/clob-client-v2";

  const client = new ClobClient({ host: "https://clob.polymarket.com", chain: 137 });
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import ClobClient

  client = ClobClient("https://clob.polymarket.com", chain_id=137)
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::{Client, Config};

  let client = Client::new("https://clob.polymarket.com", Config::default())?;
  ```

  ```bash REST theme={null}
  # Base URL for all orderbook endpoints
  https://clob.polymarket.com
  ```
</CodeGroup>

***

## Get the Orderbook

Fetch the full orderbook for a token, including all resting bid and ask levels:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const book = await client.getOrderBook("TOKEN_ID");

  console.log("Best bid:", book.bids[0]);
  console.log("Best ask:", book.asks[0]);
  console.log("Tick size:", book.tick_size);
  ```

  ```python Python theme={null}
  book = client.get_order_book("TOKEN_ID")

  print("Best bid:", book["bids"][0])
  print("Best ask:", book["asks"][0])
  print("Tick size:", book["tick_size"])
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::request::OrderBookSummaryRequest;

  let token_id = "TOKEN_ID".parse()?;
  let request = OrderBookSummaryRequest::builder().token_id(token_id).build();
  let book = client.order_book(&request).await?;

  println!("Best bid: {:?}", book.bids[0]);
  println!("Best ask: {:?}", book.asks[0]);
  println!("Tick size: {:?}", book.tick_size);
  ```

  ```bash REST theme={null}
  curl "https://clob.polymarket.com/book?token_id=TOKEN_ID"
  ```
</CodeGroup>

### Response

```json theme={null}
{
  "market": "0xbd31dc8a...",
  "asset_id": "52114319501245...",
  "timestamp": "2023-10-21T08:00:00Z",
  "bids": [
    { "price": "0.48", "size": "1000" },
    { "price": "0.47", "size": "2500" }
  ],
  "asks": [
    { "price": "0.52", "size": "800" },
    { "price": "0.53", "size": "1500" }
  ],
  "min_order_size": "5",
  "tick_size": "0.01",
  "neg_risk": false,
  "hash": "0xabc123..."
}
```

| Field            | Description                                         |
| ---------------- | --------------------------------------------------- |
| `market`         | Condition ID of the market                          |
| `asset_id`       | Token ID                                            |
| `bids`           | Buy orders sorted by price (highest first)          |
| `asks`           | Sell orders sorted by price (lowest first)          |
| `tick_size`      | Minimum price increment for this market             |
| `min_order_size` | Minimum order size for this market                  |
| `neg_risk`       | Whether this is a multi-outcome (neg risk) market   |
| `hash`           | Hash of the orderbook state — use to detect changes |

***

## Prices

Get the best available price for buying or selling a token:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const buyPrice = await client.getPrice("TOKEN_ID", "BUY");
  console.log("Best ask:", buyPrice.price); // Price you'd pay to buy

  const sellPrice = await client.getPrice("TOKEN_ID", "SELL");
  console.log("Best bid:", sellPrice.price); // Price you'd receive to sell
  ```

  ```python Python theme={null}
  buy_price = client.get_price("TOKEN_ID", "BUY")
  print("Best ask:", buy_price["price"])

  sell_price = client.get_price("TOKEN_ID", "SELL")
  print("Best bid:", sell_price["price"])
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::{Side, request::PriceRequest};

  let token_id = "TOKEN_ID".parse()?;

  let buy_req = PriceRequest::builder().token_id(token_id).side(Side::Buy).build();
  let buy_price = client.price(&buy_req).await?;
  println!("Best ask: {}", buy_price.price);

  let sell_req = PriceRequest::builder().token_id(token_id).side(Side::Sell).build();
  let sell_price = client.price(&sell_req).await?;
  println!("Best bid: {}", sell_price.price);
  ```

  ```bash REST theme={null}
  # Best price for buying (lowest ask)
  curl "https://clob.polymarket.com/price?token_id=TOKEN_ID&side=BUY"

  # Best price for selling (highest bid)
  curl "https://clob.polymarket.com/price?token_id=TOKEN_ID&side=SELL"
  ```
</CodeGroup>

***

## Midpoints

The midpoint is the average of the best bid and best ask. This is the price displayed on Polymarket as the market's implied probability.

<CodeGroup>
  ```typescript TypeScript theme={null}
  const midpoint = await client.getMidpoint("TOKEN_ID");
  console.log("Midpoint:", midpoint.mid); // e.g., "0.50"
  ```

  ```python Python theme={null}
  midpoint = client.get_midpoint("TOKEN_ID")
  print("Midpoint:", midpoint["mid"])
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::request::MidpointRequest;

  let token_id = "TOKEN_ID".parse()?;
  let request = MidpointRequest::builder().token_id(token_id).build();
  let midpoint = client.midpoint(&request).await?;
  println!("Midpoint: {}", midpoint.mid);
  ```

  ```bash REST theme={null}
  curl "https://clob.polymarket.com/midpoint?token_id=TOKEN_ID"
  ```
</CodeGroup>

<Note>
  If the bid-ask spread is wider than \$0.10, Polymarket displays the last traded
  price instead of the midpoint.
</Note>

***

## Spreads

The spread is the difference between the best ask and the best bid. Tighter spreads indicate more liquid markets.

<CodeGroup>
  ```typescript TypeScript theme={null}
  const spread = await client.getSpread("TOKEN_ID");
  console.log("Spread:", spread.spread); // e.g., "0.04"
  ```

  ```python Python theme={null}
  spread = client.get_spread("TOKEN_ID")
  print("Spread:", spread["spread"])
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::request::SpreadRequest;

  let token_id = "TOKEN_ID".parse()?;
  let request = SpreadRequest::builder().token_id(token_id).build();
  let spread = client.spread(&request).await?;
  println!("Spread: {}", spread.spread);
  ```

  ```bash REST theme={null}
  # Spreads use POST for batch requests
  curl -X POST "https://clob.polymarket.com/spreads" \
    -H "Content-Type: application/json" \
    -d '[{"token_id": "TOKEN_ID"}]'
  ```
</CodeGroup>

***

## Price History

Fetch historical price data for a token over various time intervals:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { PriceHistoryInterval } from "@polymarket/clob-client-v2";

  const history = await client.getPricesHistory({
    market: "TOKEN_ID", // Note: this param is named "market" but takes a token ID
    interval: PriceHistoryInterval.ONE_DAY,
    fidelity: 60, // Data points every 60 minutes
  });

  // Each entry: { t: timestamp, p: price }
  history.forEach((point) => {
    console.log(`${new Date(point.t * 1000).toISOString()}: ${point.p}`);
  });
  ```

  ```python Python theme={null}
  history = client.get_prices_history(
      market="TOKEN_ID",  # Note: this param is named "market" but takes a token ID
      interval="1d",
      fidelity=60,  # Data points every 60 minutes
  )

  for point in history:
      print(f"{point['t']}: {point['p']}")
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::{Interval, TimeRange, request::PriceHistoryRequest};

  let token_id = "TOKEN_ID".parse()?;
  let request = PriceHistoryRequest::builder()
      .market(token_id) // Note: this param is named "market" but takes a token ID
      .time_range(TimeRange::Interval { interval: Interval::OneDay })
      .fidelity(60) // Data points every 60 minutes
      .build();
  let history = client.price_history(&request).await?;

  for point in &history.history {
      println!("{}: {}", point.t, point.p);
  }
  ```

  ```bash REST theme={null}
  # By interval (relative to now)
  curl "https://clob.polymarket.com/prices-history?market=TOKEN_ID&interval=1d&fidelity=60"

  # By timestamp range
  curl "https://clob.polymarket.com/prices-history?market=TOKEN_ID&startTs=1697875200&endTs=1697961600"
  ```
</CodeGroup>

| Interval | Description        |
| -------- | ------------------ |
| `1h`     | Last hour          |
| `6h`     | Last 6 hours       |
| `1d`     | Last day           |
| `1w`     | Last week          |
| `1m`     | Last month         |
| `max`    | All available data |

<Note>
  `interval` is relative to the current time. Use `startTs` / `endTs` for
  absolute time ranges. They are mutually exclusive — don't combine them.
</Note>

***

## Estimate Fill Price

Calculate the effective price you'd pay for a market order of a given size, accounting for orderbook depth:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { Side, OrderType } from "@polymarket/clob-client-v2";

  // What price would I pay to buy $500 worth?
  const price = await client.calculateMarketPrice(
    "TOKEN_ID",
    Side.BUY,
    500, // dollar amount
    OrderType.FOK,
  );

  console.log("Estimated fill price:", price);
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import OrderType

  price = client.calculate_market_price(
      token_id="TOKEN_ID",
      side="BUY",
      amount=500,
      order_type=OrderType.FOK,
  )

  print("Estimated fill price:", price)
  ```

  ```rust Rust theme={null}
  // The Rust SDK handles market price calculation automatically
  // inside the market_order() builder when no price is specified.
  // It walks the orderbook to determine the fill price for you.
  let order = client
      .market_order()
      .token_id("TOKEN_ID".parse()?)
      .amount(Amount::usdc(dec!(500))?)
      .side(Side::Buy)
      .order_type(OrderType::FOK)
      .build()
      .await?; // Price auto-calculated from orderbook depth
  ```
</CodeGroup>

This walks the orderbook to estimate slippage. Useful for sizing market orders before submitting them.

***

## Batch Requests

All orderbook queries have batch variants for fetching data across multiple tokens in a single request (up to 500 tokens):

| Single                | Batch                   | REST              |
| --------------------- | ----------------------- | ----------------- |
| `getOrderBook()`      | `getOrderBooks()`       | `POST /books`     |
| `getPrice()`          | `getPrices()`           | `POST /prices`    |
| `getMidpoint()`       | `getMidpoints()`        | `POST /midpoints` |
| `getSpread()`         | `getSpreads()`          | `POST /spreads`   |
| `getLastTradePrice()` | `getLastTradesPrices()` | —                 |

<Note>
  `BookParams` for batch orderbook requests accepts a `token_id` and an optional
  `side` parameter to filter by bid or ask side.
</Note>

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { Side } from "@polymarket/clob-client-v2";

  // Fetch prices for multiple tokens
  const prices = await client.getPrices([
    { token_id: "TOKEN_A", side: Side.BUY },
    { token_id: "TOKEN_B", side: Side.BUY },
  ]);
  // Returns: { "TOKEN_A": { "BUY": "0.52" }, "TOKEN_B": { "BUY": "0.74" } }
  ```

  ```python Python theme={null}
  prices = client.get_prices([
      {"token_id": "TOKEN_A", "side": "BUY"},
      {"token_id": "TOKEN_B", "side": "BUY"},
  ])
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::{Side, request::PriceRequest};

  let token_a = "TOKEN_A".parse()?;
  let token_b = "TOKEN_B".parse()?;
  let requests = vec![
      PriceRequest::builder().token_id(token_a).side(Side::Buy).build(),
      PriceRequest::builder().token_id(token_b).side(Side::Buy).build(),
  ];
  let prices = client.prices(&requests).await?;
  ```

  ```bash REST theme={null}
  curl -X POST "https://clob.polymarket.com/prices" \
    -H "Content-Type: application/json" \
    -d '[
      {"token_id": "TOKEN_A", "side": "BUY"},
      {"token_id": "TOKEN_B", "side": "BUY"}
    ]'
  ```
</CodeGroup>

***

## Last Trade Price

Get the price and side of the most recent trade for a token:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const lastTrade = await client.getLastTradePrice("TOKEN_ID");
  console.log(lastTrade.price, lastTrade.side);
  // e.g., "0.52", "BUY"
  ```

  ```python Python theme={null}
  last_trade = client.get_last_trade_price("TOKEN_ID")
  print(last_trade["price"], last_trade["side"])
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::request::LastTradePriceRequest;

  let token_id = "TOKEN_ID".parse()?;
  let request = LastTradePriceRequest::builder().token_id(token_id).build();
  let last_trade = client.last_trade_price(&request).await?;
  println!("{} {:?}", last_trade.price, last_trade.side);
  ```
</CodeGroup>

***

## Real-Time Updates

For live orderbook data, use the WebSocket API instead of polling. The `market` channel streams orderbook changes, price updates, and trade events in real time.

### Connecting

```typescript theme={null}
const ws = new WebSocket(
  "wss://ws-subscriptions-clob.polymarket.com/ws/market",
);

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: "market",
      assets_ids: ["TOKEN_ID"],
      custom_feature_enabled: true, // enables best_bid_ask, new_market, market_resolved events
    }),
  );
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  switch (data.event_type) {
    case "book": // full orderbook snapshot
    case "price_change": // individual price level update
    case "last_trade_price": // new trade executed
    case "tick_size_change": // market tick size changed
    case "best_bid_ask": // top-of-book update (requires custom_feature_enabled)
    case "new_market": // new market created (requires custom_feature_enabled)
    case "market_resolved": // market resolved (requires custom_feature_enabled)
  }
};
```

### Dynamic Subscribe and Unsubscribe

After connecting, you can change your subscriptions without reconnecting:

```typescript theme={null}
// Subscribe to additional tokens
ws.send(
  JSON.stringify({
    assets_ids: ["NEW_TOKEN_ID"],
    operation: "subscribe",
  }),
);

// Unsubscribe from tokens
ws.send(
  JSON.stringify({
    assets_ids: ["OLD_TOKEN_ID"],
    operation: "unsubscribe",
  }),
);
```

### Event Types

| Event              | Trigger                                      | Key Fields                                                             |
| ------------------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| `book`             | On subscribe + when a trade affects the book | `bids[]`, `asks[]`, `hash`, `timestamp`                                |
| `price_change`     | New order placed or order cancelled          | `price_changes[]` with `price`, `size`, `side`, `best_bid`, `best_ask` |
| `last_trade_price` | Trade executed                               | `price`, `side`, `size`, `fee_rate_bps`                                |
| `tick_size_change` | Price hits >0.96 or \< 0.04                  | `old_tick_size`, `new_tick_size`                                       |
| `best_bid_ask`     | Top-of-book changes                          | `best_bid`, `best_ask`, `spread`                                       |
| `new_market`       | Market created                               | `question`, `assets_ids`, `outcomes`                                   |
| `market_resolved`  | Market resolved                              | `winning_asset_id`, `winning_outcome`                                  |

<Note>
  `best_bid_ask`, `new_market`, and `market_resolved` require
  `custom_feature_enabled: true` in your subscription message.
</Note>

<Warning>
  The `tick_size_change` event is critical for trading bots. If the tick size
  changes and you continue using the old tick size, your orders will be
  rejected.
</Warning>

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Place Orders" icon="plus" href="/trading/orders/create">
    Create and submit orders using the orderbook data
  </Card>

  <Card title="Fetching Markets" icon="magnifying-glass" href="/market-data/fetching-markets">
    Find token IDs for markets you want to trade
  </Card>
</CardGroup>
