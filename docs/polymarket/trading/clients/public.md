> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Public Methods

> These methods can be called without a signer or user credentials. Use these for reading market data, prices, and order books.

## Client Initialization

Public methods require the client to initialize with the host URL and Polygon chain ID.

<Tabs>
  <Tab title="TypeScript">
    ```typescript theme={null}
    import { ClobClient } from "@polymarket/clob-client-v2";

    const client = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137,
    });

    // Ready to call public methods
    const markets = await client.getMarkets();
    ```
  </Tab>

  <Tab title="Python">
    ```python theme={null}
    from py_clob_client_v2 import ClobClient

    client = ClobClient(
        host="https://clob.polymarket.com",
        chain_id=137
    )

    # Ready to call public methods
    markets = client.get_markets()
    ```
  </Tab>
</Tabs>

***

## Health Check

***

### getOk

Health check endpoint to verify the CLOB service is operational.

```typescript Signature theme={null}
async getOk(): Promise<any>
```

***

## Markets

***

### getMarket

Get details for a single market by condition ID.

```typescript Signature theme={null}
async getMarket(conditionId: string): Promise<Market>
```

<ResponseField name="accepting_order_timestamp" type="string">
  Timestamp from which the market started accepting orders, or null if not set.
</ResponseField>

<ResponseField name="accepting_orders" type="boolean">
  Whether the market is currently accepting orders.
</ResponseField>

<ResponseField name="active" type="boolean">
  Whether the market is active.
</ResponseField>

<ResponseField name="archived" type="boolean">
  Whether the market has been archived.
</ResponseField>

<ResponseField name="closed" type="boolean">
  Whether the market is closed.
</ResponseField>

<ResponseField name="condition_id" type="string">
  The unique condition ID for the market.
</ResponseField>

<ResponseField name="description" type="string">
  Human-readable description of the market.
</ResponseField>

<ResponseField name="enable_order_book" type="boolean">
  Whether the order book is enabled for this market.
</ResponseField>

<ResponseField name="end_date_iso" type="string">
  ISO 8601 end date of the market.
</ResponseField>

<ResponseField name="fpmm" type="string">
  Address of the Fixed Product Market Maker contract.
</ResponseField>

<ResponseField name="game_start_time" type="string">
  Start time of the underlying game or event.
</ResponseField>

<ResponseField name="icon" type="string">
  URL of the market icon image.
</ResponseField>

<ResponseField name="image" type="string">
  URL of the market image.
</ResponseField>

<ResponseField name="is_50_50_outcome" type="boolean">
  Whether the market has equal 50/50 outcomes.
</ResponseField>

<ResponseField name="maker_base_fee" type="number">
  Base fee charged to makers in basis points.
</ResponseField>

<ResponseField name="market_slug" type="string">
  URL-friendly slug identifier for the market.
</ResponseField>

<ResponseField name="minimum_order_size" type="number">
  Minimum order size allowed in this market.
</ResponseField>

<ResponseField name="minimum_tick_size" type="number">
  Minimum price increment allowed in this market.
</ResponseField>

<ResponseField name="neg_risk" type="boolean">
  Whether the market uses negative risk (binary complementary tokens).
</ResponseField>

<ResponseField name="neg_risk_market_id" type="string">
  Negative risk market identifier, if applicable.
</ResponseField>

<ResponseField name="neg_risk_request_id" type="string">
  Negative risk request identifier, if applicable.
</ResponseField>

<ResponseField name="notifications_enabled" type="boolean">
  Whether notifications are enabled for this market.
</ResponseField>

<ResponseField name="question" type="string">
  The market question text.
</ResponseField>

<ResponseField name="question_id" type="string">
  Unique identifier for the market question.
</ResponseField>

<ResponseField name="rewards" type="object">
  Object containing reward config: `max_spread` (number), `min_size` (number), `rates` (any)
</ResponseField>

<ResponseField name="seconds_delay" type="number">
  Delay in seconds before orders are processed.
</ResponseField>

<ResponseField name="tags" type="string[]">
  List of tags associated with the market.
</ResponseField>

<ResponseField name="taker_base_fee" type="number">
  Base fee charged to takers in basis points.
</ResponseField>

<ResponseField name="tokens" type="MarketToken[]">
  Array of market tokens, each containing `outcome` (string), `price` (number), `token_id` (string), and `winner` (boolean).
</ResponseField>

***

### getMarkets

Get details for multiple markets paginated.

```typescript Signature theme={null}
async getMarkets(): Promise<PaginationPayload>
```

