# Advanced Trade API — REST API Endpoints

> Source: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/rest-api
> Mirrored: 2026-05-25

The Advanced Trade API manages orders, portfolios, products, and fees through `v3` endpoints at `https://api.coinbase.com/api/v3/brokerage/{resource}`.

## Private Endpoints

These require authentication via CDP API keys (see Authentication guide).

| API | Method | Resource | Permission |
|-----|--------|----------|-----------|
| List Accounts | GET | `/accounts` | `view` |
| Get Account | GET | `/accounts/:account_id` | `view` |
| Create Order | POST | `/orders` | `trade` |
| Cancel Orders | POST | `/orders/batch_cancel` | `trade` |
| List Orders | GET | `/orders/historical/batch` | `view` |
| List Fills | GET | `/orders/historical/fills` | `view` |
| Get Order | GET | `/orders/historical/{order_id}` | `view` |
| Preview Orders | POST | `/orders/preview` | `view` |
| Get Best Bid/Ask | GET | `/best_bid_ask` | `view` |
| Get Product Book | GET | `/product_book` | `view` |
| List Products | GET | `/products` | `view` |
| Get Product | GET | `/products/{product_id}` | `view` |
| Get Product Candles | GET | `/products/{product_id}/candles` | `view` |
| Get Market Trades | GET | `/products/{product_id}/ticker` | `view` |
| Get Transactions Summary | GET | `/transaction_summary` | `view` |
| Create Convert Quote | POST | `/convert/quote` | `trade` |
| Commit Convert Trade | POST | `/convert/{trade_id}` | `trade` |
| Get Convert Trade | GET | `/convert/{trade_id}` | `view` |
| List Portfolios | GET | `/portfolios` | `view` |
| Create Portfolio | POST | `/portfolios` | `view` |
| Move Portfolio Funds | POST | `/portfolios` | `transfer` |
| Get Portfolio Breakdown | GET | `/portfolios` | `view` |
| Delete Portfolio | DELETE | `/portfolios` | `trade` |
| Edit Portfolio | PUT | `/portfolios` | `trade` |
| Get Futures Balance Summary | GET | `/cfm/balance_summary` | `view` |
| List Futures Positions | GET | `/cfm.positions` | `view` |
| Get Futures Position | GET | `/cfm/positions/{product_id}` | `view` |
| Schedule Futures Sweep | POST | `/cfm/sweeps/schedule` | `transfer` |
| List Futures Sweeps | GET | `/cfm/sweeps` | `view` |
| Cancel Futures Sweep | DELETE | `/cfm/sweeps` | `transfer` |
| Get Intraday Margin Setting | GET | `/cfm/intraday/margin_setting` | `view` |
| Set Intraday Margin Setting | POST | `/cfm/intraday/margin_setting` | `trade` |
| Get Current Margin Window | GET | `/cfm/intraday/current_margin_window` | `view` |
| Get Perpetuals Portfolio Summary | GET | `/intx/portfolio` | `view` |
| List Perpetuals Positions | GET | `/intx/positions` | `view` |
| Get Perpetuals Position | GET | `/intx/positions` | `view` |
| Get Perpetuals Portfolio Balances | GET | `/intx/balances` | `view` |
| Opt-In Multi Asset Collateral | POST | `/intx/multi_asset_collateral` | `trade` |
| Allocate Portfolio | POST | `/intx/allocate` | `transfer` |
| List Payment Methods | GET | `/payment_methods` | `view` |
| Get Payment Method | GET | `/payment_methods/{payment_method_id}` | `view` |
| Get API Key Permissions | GET | `/key_permissions` | `view` |

## Public Endpoints

No authentication required. "1s cache is enabled for all public endpoints." To access real-time data, use WebSockets, set `cache-control: no-cache` headers, or authenticate.

| API | Method | Resource |
|-----|--------|----------|
| Get Server Time | GET | `/time` |
| Get Public Product Book | GET | `/market/product_book` |
| List Public Products | GET | `/market/products` |
| Get Public Product | GET | `/market/products/{product_id}` |
| Get Public Product Candles | GET | `/market/products/{product_id}/candles` |
| Get Public Market Trades | GET | `/market/products/{product_id}/ticker` |
