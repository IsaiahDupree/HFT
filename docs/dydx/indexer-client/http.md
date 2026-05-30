# Indexer HTTP API – dYdX Documentation

> Source: https://docs.dydx.xyz/indexer-client/http

> All examples below use the **testnet** indexer URL
> `https://indexer.v4testnet.dydx.exchange`. The mainnet equivalent is
> `https://indexer.dydx.trade/v4`. Read-only Indexer endpoints are open and
> may be used to mirror market data without authenticating.

## Accounts

### Get Subaccounts
- `GET /v4/addresses/{address}`
- Required: `address` (path).
- Optional: `limit` (query).
- Response: `AddressResponse`.
- Example: `https://indexer.v4testnet.dydx.exchange/v4/addresses/dydx14zzueazeh0hj67cghhf9jypslcf9sh2n5k6art`.

### Get Subaccount
- `GET /v4/addresses/{address}/subaccountNumber/{subaccountNumber}`
- Required: `address`, `subaccountNumber`.
- Response: `SubaccountResponseObject`.

### List Positions
- `GET /v4/perpetualPositions`
- Required: `address`, `subaccountNumber`.
- Optional: `status`, `limit`, `createdBeforeOrAtHeight`, `createdBeforeOrAt`.
- Response: `PerpetualPositionResponseObject`.

### Get Asset Positions
- `GET /v4/assetPositions`
- Required: `address`, `subaccountNumber`.
- Optional: `status`, `limit`, `createdBeforeOrAtHeight`, `createdBeforeOrAt`.
- Response: `AssetPositionResponseObject`.

### Get Transfers
- `GET /v4/transfers`
- Required: `address`, `subaccount_number`.
- Optional: `limit`, `createdBeforeOrAtHeight`, `createdBeforeOrAt`, `page`.
- Response: `TransferResponseObject`.

### Get Transfers Between
- `GET /v4/transfers/between`
- Required: `sourceAddress`, `sourceSubaccountNumber`, `recipientAddress`, `recipientSubaccountNumber`.
- Optional: `createdBeforeOrAtHeight`, `createdBeforeOrAt`.

### List Orders
- `GET /v4/orders`
- Required: `address`, `subaccountNumber`.
- Optional: `limit`, `ticker`, `side`, `status`, `type`, `goodTilBlockBeforeOrAt`, `goodTilBlockTimeBeforeOrAt`, `returnLatestOrders`.
- Response: `OrderResponseObject`.

### Get Order
- `GET /v4/orders/{orderId}`
- Response: `OrderResponseObject`.

### Get Fills
- `GET /v4/fills`
- Required: `address`, `subaccountNumber`.
- Optional: `market`, `marketType`, `limit`, `createdBeforeOrAtHeight`, `createdBeforeOrAt`, `page`.
- Response: `FillResponseObject`.

### Get Historical PnL
- `GET /v4/historical-pnl`
- Required: `address`, `subaccount_number`.
- Optional: `limit`, `createdBeforeOrAtHeight`, `createdBeforeOrAt`, `createdOnOrAfterHeight`, `createdOnOrAfter`, `page`.
- Response: `PnlTicksResponseObject`.

### Get Rewards
- `GET /v4/historicalBlockTradingRewards/{address}`
- Optional: `limit`, `startingBeforeOrAtHeight`, `startingBeforeOrAt`.
- Response: `HistoricalBlockTradingReward`.

### Get Rewards Aggregated
- `GET /v4/historicalTradingRewardAggregations/{address}`
- Required: `period`.
- Optional: `limit`, `startingBeforeOrAt`, `startingBeforeOrAtHeight`.
- Response: `HistoricalTradingRewardAggregation`.

### Parent Subaccount Family
Same endpoints as above but scoped to a parent subaccount and its children:
- `GET /v4/addresses/{address}/parentSubaccountNumber/{number}` — `ParentSubaccountResponseObject`.
- `GET /v4/perpetualPositions/parentSubaccountNumber`.
- `GET /v4/assetPositions/parentSubaccountNumber`.
- `GET /v4/transfers/parentSubaccountNumber`.
- `GET /v4/orders/parentSubaccountNumber`.
- `GET /v4/fills/parentSubaccountNumber`.
- `GET /v4/historical-pnl/parentSubaccountNumber`.

### Get Funding Payments
- `GET /v4/fundingPayments` — required `address`, `subaccountNumber`; optional `limit`, `ticker`, `afterOrAt`, `page`. Response: `FundingPaymentsResponseObject`.
- `GET /v4/fundingPayments/parentSubaccount` — same shape scoped to parent.

## Markets

### Get Perpetual Markets
- `GET /v4/perpetualMarkets`
- Optional: `market`, `limit`.
- Response: `PerpetualMarketMap`.

### Get Perpetual Market Orderbook
- `GET /v4/orderbooks/perpetualMarket/{market}`
- Response: `OrderBookResponseObject`.

### Get Trades
- `GET /v4/trades/perpetualMarket/{market}`
- Optional: `limit`, `startingBeforeOrAtHeight`.
- Response: `TradeResponseObject`.

### Get Candles
- `GET /v4/candles/perpetualMarkets/{market}`
- Required: `resolution` (e.g. `1DAY`, `1HOUR`, `1MIN`).
- Optional: `limit`, `fromISO`, `toISO`.
- Response: `CandleResponseObject`.

### Get Historical Funding
- `GET /v4/historicalFunding/{market}`
- Optional: `limit`, `effectiveBeforeOrAt`, `effectiveBeforeOrAtHeight`.
- Response: `HistoricalFundingResponseObject`.

### Get Sparklines
- `GET /v4/sparklines`
- Required: `timePeriod` (`ONE_DAY`, `SEVEN_DAYS`).
- Response: `SparklineResponseObject`.

## Utility

### Get Time
- `GET /v4/time` → `TimeResponse`.

### Get Height
- `GET /v4/height` → `HeightResponse`.

### Get Screen
- `GET /v4/screen?address={address}` → `ComplianceResponse`.

### Get Compliance Screen
- `GET /v4/compliance/screen/{address}` → `ComplianceV2Response`. Used to check if an address is restricted.

## Vaults

### Get MegaVault Historical PnL
- `GET /v4/vault/v1/megavault/historicalPnl?resolution={DAY|HOUR|…}` → `PnlTicksResponseObject`.

### Get Vaults Historical PnL
- `GET /v4/vault/v1/vaults/historicalPnl?resolution={…}` → `VaultHistoricalPnl`.

### Get MegaVault Positions
- `GET /v4/vault/v1/megavault/positions` → `VaultPosition`.
