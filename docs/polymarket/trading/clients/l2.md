> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# L2 Methods

> These methods require user API credentials (L2 headers). Use these for placing trades and managing your positions.

## Client Initialization

L2 methods require the client to initialize with a signer, signature type, API credentials, and funder address.

<Tabs>
  <Tab title="TypeScript">
    ```typescript theme={null}
    import { ClobClient } from "@polymarket/clob-client-v2";
    import { createWalletClient, http } from "viem";
    import { privateKeyToAccount } from "viem/accounts";

    const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
    const signer = createWalletClient({ account, transport: http() });

    const apiCreds = {
      key: process.env.API_KEY,
      secret: process.env.SECRET,
      passphrase: process.env.PASSPHRASE,
    };
    const depositWalletAddress = process.env.DEPOSIT_WALLET_ADDRESS!;

    const client = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer,
      creds: apiCreds,
      signatureType: 3, // POLY_1271
      funderAddress: depositWalletAddress,
    });

    // Ready to send authenticated requests
    const order = await client.postOrder(signedOrder);
    ```
  </Tab>

  <Tab title="Python">
    ```python theme={null}
    from py_clob_client_v2 import ClobClient
    from py_clob_client_v2 import ApiCreds
    import os

    api_creds = ApiCreds(
        api_key=os.getenv("API_KEY"),
        api_secret=os.getenv("SECRET"),
        api_passphrase=os.getenv("PASSPHRASE")
    )

    client = ClobClient(
        host="https://clob.polymarket.com",
        chain_id=137,
        key=os.getenv("PRIVATE_KEY"),
        creds=api_creds,
        signature_type=3,  # POLY_1271
        funder=os.getenv("DEPOSIT_WALLET_ADDRESS")
    )

    # Ready to send authenticated requests
    order = client.post_order(signed_order)
    ```
  </Tab>
</Tabs>

***

## Order Creation and Management

***

### createAndPostOrder

Convenience method that creates, signs, and posts a limit order in a single call. Use when you want to buy or sell at a specific price.

```typescript Signature theme={null}
async createAndPostOrder(
  userOrder: UserOrder,
  options?: Partial<CreateOrderOptions>,
  orderType?: OrderType.GTC | OrderType.GTD, // Defaults to GTC
): Promise<OrderResponse>
```

**Params**

<ResponseField name="tokenID" type="string">
  The token ID of the outcome to trade.
</ResponseField>

<ResponseField name="price" type="number">
  The limit price for the order.
</ResponseField>

<ResponseField name="size" type="number">
  The size of the order.
</ResponseField>

<ResponseField name="side" type="Side">
  The side of the order (buy or sell).
</ResponseField>

<ResponseField name="expiration" type="number">
  Optional expiration timestamp for the order.
</ResponseField>

<ResponseField name="tickSize" type="TickSize">
  Tick size for the order. One of `"0.1"`, `"0.01"`, `"0.001"`, `"0.0001"`.
</ResponseField>

<ResponseField name="negRisk" type="boolean">
  Optional. Whether the market uses negative risk.
</ResponseField>

**Response**

<ResponseField name="success" type="boolean">
  Whether the order was successfully placed.
</ResponseField>

<ResponseField name="errorMsg" type="string">
  Error message if the order was not successful.
</ResponseField>

<ResponseField name="orderID" type="string">
  The ID of the placed order.
</ResponseField>

<ResponseField name="transactionsHashes" type="string[]">
  Array of transaction hashes associated with the order.
</ResponseField>

<ResponseField name="status" type="string">
  The current status of the order.
</ResponseField>

<ResponseField name="takingAmount" type="string">
  The amount being taken in the order.
</ResponseField>

<ResponseField name="makingAmount" type="string">
  The amount being made in the order.
</ResponseField>

***

### createAndPostMarketOrder

Convenience method that creates, signs, and posts a market order in a single call. Use when you want to buy or sell at the current market price.

```typescript Signature theme={null}
async createAndPostMarketOrder(
  userMarketOrder: UserMarketOrder,
  options?: Partial<CreateOrderOptions>,
  orderType?: OrderType.FOK | OrderType.FAK, // Defaults to FOK
): Promise<OrderResponse>
```

**Params**

<ResponseField name="tokenID" type="string">
  The token ID of the outcome to trade.
