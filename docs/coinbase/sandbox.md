# Advanced Trade API — Sandbox

> Source: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/sandbox
> Mirrored: 2026-05-25

## Overview

The Advanced Trade API provides a static sandbox environment for testing. Key capabilities include:

- **No authentication required** for sandbox API requests
- **Identical response formatting** to production endpoints
- **Pre-defined, static responses** for all calls
- **Custom header support** (`X-Sandbox:`) to trigger specific response variations

## Sandbox Base URL

```
https://api-sandbox.coinbase.com/api/v3/brokerage/{resource}
```

**Note:** Currently only Accounts and Orders endpoints are available in the sandbox environment with mocked responses matching production formats.

## Available Endpoints

### Core Endpoints

| Endpoint | Method | Resource |
|----------|--------|----------|
| List Accounts | GET | `/accounts` |
| Get Account | GET | `/accounts/{account_id}` |
| Create Order | POST | `/orders` |
| Cancel Orders | POST | `/orders/batch_cancel` |
| Edit Order | POST | `/orders/edit` |
| Edit Order Preview | POST | `/orders/edit_preview` |
| List Orders | GET | `/orders/historical/batch` |
| List Fills | GET | `/orders/historical/fills` |
| Get Order | GET | `/orders/historical/{order_id}` |
| Preview Order | POST | `/orders/preview` |
| Close Position | POST | `/orders/close_position` |

### Portfolio & Perpetuals Endpoints

| Endpoint | Method | Resource |
|----------|--------|----------|
| List Portfolios | GET | `/portfolios` |
| Allocate Portfolio | POST | `intx/allocate` |
| Get Perpetuals Portfolio Summary | GET | `/intx/portfolio/{portfolio_uuid}` |
| List Perpetuals Positions | GET | `/intx/positions/{portfolio_uuid}` |
| Get Perpetuals Position | GET | `/intx/positions/{portfolio_uuid}/{symbol}` |
| Get Portfolios Balances | GET | `/intx/balances/{portfolio_uuid}` |
| Opt In or Out of Multi Asset Collateral | POST | `/intx/multi_asset_collateral` |

## Request Parameters

Common parameters include:

- `account_id` — from List Accounts response
- `order_id` — from List Orders response
- `order_status` — CANCELLED or OPEN values
- `portfolio_type` — DEFAULT, CONSUMER, or INTX values
- `portfolio_uuid` — from List Portfolios response
- `symbol` — format example: ETH-PERP-INTX

## Error Response Headers

Trigger specific error scenarios using the `X-Sandbox:` header:

| Endpoint | Error | Header Value |
|----------|-------|--------------|
| Create Order | INSUFFICIENT_FUND | `PostOrder_insufficient_fund` |
| Cancel Orders | UNKNOWN_CANCEL_ORDER | `CancelOrders_failure` |
| Edit Order | ORDER_NOT_FOUND | `EditOrder_failure` |
| Edit Order Preview | ORDER_NOT_FOUND | `PreviewEditOrder_failure` |
| Preview Order | PREVIEW_INSUFFICIENT_FUND | `PreviewOrder_insufficient_fund` |

---

**Related:** [REST API Overview](/coinbase-app/advanced-trade-apis/rest-api)
