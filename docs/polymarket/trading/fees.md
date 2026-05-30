> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Fees

> Understanding trading fees on Polymarket

Polymarket charges a small taker fee on certain markets. Fees are set by the protocol and applied at match time — you don't include fee information in your orders. These fees fund the [Maker Rebates Program](/market-makers/maker-rebates), which redistributes fees daily to market makers to incentivize deeper liquidity and tighter spreads. Takers can also earn a portion of fees back through the tiered [Taker Rebate Program](/trading/taker-rebates).

**Geopolitical and world events markets are fee-free.** Polymarket does not charge fees or profit from trading activity on these markets. There are also no Polymarket fees to deposit or withdraw USDC (though intermediaries like Coinbase or MoonPay may charge their own fees).

<Note>
  Fees are determined per-market at match time. Markets with fees enabled have
  `feesEnabled` set to `true` on the market object. Query fee parameters for
  any market with `getClobMarketInfo(conditionID)`.
</Note>

***

## Fee Structure

Fees are calculated using the following formula:

```text theme={null}
fee = C × feeRate × p × (1 - p)
```

Where **C** = number of shares traded and **p** = price of the shares.

**Makers are never charged fees.** Only takers pay fees. The fee parameters differ by market category:

| Category        | Taker Fee Rate | Maker Fee Rate | Maker Rebate |
| --------------- | -------------- | -------------- | ------------ |
| Crypto          | 0.07           | 0              | 20%          |
| Sports          | 0.03           | 0              | 25%          |
| Finance         | 0.04           | 0              | 25%          |
| Politics        | 0.04           | 0              | 25%          |
| Economics       | 0.05           | 0              | 25%          |
| Culture         | 0.05           | 0              | 25%          |
| Weather         | 0.05           | 0              | 25%          |
| Other / General | 0.05           | 0              | 25%          |
| Mentions        | 0.04           | 0              | 25%          |
| Tech            | 0.04           | 0              | 25%          |
| Geopolitics     | 0              | 0              | —            |

Taker fees are calculated in USDC and vary based on the share price. The fee amount in USDC is symmetric around 50% probability — a trade at 30¢ incurs the same dollar fee as a trade at 70¢.

<Frame>
  <div className="p-3 bg-white rounded-xl">
    <iframe title="Fee Curves" aria-label="Line chart" id="datawrapper-chart-cY9H4" src="https://datawrapper.dwcdn.net/cY9H4/" scrolling="no" frameborder="0" width={700} style={{ width: "0", minWidth: "100% !important", border: "none" }} height="450" data-external="1" />
  </div>
</Frame>

### Fee Tables (100 Shares)

