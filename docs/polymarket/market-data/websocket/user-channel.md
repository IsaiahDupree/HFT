> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# User Channel

> Authenticated order and trade updates

Authenticated channel for updates related to your orders and trades, filtered by API key.

## Endpoint

```
wss://ws-subscriptions-clob.polymarket.com/ws/user
```

## Authentication

Include API credentials in your subscription message:

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

<Warning>
  Never expose your API credentials in client-side code. Use the user channel
  only from server environments.
</Warning>

## Message Types

Each message includes a `type` field identifying the event.

### trade

Emitted when:

* A market order is matched (`MATCHED`)
* A limit order for the user is included in a trade (`MATCHED`)
* Subsequent status changes for the trade (`MINED`, `CONFIRMED`, `RETRYING`, `FAILED`)

```json theme={null}
{
  "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
  "event_type": "trade",
  "id": "28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e",
  "last_update": "1672290701",
  "maker_orders": [
    {
      "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
      "matched_amount": "10",
      "order_id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
      "outcome": "YES",
      "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
      "price": "0.57"
    }
  ],
  "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
  "matchtime": "1672290701",
  "outcome": "YES",
  "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
  "price": "0.57",
  "side": "BUY",
  "size": "10",
  "status": "MATCHED",
  "taker_order_id": "0x06bc63e346ed4ceddce9efd6b3af37c8f8f440c92fe7da6b2d0f9e4ccbc50c42",
  "timestamp": "1672290701",
  "trade_owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
  "type": "TRADE"
}
```

#### Trade Statuses

```
MATCHED → MINED → CONFIRMED
    ↓        ↑
RETRYING ───┘
    ↓
  FAILED
```

| Status      | Terminal | Description                                                                                     |
| ----------- | -------- | ----------------------------------------------------------------------------------------------- |
| `MATCHED`   | No       | Trade has been matched and sent to the executor service by the operator                         |
| `MINED`     | No       | Trade observed to be mined into the chain, no finality threshold established                    |
| `CONFIRMED` | Yes      | Trade has achieved strong probabilistic finality and was successful                             |
| `RETRYING`  | No       | Trade transaction has failed (revert or reorg) and is being retried/resubmitted by the operator |
| `FAILED`    | Yes      | Trade has failed and is not being retried                                                       |

### order

Emitted when:

* An order is placed (`PLACEMENT`)
* An order is updated — some of it is matched (`UPDATE`)
* An order is cancelled (`CANCELLATION`)

```json theme={null}
{
  "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
  "associate_trades": null,
  "event_type": "order",
  "id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
  "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
  "order_owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
  "original_size": "10",
  "outcome": "YES",
  "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
  "price": "0.57",
  "side": "SELL",
  "size_matched": "0",
  "timestamp": "1672290687",
  "type": "PLACEMENT"
}
```
