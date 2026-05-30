> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Builder Methods

> Methods for querying orders and trades attributed to your builder code.

## Overview

Builder attribution in V2 is handled natively through the order struct — you attach your **builder code** (a `bytes32` identifier from your [Builder Profile](https://polymarket.com/settings?tab=builder)) to every order you submit. No separate client configuration is required.

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { ClobClient } from "@polymarket/clob-client-v2";

  const client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: 137,
    signer,
    creds: apiCreds,
    signatureType,
    funderAddress,
  });

  // Attach your builder code on every order
  const response = await client.createAndPostOrder(
    {
      tokenID: "0x...",
      price: 0.55,
      size: 100,
      side: Side.BUY,
      builderCode: process.env.POLY_BUILDER_CODE!,
    },
    { tickSize: "0.01", negRisk: false },
  );
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import ClobClient
  from py_clob_client_v2 import OrderArgs, PartialCreateOrderOptions
  from py_clob_client_v2.order_builder.constants import BUY
  import os

  client = ClobClient(
      host="https://clob.polymarket.com",
      chain_id=137,
      key=os.getenv("PRIVATE_KEY"),
      creds=creds,
      signature_type=signature_type,
      funder=funder,
  )

  # Attach your builder code on every order
  response = client.create_and_post_order(
      OrderArgs(
          token_id="0x...",
          price=0.55,
          size=100,
          side=BUY,
          builder_code=os.environ["POLY_BUILDER_CODE"],
      ),
      options=PartialCreateOrderOptions(tick_size="0.01", neg_risk=False),
  )
  ```
</CodeGroup>

<Info>
  See [Order Attribution](/trading/orders/attribution) for the full attribution flow.
</Info>

***

## Methods

***

### getOrder

Get details for a specific order by ID.

```typescript Signature theme={null}
async getOrder(orderID: string): Promise<OpenOrder>
```

<CodeGroup>
  ```typescript TypeScript theme={null}
  const order = await client.getOrder("0xb816482a...");
  console.log(order);
  ```

  ```python Python theme={null}
  order = client.get_order("0xb816482a...")
  print(order)
  ```
</CodeGroup>

***

### getOpenOrders

Get all open orders attributed to your builder code.

```typescript Signature theme={null}
async getOpenOrders(
  params?: OpenOrderParams,
  only_first_page?: boolean,
): Promise<OpenOrder[]>
```

**Params**

<ResponseField name="id" type="string">
  Optional. Filter by order ID.
</ResponseField>

<ResponseField name="market" type="string">
  Optional. Filter by market condition ID.
</ResponseField>

<ResponseField name="asset_id" type="string">
  Optional. Filter by token ID.
</ResponseField>

```typescript TypeScript theme={null}
// All open orders for this builder
const orders = await client.getOpenOrders();

// Filtered by market
const marketOrders = await client.getOpenOrders({
  market: "0xbd31dc8a...",
});
```

***

### getBuilderTrades

Retrieves all trades attributed to your builder code. Use this to track which trades were routed through your platform.

```typescript Signature theme={null}
async getBuilderTrades(
  params?: TradeParams,
): Promise<BuilderTradesPaginatedResponse>
```

**Params (`TradeParams`)**

<ResponseField name="id" type="string">
  Optional. Filter trades by trade ID.
</ResponseField>

<ResponseField name="maker_address" type="string">
  Optional. Filter trades by maker address.
</ResponseField>

<ResponseField name="market" type="string">
  Optional. Filter trades by market condition ID.
</ResponseField>

<ResponseField name="asset_id" type="string">
  Optional. Filter trades by asset (token) ID.
</ResponseField>

<ResponseField name="before" type="string">
  Optional. Return trades created before this cursor value.
</ResponseField>

<ResponseField name="after" type="string">
  Optional. Return trades created after this cursor value.
</ResponseField>

**Response (`BuilderTradesPaginatedResponse`)**

<ResponseField name="trades" type="BuilderTrade[]">
  Array of trades attributed to the builder account.
</ResponseField>

<ResponseField name="next_cursor" type="string">
  Cursor string for fetching the next page of results.
</ResponseField>

<ResponseField name="limit" type="number">
  Maximum number of trades returned per page.
</ResponseField>

<ResponseField name="count" type="number">
  Total number of trades returned in this response.
</ResponseField>

**`BuilderTrade` fields**

<ResponseField name="id" type="string">
  Unique identifier for the trade.
</ResponseField>

<ResponseField name="tradeType" type="string">
  Type of the trade.
</ResponseField>

<ResponseField name="takerOrderHash" type="string">
  Hash of the taker order associated with this trade.
</ResponseField>

<ResponseField name="builder" type="string">
  Builder code attributed to this trade.
</ResponseField>

<ResponseField name="market" type="string">
  Condition ID of the market this trade belongs to.
</ResponseField>

<ResponseField name="assetId" type="string">
  Token ID of the asset traded.
</ResponseField>

<ResponseField name="side" type="string">
  Side of the trade (e.g. BUY or SELL).
</ResponseField>

<ResponseField name="size" type="string">
  Size of the trade in shares.
</ResponseField>

<ResponseField name="sizeUsdc" type="string">
  Size of the trade denominated in USDC.
</ResponseField>

<ResponseField name="price" type="string">
  Price at which the trade was executed.
</ResponseField>

<ResponseField name="status" type="string">
  Current status of the trade.
</ResponseField>

<ResponseField name="outcome" type="string">
  Outcome label associated with the traded asset.
</ResponseField>

<ResponseField name="outcomeIndex" type="number">
  Index of the outcome within the market.
</ResponseField>

<ResponseField name="owner" type="string">
  Address of the order owner (taker).
</ResponseField>

<ResponseField name="maker" type="string">
  Address of the maker in the trade.
</ResponseField>

<ResponseField name="transactionHash" type="string">
  On-chain transaction hash for the trade.
</ResponseField>

<ResponseField name="matchTime" type="string">
  Timestamp when the trade was matched.
</ResponseField>

<ResponseField name="bucketIndex" type="number">
  Bucket index used for trade grouping.
</ResponseField>

<ResponseField name="fee" type="string">
  Fee charged for the trade in shares.
</ResponseField>

<ResponseField name="feeUsdc" type="string">
  Fee charged for the trade denominated in USDC.
</ResponseField>

<ResponseField name="err_msg" type="string | null">
  Optional. Error message if the trade encountered an issue, otherwise null.
</ResponseField>

<ResponseField name="createdAt" type="string | null">
  Timestamp when the trade record was created, or null if unavailable.
</ResponseField>

<ResponseField name="updatedAt" type="string | null">
  Timestamp when the trade record was last updated, or null if unavailable.
</ResponseField>

***

## See Also

<CardGroup cols={2}>
  <Card title="Builders Program" icon="hammer" href="/builders/overview">
    Learn about the Builders Program and its benefits.
  </Card>

  <Card title="Order Attribution" icon="key" href="/trading/orders/attribution">
    Attach your builder code to orders for volume credit.
  </Card>

  <Card title="L2 Methods" icon="lock" href="/trading/clients/l2">
    Place and manage orders with API credentials.
  </Card>

  <Card title="Gasless Transactions" icon="gas-pump" href="/trading/gasless">
    Execute onchain operations without paying gas.
  </Card>
</CardGroup>