<ResponseField name="limit" type="number">
  Maximum number of results per page.
</ResponseField>

<ResponseField name="count" type="number">
  Total number of markets returned.
</ResponseField>

<ResponseField name="data" type="Market[]">
  Array of Market objects. See `getMarket()` for the full Market structure.
</ResponseField>

***

### getSimplifiedMarkets

Get simplified market data paginated for faster loading.

```typescript Signature theme={null}
async getSimplifiedMarkets(): Promise<PaginationPayload>
```

<ResponseField name="limit" type="number">
  Maximum number of results per page.
</ResponseField>

<ResponseField name="count" type="number">
  Total number of markets returned.
</ResponseField>

<ResponseField name="data" type="SimplifiedMarket[]">
  Array of simplified market objects, each containing `accepting_orders` (boolean), `active` (boolean), `archived` (boolean), `closed` (boolean), `condition_id` (string), `rewards` (object with `rates`, `min_size`, `max_spread`), and `tokens` (SimplifiedToken\[]) with `outcome` (string), `price` (number), `token_id` (string).
</ResponseField>

***

### getSamplingMarkets

Get markets eligible for sampling/liquidity rewards.

```typescript Signature theme={null}
async getSamplingMarkets(): Promise<PaginationPayload>
```

***

### getSamplingSimplifiedMarkets

Get simplified market data for markets eligible for sampling/liquidity rewards.

```typescript Signature theme={null}
async getSamplingSimplifiedMarkets(): Promise<PaginationPayload>
```

***

## Order Books and Prices

***

### calculateMarketPrice

Calculate the estimated price for a market order of a given size.

```typescript Signature theme={null}
async calculateMarketPrice(
  tokenID: string,
  side: Side,
  amount: number,
  orderType: OrderType = OrderType.FOK
): Promise<number>
```

<ResponseField name="tokenID" type="string">
  The token ID to calculate the market price for.
</ResponseField>

<ResponseField name="side" type="Side">
  The side of the order. One of: `BUY`, `SELL`
</ResponseField>

<ResponseField name="amount" type="number">
  The size of the order to calculate price for.
</ResponseField>

<ResponseField name="orderType" type="OrderType">
  The order type. One of: `GTC` (Good Till Cancelled), `FOK` (Fill or Kill), `GTD` (Good Till Date), `FAK` (Fill and Kill). Defaults to `FOK`.
</ResponseField>

<ResponseField name="returns" type="number">
  The calculated estimated market price for the given order size.
</ResponseField>

***

### getOrderBook

Get the order book for a specific token ID.

```typescript Signature theme={null}
async getOrderBook(tokenID: string): Promise<OrderBookSummary>
```

<ResponseField name="market" type="string">
  The market condition ID.
</ResponseField>

<ResponseField name="asset_id" type="string">
  The token/asset ID for this order book.
</ResponseField>

<ResponseField name="timestamp" type="string">
  Timestamp of the order book snapshot.
</ResponseField>

<ResponseField name="bids" type="OrderSummary[]">
  Array of bid entries, each with `price` (string) and `size` (string).
</ResponseField>

<ResponseField name="asks" type="OrderSummary[]">
  Array of ask entries, each with `price` (string) and `size` (string).
</ResponseField>

<ResponseField name="min_order_size" type="string">
  Minimum order size for this market.
</ResponseField>

<ResponseField name="tick_size" type="string">
  Minimum price increment for this market.
</ResponseField>

<ResponseField name="neg_risk" type="boolean">
  Whether the market uses negative risk.
</ResponseField>

<ResponseField name="hash" type="string">
  Hash of the order book state.
</ResponseField>

***

### getOrderBooks

Get order books for multiple token IDs.

```typescript Signature theme={null}
async getOrderBooks(params: BookParams[]): Promise<OrderBookSummary[]>
```

<ResponseField name="token_id" type="string">
  The token ID to fetch the order book for.
</ResponseField>

<ResponseField name="side" type="Side">
  The side of the book to query. One of: `BUY`, `SELL`
</ResponseField>

<ResponseField name="returns" type="OrderBookSummary[]">
  Array of OrderBookSummary objects. See `getOrderBook()` for the full structure.
</ResponseField>

***

### getPrice

Get the current best price for buying or selling a token ID.

```typescript Signature theme={null}
async getPrice(
  tokenID: string,
  side: "BUY" | "SELL"
): Promise<any>
```

<ResponseField name="price" type="string">
  The current best price for the requested side.
</ResponseField>

