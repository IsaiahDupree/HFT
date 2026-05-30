> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Trading

> Order entry, management, and best practices for market makers

Market makers interact with Polymarket through the CLOB API — posting two-sided quotes, managing inventory across markets, and rebalancing positions. The SDK clients handle order signing and submission, so you can focus on strategy.

<Info>
  This page covers MM-specific workflows and best practices. For full order
  mechanics, see [Create Orders](/trading/orders/create) and [Cancel
  Orders](/trading/orders/cancel).
</Info>

***

## Two-Sided Quoting

The core market making workflow is posting a bid and ask around your fair value. Use `createAndPostOrder` to place each side:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { ClobClient, Side, OrderType } from "@polymarket/clob-client-v2";

  const client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: 137,
    signer: wallet,
    creds: credentials,
    signatureType,
    funderAddress: funder,
  });

  // Bid at 0.48
  const bid = await client.createAndPostOrder({
    tokenID: "3409705850427531082723332342151729...",
    side: Side.BUY,
    price: 0.48,
    size: 1000,
  });

  // Ask at 0.52
  const ask = await client.createAndPostOrder({
    tokenID: "3409705850427531082723332342151729...",
    side: Side.SELL,
    price: 0.52,
    size: 1000,
  });
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import OrderArgs, OrderType
  from py_clob_client_v2.order_builder.constants import BUY, SELL

  token_id = "3409705850427531082723332342151729..."

  # Bid at 0.48
  bid = client.create_and_post_order(
      OrderArgs(token_id=token_id, side=BUY, price=0.48, size=1000),
      order_type=OrderType.GTC,
  )

  # Ask at 0.52
  ask = client.create_and_post_order(
      OrderArgs(token_id=token_id, side=SELL, price=0.52, size=1000),
      order_type=OrderType.GTC,
  )
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::Side;
  use polymarket_client_sdk_v2::types::dec;

  let token_id = "3409705850427531082723332342151729...".parse()?;

  // Bid at 0.48
  let bid = client.limit_order()
      .token_id(token_id).price(dec!(0.48)).size(dec!(1000)).side(Side::Buy)
      .build().await?;
  let signed = client.sign(&signer, bid).await?;
  client.post_order(signed).await?;

  // Ask at 0.52
  let ask = client.limit_order()
      .token_id(token_id).price(dec!(0.52)).size(dec!(1000)).side(Side::Sell)
      .build().await?;
  let signed = client.sign(&signer, ask).await?;
  client.post_order(signed).await?;
  ```
</CodeGroup>

### Batch Orders

For tighter spreads across multiple levels, use `postOrders` to submit up to 15 orders in a single request:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const orders = await Promise.all([
    client.createOrder({ tokenID, side: Side.BUY, price: 0.48, size: 500 }),
    client.createOrder({ tokenID, side: Side.BUY, price: 0.47, size: 500 }),
    client.createOrder({ tokenID, side: Side.SELL, price: 0.52, size: 500 }),
    client.createOrder({ tokenID, side: Side.SELL, price: 0.53, size: 500 }),
  ]);

  const response = await client.postOrders(
    orders.map((order) => ({ order, orderType: OrderType.GTC })),
  );
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import OrderArgs, OrderType, PostOrdersV2Args
  from py_clob_client_v2.order_builder.constants import BUY, SELL

  response = client.post_orders([
      PostOrdersV2Args(
          order=client.create_order(OrderArgs(
              price=0.48, size=500, side=BUY, token_id=token_id,
          )),
          orderType=OrderType.GTC,
      ),
      PostOrdersV2Args(
          order=client.create_order(OrderArgs(
              price=0.47, size=500, side=BUY, token_id=token_id,
          )),
          orderType=OrderType.GTC,
      ),
      PostOrdersV2Args(
          order=client.create_order(OrderArgs(
              price=0.52, size=500, side=SELL, token_id=token_id,
          )),
          orderType=OrderType.GTC,
      ),
      PostOrdersV2Args(
          order=client.create_order(OrderArgs(
              price=0.53, size=500, side=SELL, token_id=token_id,
          )),
          orderType=OrderType.GTC,
      ),
  ])
  ```

  ```rust Rust theme={null}
  let mut signed_orders = Vec::new();
  for (price, side) in [
      (dec!(0.48), Side::Buy), (dec!(0.47), Side::Buy),
      (dec!(0.52), Side::Sell), (dec!(0.53), Side::Sell),
  ] {
      let order = client.limit_order()
          .token_id(token_id).price(price).size(dec!(500)).side(side)
          .build().await?;
      signed_orders.push(client.sign(&signer, order).await?);
  }
  let response = client.post_orders(signed_orders).await?;
  ```
</CodeGroup>

<Tip>
  Batching reduces latency by submitting multiple quotes in a single request.
  Always prefer `postOrders()` over multiple individual `createAndPostOrder()`
  calls.
</Tip>

***

## Choosing Order Types

| Type    | Behavior                                         | When to Use                             |
| ------- | ------------------------------------------------ | --------------------------------------- |
| **GTC** | Rests on the book until filled or cancelled      | Default for passive quoting             |
| **GTD** | Auto-expires at a specified time                 | Expire quotes before known events       |
| **FOK** | Must fill entirely and immediately, or cancel    | Aggressive rebalancing — all or nothing |
| **FAK** | Fills what's available immediately, cancels rest | Rebalancing where partial fills are OK  |

**GTC** and **GTD** are your primary tools for passive market making — they rest on the book at your specified price. **FOK** and **FAK** are for rebalancing inventory against resting liquidity.

### Time-Limited Quotes with GTD

