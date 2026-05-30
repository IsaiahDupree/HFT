# Advanced Trade — WebSocket Overview

> Source: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview
> Mirrored: 2026-05-25

The WebSocket feed provides real-time market data updates for orders and trades through two production endpoints:

* **Market Data** (`wss://advanced-trade-ws.coinbase.com`): Traditional feed with order and trade updates; most channels available without authentication
* **User Order Data** (`wss://advanced-trade-ws-user.coinbase.com`): Updates for user-specific orders

## Protocol

All messages use JSON format with a `type` attribute for routing. The system supports bidirectional communication where new message types may be added; clients should ignore unsupported types.

## Subscription Requirements

You must send a `subscribe` message within 5 seconds of connecting or face disconnection. Each channel subscription requires a separate message.

### With CDP Keys

**Subscribe message structure:**
```json
{
  "type": "subscribe",
  "product_ids": ["ETH-USD", "ETH-EUR"],
  "channel": "level2",
  "jwt": "exampleJWT"
}
```

Required fields:
* `channel`: Single channel name per message
* `jwt`: Generated token (valid 2 minutes; regenerate for each message)

**Unsubscribe structure:** Identical format with `"type": "unsubscribe"`

### Without API Keys

Simplified messages omit the `jwt` field:
```json
{
  "type": "subscribe",
  "product_ids": ["ETH-USD", "ETH-EUR"],
  "channel": "level2"
}
```

## Code Examples

JavaScript and Python implementations are provided showing JWT signing, subscription, and message handling patterns. Both demonstrate ES256 algorithm signing with API credentials.

## Sequence Number Handling

Feed messages include sequence numbers — incrementing integers per product. Gaps indicate dropped messages; lower values suggest out-of-order delivery. Applications must handle both scenarios to maintain state consistency.

The system notes: "Even though a WebSocket connection is over TCP, the WebSocket servers receive market data in a manner that can result in dropped messages." Using the level2 channel provides delivery guarantees.