***

### getPrices

Get the current best prices for multiple token IDs.

```typescript Signature theme={null}
async getPrices(params: BookParams[]): Promise<PricesResponse>
```

<ResponseField name="returns" type="PricesResponse">
  A map of token IDs to their prices. Each entry contains an optional `BUY` (string) and/or `SELL` (string) price.
</ResponseField>

***

### getMidpoint

Get the midpoint price (average of best bid and best ask) for a token ID.

```typescript Signature theme={null}
async getMidpoint(tokenID: string): Promise<any>
```

<ResponseField name="mid" type="string">
  The midpoint price, calculated as the average of best bid and best ask.
</ResponseField>

***

### getMidpoints

Get the midpoint prices for multiple token IDs.

```typescript Signature theme={null}
async getMidpoints(params: BookParams[]): Promise<any>
```

<ResponseField name="returns" type="object">
  A map of token IDs to their midpoint price strings. Each key is a token ID and its value is the midpoint price as a string.
</ResponseField>

***

### getSpread

Get the spread (difference between best ask and best bid) for a token ID.

```typescript Signature theme={null}
async getSpread(tokenID: string): Promise<SpreadResponse>
```

<ResponseField name="spread" type="string">
  The spread value, calculated as the difference between best ask and best bid.
</ResponseField>

***

### getSpreads

Get the spreads for multiple token IDs.

```typescript Signature theme={null}
async getSpreads(params: BookParams[]): Promise<SpreadsResponse>
```

<ResponseField name="returns" type="object">
  A map of token IDs to their spread strings. Each key is a token ID and its value is the spread as a string.
</ResponseField>

***

### getPricesHistory

Get historical price data for a token.

```typescript Signature theme={null}
async getPricesHistory(params: PriceHistoryFilterParams): Promise<MarketPrice[]>
```

<ResponseField name="market" type="string">
  The token ID to fetch price history for.
</ResponseField>

<ResponseField name="startTs" type="number">
  Optional start timestamp (Unix seconds) for the price history range.
</ResponseField>

<ResponseField name="endTs" type="number">
  Optional end timestamp (Unix seconds) for the price history range.
</ResponseField>

<ResponseField name="fidelity" type="number">
  Optional fidelity/resolution of the price history data.
</ResponseField>

<ResponseField name="interval" type="PriceHistoryInterval">
  Time interval for the price history. One of: `max`, `1w`, `1d`, `6h`, `1h`
</ResponseField>

<ResponseField name="t" type="number">
  Unix timestamp of the price data point.
</ResponseField>

<ResponseField name="p" type="number">
  Price value at the corresponding timestamp.
</ResponseField>

***

## Trades

***

### getLastTradePrice

Get the price of the most recent trade for a token.

```typescript Signature theme={null}
async getLastTradePrice(tokenID: string): Promise<LastTradePrice>
```

<ResponseField name="price" type="string">
  The price of the most recent trade.
</ResponseField>

<ResponseField name="side" type="string">
  The side of the most recent trade.
</ResponseField>

***

### getLastTradesPrices

Get the most recent trade prices for multiple tokens.

```typescript Signature theme={null}
async getLastTradesPrices(params: BookParams[]): Promise<LastTradePriceWithToken[]>
```

<ResponseField name="price" type="string">
  The price of the most recent trade for the token.
</ResponseField>

<ResponseField name="side" type="string">
  The side of the most recent trade.
</ResponseField>

<ResponseField name="token_id" type="string">
  The token ID this trade price corresponds to.
</ResponseField>

***

### getMarketTradesEvents

Get recent trade events for a market.

```typescript Signature theme={null}
async getMarketTradesEvents(conditionID: string): Promise<MarketTradeEvent[]>
```

<ResponseField name="event_type" type="string">
  The type of trade event.
</ResponseField>

<ResponseField name="market" type="object">
  Object containing market info: `condition_id` (string), `asset_id` (string), `question` (string), `icon` (string), `slug` (string).
</ResponseField>

<ResponseField name="user" type="object">
  Object containing user info: `address` (string), `username` (string), `profile_picture` (string), `optimized_profile_picture` (string), `pseudonym` (string).
</ResponseField>

<ResponseField name="side" type="Side">
  The side of the trade. One of: `BUY`, `SELL`
</ResponseField>

<ResponseField name="size" type="string">
  The size of the trade.
</ResponseField>

<ResponseField name="fee_rate_bps" type="string">
  The fee rate in basis points for the trade.
</ResponseField>

