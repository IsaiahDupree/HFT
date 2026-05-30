# Advanced Trade — Orders Guide

> Source: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/orders
> Mirrored: 2026-05-25

The Advanced Trade API enables order management through the Orders API (`/orders`). You can create orders via the [Create Order](/api-reference/advanced-trade-api/rest-api/orders/create-order) endpoint and retrieve them using [List Orders](/api-reference/advanced-trade-api/rest-api/orders/list-orders).

## Fulfillment Policies

Order fulfillment policies define time-in-force behavior:

* **Good Till Canceled** (`gtc`): "orders remain open on the book until canceled"
* **Good Till Date** (`gtd`): "orders are valid till a specified date or time"
* **Immediate Or Cancel** (`ioc`): "orders instantly cancel the remaining size of the limit order"

## Order Types

### Market Orders

Market orders execute at current market prices. Provide `quote_size` or `base_size` for buy orders; use `base_size` for sell orders.

**Possible types:**
* `market_market_ioc`
* `market_market_fok` (Perpetuals only)

### Limit Orders

These trigger based on quantity and price parameters. The `base_size` denotes base currency quantity; `limit_price` sets the maximum fill price.

**Possible types:**
* `limit_limit_gtc`
* `limit_limit_gtd`
* `sor_limit_ioc`

### Stop Orders

Stop orders activate when the last trade price moves to specified levels.

**Possible types:**
* `stop_limit_stop_limit_gtc`
* `stop_limit_stop_limit_gtd`

### Fill or Kill (FOK) Orders

"Fill or Kill orders will only be posted to the order book if they would be immediately and completely filled."

**Possible types:**
* `limit_limit_fok`

### Bracket Orders

Bracket orders combine a sell order with limit pricing and trigger pricing for risk mitigation. "As soon as a fill occurs for the order at one of the specified price levels, the other side is automatically disabled."

**Possible types:**
* `trigger_bracket_gtc`
* `trigger_bracket_gtd`

### Attached Take Profit/Stop Loss Orders

These orders set profit and loss thresholds. Include `attached_order_configuration` with `trigger_bracket_gtc` in the Create Order request; the attached order inherits the originating order's size.

**Example request:**

```json
{
  "client_order_id": "YOUR_CLIENT_ORDER_ID",
  "product_id": "ETH-USDC",
  "side": "BUY",
  "order_configuration": {
    "limit_limit_gtc": {
      "baseSize": "0.01",
      "limitPrice": "1500"
    }
  },
  "attached_order_configuration": {
    "trigger_bracket_gtc": {
      "limit_price": "1600",
      "stop_trigger_price": "1300"
    }
  }
}
```