<Tabs>
  <Tab title="Crypto">
    | Price  | Trade Value | Taker Fee (USDC) |
    | ------ | ----------- | ---------------- |
    | \$0.01 | \$1         | \$0.07           |
    | \$0.05 | \$5         | \$0.33           |
    | \$0.10 | \$10        | \$0.63           |
    | \$0.15 | \$15        | \$0.89           |
    | \$0.20 | \$20        | \$1.12           |
    | \$0.25 | \$25        | \$1.31           |
    | \$0.30 | \$30        | \$1.47           |
    | \$0.35 | \$35        | \$1.59           |
    | \$0.40 | \$40        | \$1.68           |
    | \$0.45 | \$45        | \$1.73           |
    | \$0.50 | \$50        | \$1.75           |
    | \$0.55 | \$55        | \$1.73           |
    | \$0.60 | \$60        | \$1.68           |
    | \$0.65 | \$65        | \$1.59           |
    | \$0.70 | \$70        | \$1.47           |
    | \$0.75 | \$75        | \$1.31           |
    | \$0.80 | \$80        | \$1.12           |
    | \$0.85 | \$85        | \$0.89           |
    | \$0.90 | \$90        | \$0.63           |
    | \$0.95 | \$95        | \$0.33           |
    | \$0.99 | \$99        | \$0.07           |

    The fee in USDC **peaks at 50%** probability (\$1.75) and decreases symmetrically toward both extremes.
  </Tab>

  <Tab title="Sports">
    | Price  | Trade Value | Taker Fee (USDC) |
    | ------ | ----------- | ---------------- |
    | \$0.01 | \$1         | \$0.03           |
    | \$0.05 | \$5         | \$0.14           |
    | \$0.10 | \$10        | \$0.27           |
    | \$0.15 | \$15        | \$0.38           |
    | \$0.20 | \$20        | \$0.48           |
    | \$0.25 | \$25        | \$0.56           |
    | \$0.30 | \$30        | \$0.63           |
    | \$0.35 | \$35        | \$0.68           |
    | \$0.40 | \$40        | \$0.72           |
    | \$0.45 | \$45        | \$0.74           |
    | \$0.50 | \$50        | \$0.75           |
    | \$0.55 | \$55        | \$0.74           |
    | \$0.60 | \$60        | \$0.72           |
    | \$0.65 | \$65        | \$0.68           |
    | \$0.70 | \$70        | \$0.63           |
    | \$0.75 | \$75        | \$0.56           |
    | \$0.80 | \$80        | \$0.48           |
    | \$0.85 | \$85        | \$0.38           |
    | \$0.90 | \$90        | \$0.27           |
    | \$0.95 | \$95        | \$0.14           |
    | \$0.99 | \$99        | \$0.03           |

    The fee in USDC **peaks at 50%** probability (\$0.75) and decreases symmetrically toward both extremes.
  </Tab>

  <Tab title="Finance / Politics / Mentions / Tech">
    | Price  | Trade Value | Taker Fee (USDC) |
    | ------ | ----------- | ---------------- |
    | \$0.01 | \$1         | \$0.04           |
    | \$0.05 | \$5         | \$0.19           |
    | \$0.10 | \$10        | \$0.36           |
    | \$0.15 | \$15        | \$0.51           |
    | \$0.20 | \$20        | \$0.64           |
    | \$0.25 | \$25        | \$0.75           |
    | \$0.30 | \$30        | \$0.84           |
    | \$0.35 | \$35        | \$0.91           |
    | \$0.40 | \$40        | \$0.96           |
    | \$0.45 | \$45        | \$0.99           |
    | \$0.50 | \$50        | \$1.00           |
    | \$0.55 | \$55        | \$0.99           |
    | \$0.60 | \$60        | \$0.96           |
    | \$0.65 | \$65        | \$0.91           |
    | \$0.70 | \$70        | \$0.84           |
    | \$0.75 | \$75        | \$0.75           |
    | \$0.80 | \$80        | \$0.64           |
    | \$0.85 | \$85        | \$0.51           |
    | \$0.90 | \$90        | \$0.36           |
    | \$0.95 | \$95        | \$0.19           |
    | \$0.99 | \$99        | \$0.04           |

    The fee in USDC **peaks at 50%** probability (\$1.00) and decreases symmetrically toward both extremes.
  </Tab>

  <Tab title="Economics / Culture / Weather / Other">
    | Price  | Trade Value | Taker Fee (USDC) |
    | ------ | ----------- | ---------------- |
    | \$0.01 | \$1         | \$0.05           |
    | \$0.05 | \$5         | \$0.24           |
    | \$0.10 | \$10        | \$0.45           |
    | \$0.15 | \$15        | \$0.64           |
    | \$0.20 | \$20        | \$0.80           |
    | \$0.25 | \$25        | \$0.94           |
    | \$0.30 | \$30        | \$1.05           |
    | \$0.35 | \$35        | \$1.14           |
    | \$0.40 | \$40        | \$1.20           |
    | \$0.45 | \$45        | \$1.24           |
    | \$0.50 | \$50        | \$1.25           |
    | \$0.55 | \$55        | \$1.24           |
    | \$0.60 | \$60        | \$1.20           |
    | \$0.65 | \$65        | \$1.14           |
    | \$0.70 | \$70        | \$1.05           |
    | \$0.75 | \$75        | \$0.94           |
    | \$0.80 | \$80        | \$0.80           |
    | \$0.85 | \$85        | \$0.64           |
    | \$0.90 | \$90        | \$0.45           |
    | \$0.95 | \$95        | \$0.24           |
    | \$0.99 | \$99        | \$0.05           |

    The fee in USDC **peaks at 50%** probability (\$1.25) and decreases symmetrically toward both extremes.
  </Tab>
</Tabs>

### Fee Precision

Fees are rounded to 5 decimal places. The smallest fee charged is **0.00001 USDC**. Anything smaller rounds to zero, so very small trades near the extremes may incur no fee at all.

***

## Fee Handling

Fees are calculated and applied at match time by the protocol — you do not need to include fee information in your orders. The SDK handles everything automatically.

To query fee parameters for a specific market, use `getClobMarketInfo(conditionID)`:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const info = await client.getClobMarketInfo(conditionID);
  // info.fd = { r: feeRate, e: exponent, to: takerOnly }
  ```

  ```python Python theme={null}
  info = client.get_clob_market_info(condition_id)
  # info["fd"] = { "r": fee_rate, "e": exponent, "to": taker_only }
  ```
</CodeGroup>

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Maker Rebates Program" icon="coins" href="/market-makers/maker-rebates">
    Learn how taker fees fund daily USDC rebates for liquidity providers.
  </Card>

  <Card title="Place Orders" icon="plus" href="/trading/quickstart">
    Start placing orders on Polymarket.
  </Card>
</CardGroup>
