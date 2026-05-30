> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Overview

> Real-time market data and trading updates via WebSocket

Polymarket provides WebSocket channels for near real-time streaming of orderbook data, trades, and personal order activity. There are four available channels: `market`, `user`, `sports`, and `RTDS` (Real-Time Data Socket).

## Channels

| Channel                             | Endpoint                                               | Auth     |
| ----------------------------------- | ------------------------------------------------------ | -------- |
| Market                              | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | No       |
| User                                | `wss://ws-subscriptions-clob.polymarket.com/ws/user`   | Yes      |
| Sports                              | `wss://sports-api.polymarket.com/ws`                   | No       |
| [RTDS](/market-data/websocket/rtds) | `wss://ws-live-data.polymarket.com`                    | Optional |

### Market Channel

| Type               | Description             | Custom Feature |
| ------------------ | ----------------------- | -------------- |
| `book`             | Full orderbook snapshot | No             |
| `price_change`     | Price level updates     | No             |
| `tick_size_change` | Tick size changes       | No             |
| `last_trade_price` | Trade executions        | No             |
| `best_bid_ask`     | Best prices update      | Yes            |
| `new_market`       | New market created      | Yes            |
| `market_resolved`  | Market resolution       | Yes            |

Types marked "Custom Feature" require `custom_feature_enabled: true` in your subscription.

### User Channel

| Type    | Description                                   |
| ------- | --------------------------------------------- |
| `trade` | Trade lifecycle updates (MATCHED → CONFIRMED) |
| `order` | Order placements, updates, and cancellations  |

### Sports

| Type           | Description                           |
| -------------- | ------------------------------------- |
| `sport_result` | Live game scores, periods, and status |

## Subscribing

Send a subscription message after connecting to specify which data you want to receive.

### Market Channel

```json theme={null}
{
  "assets_ids": [
    "21742633143463906290569050155826241533067272736897614950488156847949938836455",
    "48331043336612883890938759509493159234755048973500640148014422747788308965732"
  ],
  "type": "market",
  "custom_feature_enabled": true
}
```

| Field                    | Type      | Description                                                       |
| ------------------------ | --------- | ----------------------------------------------------------------- |
| `assets_ids`             | string\[] | Token IDs to subscribe to                                         |
| `type`                   | string    | Channel identifier                                                |
| `custom_feature_enabled` | boolean   | Enable `best_bid_ask`, `new_market`, and `market_resolved` events |

### User Channel

```json theme={null}
{
  "auth": {
    "apiKey": "your-api-key",
    "secret": "your-api-secret",
    "passphrase": "your-passphrase"
  },
  "markets": ["0x1234...condition_id"],
  "type": "user"
}
```

<Note>
  The `auth` fields (`apiKey`, `secret`, `passphrase`) are **only required for
  the user channel**. For the market channel, these fields are optional and can
  be omitted.
</Note>

| Field     | Type      | Description                                        |
| --------- | --------- | -------------------------------------------------- |
| `auth`    | object    | API credentials (`apiKey`, `secret`, `passphrase`) |
| `markets` | string\[] | Condition IDs to receive events for                |
| `type`    | string    | Channel identifier                                 |

<Note>
  The user channel subscribes by **condition IDs** (market identifiers), not
  asset IDs. Each market has one condition ID but two asset IDs (Yes and No
  tokens).
</Note>

### Sports Channel

No subscription message required. Connect and start receiving data for all active sports events.

## Dynamic Subscription

Modify subscriptions without reconnecting.

### Subscribe to more assets

```json theme={null}
{
  "assets_ids": ["new_asset_id_1", "new_asset_id_2"],
  "operation": "subscribe",
  "custom_feature_enabled": true
}
```

### Unsubscribe from assets

```json theme={null}
{
  "assets_ids": ["asset_id_to_remove"],
  "operation": "unsubscribe"
}
```

For the user channel, use `markets` instead of `assets_ids`:

```json theme={null}
{
  "markets": ["0x1234...condition_id"],
  "operation": "subscribe"
}
```

## Heartbeats

### Market and User Channels

Send `PING` every 10 seconds. The server responds with `PONG`.

```
PING
```

### Sports Channel

The server sends `ping` every 5 seconds. Respond with `pong` within 10 seconds.

```
pong
```

<Warning>
  If you don't respond to the server's ping within 10 seconds, the connection
  will be closed.
</Warning>

## Troubleshooting

<Accordion title="Connection closes immediately after opening">
  Send a valid subscription message immediately after connecting. The server may
  close connections that don't subscribe within a timeout period.
</Accordion>

<Accordion title="Connection drops after about 10 seconds">
  You're not sending heartbeats. Send `PING` every 10 seconds for market/user
  channels, or respond to server `ping` with `pong` for the sports channel.
</Accordion>

<Accordion title="Not receiving any messages">
  1. Verify your asset IDs or condition IDs are correct 2. Check that the
     markets are active (not resolved) 3. Set `custom_feature_enabled: true` if
     expecting `best_bid_ask`, `new_market`, or `market_resolved` events
</Accordion>

<Accordion title="Authentication failed - user channel">
  Verify your API credentials are correct and haven't expired.
</Accordion>
