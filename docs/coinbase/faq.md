# Advanced Trade API — FAQ

> Source: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/faq
> Mirrored: 2026-05-25

## What is Advanced Trade API?

The Advanced Trade REST API supports trading and order management, plus a WebSocket protocol for real-time market data.

## What is Advanced Trade on Coinbase?

Advanced Trade on Coinbase offers several key features:

- Real-time order books and live trade history with a streamlined order process
- Access to the same markets and liquidity as Coinbase Pro, with identical volume-based fee structure
- TradingView-powered charts with technical indicators (EMA, MA, MACD, RSI, Bollinger Bands) and drawing tools
- Integration with Coinbase staking, Borrow, Wallet, and Coinbase Card through a unified platform balance
- DeFi Rewards program offering up to 5% APY on select cryptocurrencies (USDC, ETH2, DAI, ALGO, ATOM, XTZ)
- Enhanced security features including 2FA, biometrics, FDIC-insured USD balances up to $250k, YubiKey support, Coinbase Vault, and address whitelisting
- Available on Coinbase.com and the Coinbase mobile app

## What has happened to Coinbase Pro?

"Coinbase Pro has been disabled for use and all customers have been migrated as of December 1, 2023." The deprecation was accelerated from the original 2024 timeline. Unauthenticated Pro APIs remain accessible for existing customers, and Exchange APIs (FIX, REST, WebSocket) continue supporting institutional clients.

## Can I use my existing Coinbase Pro API keys to access Advanced Trade?

No. Existing Pro API keys cannot be used with Advanced Trade.

## How do I migrate from Pro APIs to Advanced Trade API?

Developers must regenerate API keys and update their code implementations accordingly. Those using third-party trading bots need to regenerate keys and reconfigure them within their bot platform.

## What are the differences between Advanced Trade and Coinbase Exchange?

### Advanced Trade

- **Target Users**: Individual traders
- **API Access**: REST API for trading/order management plus WebSocket for real-time data
- **Features**: Real-time order books, live trade history, TradingView charts, staking, borrowing, Coinbase Card integration
- **Security**: 2FA, biometrics, FDIC-insured USD balances up to $250k, YubiKey, Coinbase Vault, address whitelisting
- **API Keys**: CDP API Keys from Coinbase Developer Platform
- **Availability**: Coinbase.com and mobile app

### Coinbase Exchange

- **Target Users**: Institutional clients and high-volume traders
- **API Access**: FIX, REST, and WebSocket APIs for institutional use
- **Features**: Advanced order types and market data tailored for institutional trading
- **Security**: Institutional-grade security protocols
- **API Keys**: Requires Coinbase Exchange Account
- **Availability**: Designed for high-volume institutional trading integration

## Can I continue to access the FIX API?

"Due to low use among retail users, the FIX API is not supported on Coinbase Advanced Trade."

## Why am I receiving an UNKNOWN_FAILURE_REASON when placing an order?

When an order response shows `"success": true` alongside `"failure_reason": "UNKNOWN_FAILURE_REASON"`, your order was successfully processed. The failure reason field should be disregarded when success is confirmed.

Example successful response:
```json
{
  "success": true,
  "failure_reason": "UNKNOWN_FAILURE_REASON",
  "order_id": "62475e97-7485-45eb-a5ac-594805fa2748",
  "success_response": {
    "order_id": "62475e97-7485-45eb-a5ac-594805fa2748",
    "product_id": "BTC-USD",
    "side": "BUY",
    "client_order_id": "12345678"
  },
  "order_configuration": {
    "market_market_ioc": {
      "quote_size": "1.0"
    }
  }
}
```

## Why am I receiving an UNKNOWN value within the warning key in a response?

"`UNKNOWN` is the default response for the `warning` key within responses and can therefore be seen as **no warning** being returned."

## Why am I receiving PREVIEW_INVALID_BASE_SIZE_TOO_SMALL on my perpetual order?

All perpetual orders require a minimum notional value of 10 USDC.

## What is the difference between my Advanced Trade accounts and my Coinbase App accounts?

Both account types share the same underlying balances. However, Advanced Trade accounts include access to futures, perpetuals, and margin accounts, whereas Coinbase App accounts do not.

## Why am I receiving "Unsupported account in this conversion" using the Advanced Trade Converts Endpoints?

The converts endpoints currently support only these conversion pairs: USD ↔ USDC, USD ↔ PYUSD, and EUR ↔ EURC.
