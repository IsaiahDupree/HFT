> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Deposit

> Bridge assets from any supported chain to fund your Polymarket account

Polymarket uses **pUSD** (Polymarket USD) on Polygon as collateral for all trading. The Bridge API lets you deposit assets from Ethereum, Solana, Bitcoin, and other chains—they're automatically converted to pUSD on Polygon.

## How It Works

1. Request deposit addresses for your Polymarket wallet
2. Send assets to the appropriate address for your source chain
3. Assets are bridged and swapped to pUSD automatically
4. pUSD is credited to your wallet for trading

## Create Deposit Addresses

Generate unique deposit addresses linked to your Polymarket wallet. See the [Bridge API Reference](/api-reference/introduction) for full request and response schemas.

```bash theme={null}
curl -X POST https://bridge.polymarket.com/deposit \
  -H "Content-Type: application/json" \
  -d '{"address": "0x56687bf447db6ffa42ffe2204a05edaa20f55839"}'
```

### Address Types

| Address | Use For                                                  |
| ------- | -------------------------------------------------------- |
| `evm`   | Ethereum, Arbitrum, Base, Optimism, and other EVM chains |
| `svm`   | Solana                                                   |
| `btc`   | Bitcoin                                                  |
| `tvm`   | Tron                                                     |

<Warning>
  Each address is unique to your wallet. Only send assets from supported chains
  to the correct address type.
</Warning>

## Deposit Flow

<Steps>
  <Step title="Get Your Deposit Address">
    Call `POST /deposit` with your Polymarket wallet address to get deposit
    addresses.
  </Step>

  <Step title="Check Supported Assets">
    Verify your token is supported and meets the minimum deposit amount via
    `/supported-assets`.
  </Step>

  <Step title="Send Assets">
    Transfer tokens to the appropriate deposit address from your source chain.
  </Step>

  <Step title="Track Status">
    Monitor your deposit progress using `/status/{address}`.
  </Step>
</Steps>

## USDC vs pUSD

You can deposit either USDC (native) or USDC.e (bridged) as the source asset to your Polymarket wallet. Either way, the incoming USDC or USDC.e is wrapped into pUSD via the Collateral Onramp, and pUSD is what you hold and trade with on Polymarket.

## Large Deposits

For deposits over \$50,000 originating from a chain other than Polygon, we recommend using a third-party bridge to minimize slippage:

* [DeBridge](https://app.debridge.finance/)
* [Across](https://app.across.to/bridge)
* [Portal](https://portalbridge.com/)

Bridge directly to your Polymarket USDC (Polygon) deposit address. Polymarket is not affiliated with or responsible for any third-party bridge.

## Minimum Deposits

Each asset has a minimum deposit amount. Deposits below the minimum will not be processed. Check `/supported-assets` for current minimums.

## Deposit Recovery

If you deposited the wrong token, use this tool to recover your funds:

[recovery.polymarket.com](https://recovery.polymarket.com/)

<Warning>
  Sending unsupported tokens may cause **irrecoverable loss**. Always verify
  your token is listed in [Supported Assets](/trading/bridge/supported-assets)
  before depositing.
</Warning>

## Next Steps

<CardGroup cols={2}>
  <Card title="Supported Assets" icon="coins" href="/trading/bridge/supported-assets">
    See all supported chains and tokens with minimum amounts.
  </Card>

  <Card title="Check Status" icon="clock" href="/trading/bridge/status">
    Track your deposit progress through completion.
  </Card>
</CardGroup>