</ResponseField>

<ResponseField name="amount" type="number">
  The amount for the market order.
</ResponseField>

<ResponseField name="side" type="Side">
  The side of the order (buy or sell).
</ResponseField>

<ResponseField name="price" type="number">
  Optional price hint for the market order.
</ResponseField>

<ResponseField name="orderType" type="OrderType.FOK | OrderType.FAK">
  Optional order type override. Defaults to FOK.
</ResponseField>

**Response**

<ResponseField name="success" type="boolean">
  Whether the order was successfully placed.
</ResponseField>

<ResponseField name="errorMsg" type="string">
  Error message if the order was not successful.
</ResponseField>

<ResponseField name="orderID" type="string">
  The ID of the placed order.
</ResponseField>

<ResponseField name="transactionsHashes" type="string[]">
  Array of transaction hashes associated with the order.
</ResponseField>

<ResponseField name="status" type="string">
  The current status of the order.
</ResponseField>

<ResponseField name="takingAmount" type="string">
  The amount being taken in the order.
</ResponseField>

<ResponseField name="makingAmount" type="string">
  The amount being made in the order.
</ResponseField>

***

### postOrder

Posts a pre-signed order to the CLOB. Use with [`createOrder()`](/trading/clients/l1#createorder) or [`createMarketOrder()`](/trading/clients/l1#createmarketorder) from L1 methods.

```typescript Signature theme={null}
async postOrder(
  order: SignedOrder,
  orderType?: OrderType, // Defaults to GTC
  postOnly?: boolean,    // Defaults to false
): Promise<OrderResponse>
```

***

### postOrders

Posts up to 15 pre-signed orders in a single batch.

```typescript Signature theme={null}
async postOrders(
  args: PostOrdersArgs[],
): Promise<OrderResponse[]>
```

**Params**

<ResponseField name="order" type="SignedOrder">
  The pre-signed order to post.
</ResponseField>

<ResponseField name="orderType" type="OrderType">
  The order type (e.g. GTC, FOK, FAK).
</ResponseField>

<ResponseField name="postOnly" type="boolean">
  Optional. Whether to post the order as post-only. Defaults to false.
</ResponseField>

***

### cancelOrder

Cancels a single open order.

```typescript Signature theme={null}
async cancelOrder(orderID: string): Promise<CancelOrdersResponse>
```

**Response**

<ResponseField name="canceled" type="string[]">
  Array of order IDs that were successfully canceled.
</ResponseField>

<ResponseField name="not_canceled" type="Record<string, any>">
  Map of order IDs to reasons why they could not be canceled.
</ResponseField>

***

### cancelOrders

Cancels multiple orders in a single batch.

```typescript Signature theme={null}
async cancelOrders(orderIDs: string[]): Promise<CancelOrdersResponse>
```

***

### cancelAll

Cancels all open orders.

```typescript Signature theme={null}
async cancelAll(): Promise<CancelOrdersResponse>
```

***

### cancelMarketOrders

Cancels all open orders for a specific market.

```typescript Signature theme={null}
async cancelMarketOrders(
  payload: OrderMarketCancelParams
): Promise<CancelOrdersResponse>
```

**Params**

<ResponseField name="market" type="string">
  Optional. The market condition ID to cancel orders for.
</ResponseField>

<ResponseField name="asset_id" type="string">
  Optional. The token ID to cancel orders for.
</ResponseField>

***

## Order and Trade Queries

***

### getOrder

Get details for a specific order by ID.

```typescript Signature theme={null}
async getOrder(orderID: string): Promise<OpenOrder>
```

**Response**

<ResponseField name="id" type="string">
  The unique order ID.
</ResponseField>

<ResponseField name="status" type="string">
  The current status of the order.
</ResponseField>

<ResponseField name="owner" type="string">
  The API key of the order owner.
</ResponseField>

<ResponseField name="maker_address" type="string">
  The on-chain address of the order maker.
</ResponseField>

<ResponseField name="market" type="string">
  The market condition ID the order belongs to.
</ResponseField>

<ResponseField name="asset_id" type="string">
  The token ID the order is for.
</ResponseField>

<ResponseField name="side" type="string">
  The side of the order (BUY or SELL).
</ResponseField>

<ResponseField name="original_size" type="string">
  The original size of the order when it was placed.
</ResponseField>

<ResponseField name="size_matched" type="string">
  The amount of the order that has been matched so far.
</ResponseField>

<ResponseField name="price" type="string">
  The limit price of the order.
</ResponseField>

<ResponseField name="associate_trades" type="string[]">
  Array of trade IDs associated with this order.
</ResponseField>

<ResponseField name="outcome" type="string">
  The outcome label for the order's token.
</ResponseField>

<ResponseField name="created_at" type="number">
  Unix timestamp of when the order was created.
</ResponseField>

<ResponseField name="expiration" type="string">
  The expiration time of the order.
</ResponseField>

<ResponseField name="order_type" type="string">
  The order type (e.g. GTC, FOK, FAK, GTD).
</ResponseField>

***

### getOpenOrders

Get all your open orders.

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

***

### getTrades

Get your trade history (filled orders).

```typescript Signature theme={null}
async getTrades(
  params?: TradeParams,
  only_first_page?: boolean,
): Promise<Trade[]>
```

**Params**

<ResponseField name="id" type="string">
  Optional. Filter by trade ID.
</ResponseField>

<ResponseField name="maker_address" type="string">
  Optional. Filter by maker address.
</ResponseField>

<ResponseField name="market" type="string">
  Optional. Filter by market condition ID.
</ResponseField>

<ResponseField name="asset_id" type="string">
  Optional. Filter by token ID.
</ResponseField>

<ResponseField name="before" type="string">
  Optional. Return trades before this timestamp.
</ResponseField>

<ResponseField name="after" type="string">
  Optional. Return trades after this timestamp.
</ResponseField>

**Response**

<ResponseField name="id" type="string">
  The unique trade ID.
</ResponseField>

<ResponseField name="taker_order_id" type="string">
  The order ID of the taker side.
</ResponseField>

<ResponseField name="market" type="string">
  The market condition ID for the trade.
</ResponseField>

<ResponseField name="asset_id" type="string">
  The token ID for the trade.
</ResponseField>

<ResponseField name="side" type="Side">
  The side of the trade (BUY or SELL).
</ResponseField>

<ResponseField name="size" type="string">
  The size of the trade.
</ResponseField>

<ResponseField name="fee_rate_bps" type="string">
  The fee rate in basis points.
</ResponseField>

<ResponseField name="price" type="string">
  The price at which the trade was matched.
</ResponseField>

<ResponseField name="status" type="string">
  The current status of the trade.
</ResponseField>

<ResponseField name="match_time" type="string">
  The time at which the trade was matched.
</ResponseField>

<ResponseField name="last_update" type="string">
  The time of the last update to this trade.
</ResponseField>

<ResponseField name="outcome" type="string">
  The outcome label for the traded token.
</ResponseField>

<ResponseField name="bucket_index" type="number">
  The bucket index for the trade.
</ResponseField>

<ResponseField name="owner" type="string">
  The API key of the trade owner.
</ResponseField>

<ResponseField name="maker_address" type="string">
  The on-chain address of the maker.
</ResponseField>

<ResponseField name="maker_orders" type="MakerOrder[]">
  Array of maker order objects that participated in this trade. Each
  `MakerOrder` contains the following fields:
</ResponseField>

<ResponseField name="maker_orders[].order_id" type="string">
  The maker order ID.
</ResponseField>

<ResponseField name="maker_orders[].owner" type="string">
  The API key of the maker order owner.
</ResponseField>

<ResponseField name="maker_orders[].maker_address" type="string">
  The on-chain address of the maker order maker.
</ResponseField>

<ResponseField name="maker_orders[].matched_amount" type="string">
  The amount matched for this maker order.
</ResponseField>

<ResponseField name="maker_orders[].price" type="string">
  The price of the maker order.
</ResponseField>

<ResponseField name="maker_orders[].fee_rate_bps" type="string">
  The fee rate in basis points for the maker order.
</ResponseField>

<ResponseField name="maker_orders[].asset_id" type="string">
  The token ID for the maker order.
</ResponseField>

<ResponseField name="maker_orders[].outcome" type="string">
  The outcome label for the maker order's token.
</ResponseField>

<ResponseField name="maker_orders[].side" type="Side">
  The side of the maker order (BUY or SELL).
</ResponseField>

<ResponseField name="transaction_hash" type="string">
  The on-chain transaction hash for the trade.
</ResponseField>

<ResponseField name="trader_side" type="&#x22;TAKER&#x22; | &#x22;MAKER&#x22;">
  Whether the authenticated user is the taker or a maker in this trade.
</ResponseField>

***

### getTradesPaginated

Get trade history with pagination for large result sets.

```typescript Signature theme={null}
async getTradesPaginated(
  params?: TradeParams,
): Promise<TradesPaginatedResponse>
```

**Response**

<ResponseField name="trades" type="Trade[]">
  Array of trade objects for the current page.
</ResponseField>

<ResponseField name="limit" type="number">
  The maximum number of trades returned per page.
</ResponseField>

<ResponseField name="count" type="number">
  The total number of trades matching the query.
</ResponseField>

***

## Balance and Allowances

***

### getBalanceAllowance

Get your balance and allowance for specific tokens.

```typescript Signature theme={null}
async getBalanceAllowance(
  params?: BalanceAllowanceParams
): Promise<BalanceAllowanceResponse>
```

**Params**

<ResponseField name="asset_type" type="AssetType">
  The type of asset to query. One of `"COLLATERAL"` or `"CONDITIONAL"`.
</ResponseField>

<ResponseField name="token_id" type="string">
  Optional. The token ID to query (required when `asset_type` is `CONDITIONAL`).
</ResponseField>

**Response**

<ResponseField name="balance" type="string">
  The current balance for the specified asset.
</ResponseField>

<ResponseField name="allowance" type="string">
  The current allowance for the specified asset.
</ResponseField>

***

### updateBalanceAllowance

Updates the cached balance and allowance for specific tokens.

```typescript Signature theme={null}
async updateBalanceAllowance(
  params?: BalanceAllowanceParams
): Promise<void>
```

***

## API Key Management

***

### getApiKeys

Get all API keys associated with your account.

```typescript Signature theme={null}
async getApiKeys(): Promise<ApiKeysResponse>
```

**Response**

<ResponseField name="apiKeys" type="ApiKeyCreds[]">
  Array of API key credential objects associated with the account.
</ResponseField>

***

### deleteApiKey

Deletes (revokes) the currently authenticated API key.

```typescript Signature theme={null}
async deleteApiKey(): Promise<any>
```

***

## Notifications

***

### getNotifications

Retrieves all event notifications for the authenticated user. Records are automatically removed after 48 hours.

```typescript Signature theme={null}
async getNotifications(): Promise<Notification[]>
```

**Response**

<ResponseField name="id" type="number">
  Unique notification ID.
</ResponseField>

<ResponseField name="owner" type="string">
  The user's API key, or an empty string for global notifications.
</ResponseField>

<ResponseField name="payload" type="any">
  Type-specific payload data for the notification.
</ResponseField>

<ResponseField name="timestamp" type="number">
  Optional Unix timestamp of when the notification was created.
</ResponseField>

<ResponseField name="type" type="number">
  Notification type (see below).
</ResponseField>

| Name               | Value | Description                              |
| ------------------ | ----- | ---------------------------------------- |
| Order Cancellation | `1`   | User's order was canceled                |
| Order Fill         | `2`   | User's order was filled (maker or taker) |
| Market Resolved    | `4`   | Market was resolved                      |

***

### dropNotifications

Mark notifications as read/dismissed.

```typescript Signature theme={null}
async dropNotifications(params?: DropNotificationParams): Promise<void>
```

**Params**

<ResponseField name="ids" type="string[]">
  Array of notification IDs to dismiss.
</ResponseField>

***

## See Also

<CardGroup cols={2}>
  <Card title="Authentication" icon="shield" href="/api-reference/authentication">
    Deep dive into L1 and L2 authentication.
  </Card>

  <Card title="L1 Methods" icon="key" href="/trading/clients/l1">
    Sign orders and derive API credentials with your private key.
  </Card>

  <Card title="Public Methods" icon="globe" href="/trading/clients/public">
    Read market data and orderbooks without auth.
  </Card>

  <Card title="WebSocket" icon="bolt" href="/market-data/websocket/overview">
    Real-time market data streaming.
  </Card>
</CardGroup>