Auto-expire quotes before known events like market close or resolution:

<CodeGroup>
  ```typescript TypeScript theme={null}
  // Expire in 1 hour
  const expiringOrder = await client.createAndPostOrder(
    {
      tokenID,
      side: Side.BUY,
      price: 0.5,
      size: 1000,
      expiration: Math.floor(Date.now() / 1000) + 3600,
    },
    undefined,
    OrderType.GTD,
  );
  ```

  ```python Python theme={null}
  import time
  from py_clob_client_v2 import OrderArgs, OrderType
  from py_clob_client_v2.order_builder.constants import BUY

  # Expire in 1 hour
  expiring_order = client.create_and_post_order(
      OrderArgs(
          token_id=token_id,
          side=BUY,
          price=0.50,
          size=1000,
          expiration=int(time.time()) + 3600,
      ),
      order_type=OrderType.GTD,
  )
  ```

  ```rust Rust theme={null}
  use chrono::{TimeDelta, Utc};
  use polymarket_client_sdk_v2::clob::types::OrderType;

  // Expire in 1 hour
  let order = client.limit_order()
      .token_id(token_id)
      .price(dec!(0.50))
      .size(dec!(1000))
      .side(Side::Buy)
      .order_type(OrderType::GTD)
      .expiration(Utc::now() + TimeDelta::hours(1))
      .build().await?;
  let signed = client.sign(&signer, order).await?;
  client.post_order(signed).await?;
  ```
</CodeGroup>

***

## Managing Orders

### Cancelling

Cancel individual orders, by market, or everything at once:

<CodeGroup>
  ```typescript TypeScript theme={null}
  await client.cancelOrder(orderId); // Single order
  await client.cancelOrders(orderIds); // Multiple orders
  await client.cancelMarketOrders(conditionId); // All orders in a market
  await client.cancelAll(); // Everything
  ```

  ```python Python theme={null}
  client.cancel(order_id=order_id)                  # Single order
  client.cancel_market_orders(market=condition_id)  # All orders in a market
  client.cancel_all()                               # Everything
  ```

  ```rust Rust theme={null}
  client.cancel_order(order_id).await?;           // Single order
  client.cancel_market_orders(&request).await?;   // All orders in a market
  client.cancel_all_orders().await?;              // Everything
  ```
</CodeGroup>

See [Cancel Orders](/trading/orders/cancel) for full details.

### Monitoring Open Orders

<CodeGroup>
  ```typescript TypeScript theme={null}
  const order = await client.getOrder(orderId);

  const orders = await client.getOpenOrders({
    market: "0xbd31dc8a...",
    asset_id: "52114319501245...",
  });
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import OpenOrderParams

  order = client.get_order(order_id)

  orders = client.get_orders(
      OpenOrderParams(market="0xbd31dc8a...")
  )
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::request::OrdersRequest;

  let order = client.order(order_id).await?;

  let request = OrdersRequest::builder()
      .market("0xbd31dc8a...".parse()?)
      .build();
  let orders = client.orders(&request, None).await?;
  ```
</CodeGroup>

***

## Tick Sizes

Your order price must conform to the market's tick size, or it will be rejected. Look it up with the SDK before quoting:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const tickSize = await client.getTickSize(tokenID);
  // Returns: "0.1" | "0.01" | "0.001" | "0.0001"
  ```

  ```python Python theme={null}
  tick_size = client.get_tick_size(token_id)
  # Returns: "0.1" | "0.01" | "0.001" | "0.0001"
  ```

  ```rust Rust theme={null}
  let resp = client.tick_size(token_id).await?;
  // resp.minimum_tick_size: TickSize::Tenth | Hundredth | Thousandth | TenThousandth
  ```
</CodeGroup>

***

## Fees

Most markets charge a small taker fee. Makers are never charged fees. **Geopolitical and world events markets are fee-free.**

Taker fees fund the [Maker Rebates Program](/market-makers/maker-rebates), which pays daily USDC rebates to liquidity providers.

<Note>
  Fees apply only to markets deployed on or after the activation date. Pre-existing markets are unaffected. Markets with fees enabled have `feesEnabled` set to `true` on the market object.
</Note>

See [Fees](/trading/fees) for the full fee schedule, rates by category, and calculation details.

***

## Best Practices

### Quote Management

* **Quote both sides** — Post bids and asks to earn maximum [liquidity rewards](/market-makers/liquidity-rewards)
* **Skew on inventory** — Adjust quote prices based on your current position to manage exposure
* **Cancel stale quotes** — Pull orders immediately when market conditions change
* **Use GTD for events** — Auto-expire quotes before known catalysts to avoid stale exposure

### Latency

* **Batch orders** — Use `postOrders()` to submit multiple quotes in a single request
* **WebSocket for data** — Subscribe to real-time feeds instead of polling REST endpoints

### Risk Controls

* **Size limits** — Check token balances before quoting and don't exceed your available inventory
* **Price guards** — Validate prices against the book midpoint and reject outliers
* **Kill switch** — Call `cancelAll()` immediately on errors or position breaches
* **Monitor fills** — Subscribe to the WebSocket user channel for real-time fill notifications

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Inventory" icon="boxes-stacked" href="/market-makers/inventory">
    Split, merge, and redeem outcome tokens
  </Card>

  <Card title="Liquidity Rewards" icon="gift" href="/market-makers/liquidity-rewards">
    Earn rewards for providing two-sided liquidity
  </Card>

  <Card title="Create Orders" icon="plus" href="/trading/orders/create">
    Full order creation reference with all options
  </Card>
</CardGroup>