<ResponseField name="price" type="string">
  The price at which the trade was executed.
</ResponseField>

<ResponseField name="outcome" type="string">
  The outcome label for the traded token.
</ResponseField>

<ResponseField name="outcome_index" type="number">
  The index of the outcome in the market.
</ResponseField>

<ResponseField name="transaction_hash" type="string">
  The on-chain transaction hash for the trade.
</ResponseField>

<ResponseField name="timestamp" type="string">
  The timestamp of when the trade event occurred.
</ResponseField>

***

## Market Parameters

***

### getClobMarketInfo

Fetch all CLOB-level parameters for a market in a single call — tokens, tick size, base fees, rewards config, RFQ status, and fee details.

```typescript Signature theme={null}
async getClobMarketInfo(conditionID: string): Promise<ClobMarketDetails>
```

<ResponseField name="conditionID" type="string">
  The condition ID of the market.
</ResponseField>

**Response (`ClobMarketDetails`)**

<ResponseField name="gst" type="string | null">
  Game start time (used for sports markets), ISO 8601 timestamp or `null`.
</ResponseField>

<ResponseField name="r" type="object">
  Rewards configuration for the market.
</ResponseField>

<ResponseField name="t" type="ClobToken[]">
  Tokens for this market. Each entry has:

  * `t` (string) — token ID
  * `o` (string) — outcome label (e.g. `Yes`, `No`)
</ResponseField>

<ResponseField name="mos" type="number">
  Minimum order size.
</ResponseField>

<ResponseField name="mts" type="number">
  Minimum tick size (price increment).
</ResponseField>

<ResponseField name="mbf" type="number">
  Maker base fee in basis points.
</ResponseField>

<ResponseField name="tbf" type="number">
  Taker base fee in basis points.
</ResponseField>

<ResponseField name="rfqe" type="boolean">
  Whether RFQ (Request for Quote) is enabled for this market.
</ResponseField>

<ResponseField name="itode" type="boolean">
  Whether taker order delay is enabled.
</ResponseField>

<ResponseField name="ibce" type="boolean">
  Whether Blockaid check is enabled.
</ResponseField>

<ResponseField name="fd" type="object">
  Fee curve parameters:

  * `r` (number) — fee rate
  * `e` (number) — fee curve exponent
  * `to` (boolean) — whether fees apply to takers only
</ResponseField>

<ResponseField name="oas" type="number">
  Minimum order age in seconds.
</ResponseField>

***

### getFeeRateBps

Get the fee rate in basis points for a token.

```typescript Signature theme={null}
async getFeeRateBps(tokenID: string): Promise<number>
```

<ResponseField name="returns" type="number">
  The fee rate in basis points for the specified token.
</ResponseField>

***

### getFeeExponent

Get the fee curve exponent for a token. The exponent shapes the fee curve used by the protocol when calculating fees at match time.

```typescript Signature theme={null}
async getFeeExponent(tokenID: string): Promise<number>
```

<ResponseField name="returns" type="number">
  The fee curve exponent for the specified token's market.
</ResponseField>

***

### getTickSize

Get the tick size (minimum price increment) for a market.

```typescript Signature theme={null}
async getTickSize(tokenID: string): Promise<TickSize>
```

<ResponseField name="returns" type="string">
  The tick size for the market. One of: `0.1`, `0.01`, `0.001`, `0.0001`
</ResponseField>

***

### getNegRisk

Check if a market uses negative risk (binary complementary tokens).

```typescript Signature theme={null}
async getNegRisk(tokenID: string): Promise<boolean>
```

<ResponseField name="returns" type="boolean">
  Whether the market uses negative risk.
</ResponseField>

***

## Time and Server Info

### getServerTime

Get the current server timestamp.

```typescript Signature theme={null}
async getServerTime(): Promise<number>
```

<ResponseField name="returns" type="number">
  Unix timestamp in seconds representing the current server time.
</ResponseField>

***

## See Also

<CardGroup cols={2}>
  <Card title="L1 Methods" icon="key" href="/trading/clients/l1">
    Private key authentication to create or derive API credentials.
  </Card>

  <Card title="L2 Methods" icon="lock" href="/trading/clients/l2">
    Place orders, cancel orders, and query your trades.
  </Card>

  <Card title="REST API Reference" icon="code" href="/api-reference/introduction">
    Complete REST endpoint documentation.
  </Card>

  <Card title="WebSocket" icon="bolt" href="/market-data/websocket/overview">
    Real-time market data streaming.
  </Card>
</CardGroup>
