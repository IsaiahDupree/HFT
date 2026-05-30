> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Deposit Status

> Track the progress of your bridge deposits

After sending assets to your deposit address, use the status endpoint to track progress until funds arrive in your Polymarket wallet.

## Check Status

Query the status of all deposits to a specific deposit address.

```bash theme={null}
curl https://bridge.polymarket.com/status/0x23566f8b2E82aDfCf01846E54899d110e97AC053
```

<Note>
  Use the deposit address from the `/deposit` response (EVM, SVM, or BTC), not
  your Polymarket wallet address.
</Note>

## Transaction Statuses

Each deposit progresses through these statuses:

| Status                | Terminal | Description                                        |
| --------------------- | -------- | -------------------------------------------------- |
| `DEPOSIT_DETECTED`    | No       | Funds detected on source chain, not yet processing |
| `PROCESSING`          | No       | Transaction is being routed and swapped            |
| `ORIGIN_TX_CONFIRMED` | No       | Source chain transaction confirmed                 |
| `SUBMITTED`           | No       | Submitted to destination chain (Polygon)           |
| `COMPLETED`           | Yes      | Funds arrived — transaction successful             |
| `FAILED`              | Yes      | Transaction encountered an error                   |

<Note>
  If a bridge transaction fails, remains stuck, or funds are held due to a
  compliance check, direct users to
  [our Bridge API provider's support](https://intercom.help/funxyz/en/articles/10732578-contact-us)
  to resolve the issue.
</Note>

## Response

A response with active deposits:

```json theme={null}
{
  "transactions": [
    {
      "fromChainId": "1",
      "fromTokenAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "fromAmountBaseUnit": "1000000000",
      "toChainId": "137",
      "toTokenAddress": "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
      "status": "COMPLETED",
      "txHash": "0xabc123...",
      "createdTimeMs": 1697875200000
    }
  ]
}
```

| Field                | Description                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `fromChainId`        | Source chain ID                                                                           |
| `fromTokenAddress`   | Token sent                                                                                |
| `fromAmountBaseUnit` | Amount in base units                                                                      |
| `toChainId`          | Destination chain (137 for Polygon)                                                       |
| `toTokenAddress`     | Token received                                                                            |
| `status`             | Current status (see table above)                                                          |
| `txHash`             | Destination transaction hash (only when `COMPLETED`)                                      |
| `createdTimeMs`      | Unix timestamp in milliseconds (only present once the transaction has started processing) |

## Empty Response

An empty `transactions` array means no deposits have been detected at this address yet:

```json theme={null}
{
  "transactions": []
}
```

<Tip>
  Transactions typically complete within a few minutes, but may take longer
  depending on network conditions. Poll every 10-30 seconds until `COMPLETED` or
  `FAILED`.
</Tip>

## Next Steps

<CardGroup cols={2}>
  <Card title="Create Deposit" icon="arrow-right-to-bracket" href="/trading/bridge/deposit">
    Generate deposit addresses for your wallet.
  </Card>

  <Card title="Supported Assets" icon="coins" href="/trading/bridge/supported-assets">
    Check supported chains and minimum amounts.
  </Card>
</CardGroup>
