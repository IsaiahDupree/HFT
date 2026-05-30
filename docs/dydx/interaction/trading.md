# Trading – dYdX Documentation

> Source: https://docs.dydx.xyz/interaction/trading

Interacting with the dYdX perpetual markets and managing your positions is done by placing orders. Enter `LONG` positions by placing buy orders and `SHORT` positions by placing sell orders.

## Place an order

To place an order, you'll need your wallet ready to sign transactions. Please check the Wallet Setup guide to check how to set up a wallet. In this guide we'll be creating a short-term buy order for the ETH-USD market.

### Get market parameters

To create an order for a specific market (identified by its ticker, or _CLOB pair ID_), we should first fetch the market parameters that allows us to do data conversions associated with that specific market. Other parameters such as the current price can also be fetched this way.

```python
MARKET_ID = 1  # ETH-USD identifier
market = Market(
    (await indexer.markets.get_perpetual_markets(MARKET_ID))["markets"][MARKET_ID]
)
print(market["oraclePrice"])
```

### Creating an order

Every order created has a unique identifier, the **order ID**, composed of:

- **Subaccount ID** — the account address plus the integer identifying the subaccount.
- **Client ID** — a 32-bit integer chosen by the user to identify the order. Two orders can't have the same client ID.
- **Order flags** — short-term (`0`), long-term (`64`), conditional (`32`), or TWAP (`128`).
- **CLOB Pair ID** — the ID of the underlying market.

Set specific client IDs when placing orders so you can retrieve them later from `v4/orders`.

```python
order_id = market.order_id(
    ADDRESS,
    0,  # subaccount number
    random.randint(0, 100000000),
    OrderFlags.SHORT_TERM,
)
```

#### Building the order

Orders can be short-term or long-term. dYdX supports market, limit, stop, and take-profit order types.

- **Type** — Market, Limit, Stop, Take Profit.
- **Side** — BUY or SELL.
- **Size** — decimal quantity traded.
- **Price** — decimal price.
- **Time in Force** — execution option (GTT, IOC, FOK, post-only…).
- **Reduce Only** — if true, can only decrease your position size.
- **Good until Block**:
  - **Short-term** — current block height + `ShortBlockWindow` (currently 20 blocks ≈ 30 s).
  - **Long-term (stateful)** — current block time + `StatefulOrderTimeWindow` (currently 95 days).

```python
good_til_block = await node.latest_block_height() + 10
order = market.order(
    order_id,
    OrderType.LIMIT,
    Order.Side.SIDE_BUY,
    size=0.01,
    price=1000,
    time_in_force=Order.TimeInForce.TIME_IN_FORCE_UNSPECIFIED,
    reduce_only=False,
    good_til_block=good_til_block,
)
```

### Broadcasting an order

```python
place = await node.place_order(wallet, order)
```

## Cancel an order

```python
cancel_tx = await node.cancel_order(wallet, order_id, good_til_block)
```
