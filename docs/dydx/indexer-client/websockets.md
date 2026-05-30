# dYdX WebSockets API Documentation

> Source: https://docs.dydx.xyz/indexer-client/websockets

## Overview

The WebSockets API delivers real-time data to traders through multiple channels and feeds.

## Common Message Schemas

### Subscribe Message
```json
{
  "type": "subscribe",
  "channel": "v4_trades",
  "id": "BTC-USD",
  "batched": false
}
```

- `type` — `subscribe`.
- `channel` — feed type identifier.
- `id` — channel-specific data selector (used in some channels).
- `batched` — enable message batching.

### Unsubscribe Message
```json
{
  "type": "unsubscribe",
  "channel": "v4_trades",
  "id": "BTC-USD"
}
```

### Data Message Schema

- `connection_id` — subscription identifier.
- `channel` — feed type identifier.
- `id` — channel-specific selector.
- `message_id` — sequence number.
- `version` — protocol identifier.
- `contents` — channel-specific data.

## Available Channels

### Subaccounts — real-time updates for a specific subaccount (positions, orders, fills)
```python
def subscribe(self, address: str, subaccount_number: int) -> Self
def unsubscribe(self, address: str, subaccount_number: int)
```
**ID Format:** `{address}/{subaccount-number}`.

### Markets — updates for all dYdX markets (parameters and oracle prices)
```python
def subscribe(self, batched: bool = True) -> Self
def unsubscribe(self)
```

### Trades — fills with side/price/size
```python
def subscribe(self, id: str, batched: bool = True) -> Self
def unsubscribe(self, id: str)
```

### Orders (Order Book) — bid/ask lists for a market
```python
def subscribe(self, id: str, batched: bool = True) -> Self
def unsubscribe(self, id: str)
```

### Candles — candlestick data with configurable resolution
```python
def subscribe(self, id: str, resolution: CandlesResolution, batched: bool = True) -> Self
def unsubscribe(self, id: str, resolution: CandlesResolution)
```
**ID Format:** `{market}/{resolution}`.

### Parent Subaccounts — isolated position management (subaccount numbers 0..127)
Status: coming soon for Python/TypeScript clients.

### Block Height — current block height and timestamp
Status: under unification plan for client library additions.
