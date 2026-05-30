> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Market Channel

> Real-time orderbook, price, and trade data

Public channel for market data updates (level 2 price data). Subscribe with asset IDs to receive orderbook snapshots, price changes, trade executions, and market events.

## Endpoint

```
wss://ws-subscriptions-clob.polymarket.com/ws/market
```

## Subscription

```json theme={null}
{
  "assets_ids": ["<token_id_1>", "<token_id_2>"],
  "type": "market",
  "custom_feature_enabled": true
}
```

Set `custom_feature_enabled: true` to receive `best_bid_ask`, `new_market`, and `market_resolved` events.

## Message Types

Each message includes an `event_type` field identifying the type.

### book

Emitted when first subscribed to a market and when there is a trade that affects the book.

```json theme={null}
{
  "event_type": "book",
  "asset_id": "65818619657568813474341868652308942079804919287380422192892211131408793125422",
  "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
  "bids": [
    { "price": ".48", "size": "30" },
    { "price": ".49", "size": "20" },
    { "price": ".50", "size": "15" }
  ],
  "asks": [
    { "price": ".52", "size": "25" },
    { "price": ".53", "size": "60" },
    { "price": ".54", "size": "10" }
  ],
  "timestamp": "123456789000",
  "hash": "0x0...."
}
```

### price\_change

Emitted when a new order is placed or an order is cancelled.

```json theme={null}
{
  "market": "0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1",
  "price_changes": [
    {
      "asset_id": "71321045679252212594626385532706912750332728571942532289631379312455583992563",
      "price": "0.5",
      "size": "200",
      "side": "BUY",
      "hash": "56621a121a47ed9333273e21c83b660cff37ae50",
      "best_bid": "0.5",
      "best_ask": "1"
    },
    {
      "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
      "price": "0.5",
      "size": "200",
      "side": "SELL",
      "hash": "1895759e4df7a796bf4f1c5a5950b748306923e2",
      "best_bid": "0",
      "best_ask": "0.5"
    }
  ],
  "timestamp": "1757908892351",
  "event_type": "price_change"
}
```

A `size` of `"0"` means the price level has been removed from the book.

### tick\_size\_change

Emitted when the minimum tick size of a market changes. This happens when the book's price reaches the limits: price > 0.96 or price \< 0.04.

```json theme={null}
{
  "event_type": "tick_size_change",
  "asset_id": "65818619657568813474341868652308942079804919287380422192892211131408793125422",
  "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
  "old_tick_size": "0.01",
  "new_tick_size": "0.001",
  "timestamp": "100000000"
}
```

### last\_trade\_price

Emitted when a maker and taker order is matched, creating a trade event.

```json theme={null}
{
  "asset_id": "114122071509644379678018727908709560226618148003371446110114509806601493071694",
  "event_type": "last_trade_price",
  "fee_rate_bps": "0",
  "market": "0x6a67b9d828d53862160e470329ffea5246f338ecfffdf2cab45211ec578b0347",
  "price": "0.456",
  "side": "BUY",
  "size": "219.217767",
  "timestamp": "1750428146322"
}
```

### best\_bid\_ask

<Note>Requires `custom_feature_enabled: true`.</Note>

Emitted when the best bid or ask prices for a market change.

```json theme={null}
{
  "event_type": "best_bid_ask",
  "market": "0x0005c0d312de0be897668695bae9f32b624b4a1ae8b140c49f08447fcc74f442",
  "asset_id": "85354956062430465315924116860125388538595433819574542752031640332592237464430",
  "best_bid": "0.73",
  "best_ask": "0.77",
  "spread": "0.04",
  "timestamp": "1766789469958"
}
```

### new\_market

<Note>Requires `custom_feature_enabled: true`.</Note>

Emitted when a new market is created.

The payload also includes market metadata fields such as `tags`,
`condition_id`, `active`, `clob_token_ids`, `sports_market_type`, `line`,
`game_start_time`, `order_price_min_tick_size`, `group_item_title`,
`taker_base_fee`, `fees_enabled`, and `fee_schedule`.

Where a `FeeSchedule` object is of the form:

| Name         | Type    | Description                       |
| ------------ | ------- | --------------------------------- |
| exponent     | string  | fee curve exponent                |
| rate         | string  | fee rate                          |
| taker\_only  | boolean | whether fee applies to taker only |
| rebate\_rate | string  | maker rebate rate                 |

```json theme={null}
{
  "id": "1031769",
  "question": "Will NVIDIA (NVDA) close above $240 end of January?",
  "market": "0x311d0c4b6671ab54af4970c06fcf58662516f5168997bdda209ec3db5aa6b0c1",
  "slug": "nvda-above-240-on-january-30-2026",
  "description": "This market will resolve to \"Yes\" if the official closing price...",
  "assets_ids": [
    "76043073756653678226373981964075571318267289248134717369284518995922789326425",
    "31690934263385727664202099278545688007799199447969475608906331829650099442770"
  ],
  "outcomes": ["Yes", "No"],
  "event_message": {
    "id": "125819",
    "ticker": "nvda-above-in-january-2026",
    "slug": "nvda-above-in-january-2026",
    "title": "Will NVIDIA (NVDA) close above ___ end of January?",
    "description": "This market will resolve to \"Yes\" if the official closing price..."
  },
  "timestamp": "1766790415550",
  "event_type": "new_market",
  "tags": ["stocks"],
  "condition_id": "0x311d0c4b6671ab54af4970c06fcf58662516f5168997bdda209ec3db5aa6b0c1",
  "active": true,
  "clob_token_ids": [
    "76043073756653678226373981964075571318267289248134717369284518995922789326425",
    "31690934263385727664202099278545688007799199447969475608906331829650099442770"
  ],
  "sports_market_type": "",
  "line": "",
  "game_start_time": "",
  "order_price_min_tick_size": "0.01",
  "group_item_title": "NVDA above $240",
  "taker_base_fee": "0",
  "fees_enabled": true,
  "fee_schedule": {
    "exponent": "2",
    "rate": "0.02",
    "taker_only": true,
    "rebate_rate": "0"
  }
}
```

### market\_resolved

<Note>Requires `custom_feature_enabled: true`.</Note>

Emitted when a market is resolved.

```json theme={null}
{
  "id": "1031769",
  "question": "Will NVIDIA (NVDA) close above $240 end of January?",
  "market": "0x311d0c4b6671ab54af4970c06fcf58662516f5168997bdda209ec3db5aa6b0c1",
  "slug": "nvda-above-240-on-january-30-2026",
  "description": "This market will resolve to \"Yes\" if the official closing price...",
  "assets_ids": [
    "76043073756653678226373981964075571318267289248134717369284518995922789326425",
    "31690934263385727664202099278545688007799199447969475608906331829650099442770"
  ],
  "outcomes": ["Yes", "No"],
  "winning_asset_id": "76043073756653678226373981964075571318267289248134717369284518995922789326425",
  "winning_outcome": "Yes",
  "event_message": {
    "id": "125819",
    "ticker": "nvda-above-in-january-2026",
    "slug": "nvda-above-in-january-2026",
    "title": "Will NVIDIA (NVDA) close above ___ end of January?",
    "description": "This market will resolve to \"Yes\" if the official closing price..."
  },
  "timestamp": "1766790415550",
  "event_type": "market_resolved"
}
```
