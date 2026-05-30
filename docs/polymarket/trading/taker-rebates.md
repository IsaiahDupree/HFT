> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Taker Rebate Program

> Climb the tiers and earn daily pUSD rebates as you trade

<Note>
  The Taker Rebate Program goes live on **Thursday, May 28, 2026**.
</Note>

Polymarket Tiers reward you for trading as a **taker**. The more taker volume you do, the higher your tier, the bigger the rebate you earn back on every trade you make from that point on. Every **taker** trade earns **Weighted Volume (wV)**. Your tier is based on your Weighted Volume over the last 30 days, and rebates are paid every day in pUSD.

There are seven tiers, from **Bronze** to **Obsidian**. Your tier shows on your profile, and the first time you reach a new tier you get a one-time bonus.

***

## How Tiers Work

Your tier is set by how much **Weighted Volume (wV)** you earn over the last 30 days. You earn Weighted Volume on your taker trades. Three things decide how much you earn:

1. How big the trade is.
2. The price you bought at.
3. The category. Some categories are worth more (see the table below).

The formula:

```text theme={null}
wV = Trade Size × (1 − Entry Price) × Category Weight × Bonuses
```

* **Trade Size** is how much you put into the trade (shares × the price you paid), in dollars.
* **(1 − Entry Price)** is the upside per share. A share bought at 40¢ can win 60¢, so its upside is `0.60`.
* **Category Weight** is set per category (see below).
* **Bonuses** are extra multipliers Polymarket may run on certain categories or events.

### Example 1: A Normal Taker Trade

You buy 1,000 shares of a Politics market at 40¢, and the order fills right away (a taker trade).

* Trade Size = 1,000 × $0.40 = **$400\*\*
* Upside per share = 1 − 0.40 = **0.60**
* Category Weight for Politics = **1.3**
* Weighted Volume earned = 400 × 0.60 × 1.3 = **\$312 wV**

### Example 2: Why Price Matters

Two trades, both \$50 in size, both in Crypto (weight 2.3):

* A trade at 50¢ earns: 50 × 0.50 × 2.3 = **\$57.50 wV**
* A trade at 5¢ earns: 50 × 0.95 × 2.3 = **\$109.25 wV**

Both trades count, and your Weighted Volume from every trade adds up over 30 days to set your tier.

***

## Category Weights

| Category                           | Weight                         |
| ---------------------------------- | ------------------------------ |
| Sports                             | 1.0                            |
| Politics, Finance, Mentions, Tech  | 1.3                            |
| Economics, Culture, Weather, Other | 1.7                            |
| Crypto                             | 2.3                            |
| Geopolitics                        | 0 (free to trade, earns no wV) |

<Note>
  Category weights are set by Polymarket and may change over time.
</Note>

***

## Tiers and Rebates

Once your 30-day Weighted Volume passes a tier's threshold, you unlock that tier's rebate. The higher your tier, the bigger your rebate. Your rebate applies to your trades from the moment you reach the tier, going forward.

| Tier | Name     | 30-day wV Needed    | Rebate | Level-Up Bonus |
| :--: | -------- | ------------------- | :----: | :------------: |
|   0  | None     | Under \$2,000       |   0%   |      None      |
|   1  | Bronze   | \$2,000             |   3%   |      \$10      |
|   2  | Silver   | \$20,000            |   8%   |      \$50      |
|   3  | Gold     | \$200,000           |   18%  |      \$250     |
|   4  | Platinum | \$1,000,000         |   32%  |     \$1,500    |
|   5  | Diamond  | \$4,000,000         |   44%  |     \$7,500    |
|   6  | Obsidian | \$10,000,000 and up |   50%  |    \$25,000    |

### Example: Your Rebate Starts When You Reach the Tier

The day you reach **Gold**, the 18% Gold rebate turns on for every trade you make from then on.

If you keep climbing and hit **Diamond**, your rebate moves up to 44%, and again it applies only to your trades going forward.

Your tier updates every day based on your last 30 days of Weighted Volume. Moving up takes effect at the next daily update.

***

## Rebates

* You can watch your rebates add up **live** as you trade, the same way referral earnings work.
* Rebates are **paid every day at midnight UTC** in pUSD, straight to your account.

***

## Level-Up Bonuses

The first time you reach a new tier, you get a one-time bonus in pUSD:

| Tier     | Bonus    |
| -------- | -------- |
| Bronze   | \$10     |
| Silver   | \$50     |
| Gold     | \$250    |
| Platinum | \$1,500  |
| Diamond  | \$7,500  |
| Obsidian | \$25,000 |

For example, the first time you climb from Silver to Gold, you get \$250 added to your account, on top of your normal rebates.

***

## Your Tier on Your Profile

Your tier shows on your Polymarket profile and on the leaderboards. As you climb from Bronze to Obsidian, your badge updates to match your current tier.

***

## Notes

* Only **taker** trades earn Weighted Volume and count toward your tier. Maker trades (resting orders that add liquidity) do not. Makers are rewarded separately through the [Maker Rebates Program](/market-makers/maker-rebates).
* Your rebate applies only to your trades going forward, starting the moment you reach a tier.
* Some markets are free to trade, including Geopolitical and world events markets. These markets earn no Weighted Volume and no rebate.
* Your tier is based on your **last 30 days** of Weighted Volume and is updated every day at midnight UTC.
* Rebates are paid once a day at midnight UTC in pUSD.
* Rebate rates, tier thresholds, category weights, level-up bonuses, and any bonus multipliers are set by Polymarket and can change at any time without notice.
* Polymarket reserves the right, at its sole discretion, to adjust or remove rebates and tier status for activity that breaks our Terms of Service, including but not limited to wash trading, self-matching, or other inauthentic trading.

***

## FAQ

<AccordionGroup>
  <Accordion title="Do maker trades count toward my tier">
    No. Only taker trades earn Weighted Volume and count toward your tier.
    Maker fills are rewarded separately through the
    [Maker Rebates Program](/market-makers/maker-rebates).
  </Accordion>

  <Accordion title="When does my rebate start applying">
    Your rebate applies to trades from the moment you reach a tier, going
    forward. There is no backfill on earlier trades.
  </Accordion>

  <Accordion title="When are rebates paid">
    Rebates are paid once a day at midnight UTC in pUSD, directly to your
    account.
  </Accordion>

  <Accordion title="How often does my tier update">
    Your tier is recalculated daily based on your last 30 days of Weighted
    Volume. Tier changes take effect at the next daily update.
  </Accordion>

  <Accordion title="What happens if I slow down trading">
    Your tier moves down after a short grace period if your 30-day Weighted
    Volume drops below your current tier's threshold.
  </Accordion>

  <Accordion title="Which markets earn Weighted Volume">
    All fee-enabled categories earn Weighted Volume at the weight shown in the
    table above. Geopolitical and world events markets are free to trade and
    earn no Weighted Volume.
  </Accordion>
</AccordionGroup>

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Maker Rebates" icon="hand-holding-dollar" href="/market-makers/maker-rebates">
    Earn daily pUSD rebates by providing liquidity.
  </Card>

  <Card title="Fee Structure" icon="receipt" href="/trading/fees">
    See how taker fees are calculated across market categories.
  </Card>
</CardGroup>
