> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Builder Code

> Your builder code for order attribution

Your **Builder Code** is a `bytes32` identifier that attributes orders routed through your application to your builder profile. Attach it to every order you submit — no additional authentication is required.

## Accessing Your Builder Profile

<Steps>
  <Step title="Direct Link">
    Go to
    [polymarket.com/settings?tab=builder](https://polymarket.com/settings?tab=builder)
  </Step>

  <Step title="From Menu">Click your profile image → Select "Builders"</Step>
</Steps>

## Getting Your Builder Code

In the **Builder Code** section of your profile, copy the `bytes32` value. It looks like:

```
0x0000000000000000000000000000000000000000000000000000000000000001
```

Store it in your environment variables or a secrets manager.

<Note>
  Builder codes are public identifiers — they appear onchain in the `builder`
  field of every order you attribute. Only you control which orders include
  your code, so keep it scoped to the apps you own.
</Note>

## Profile Settings

Your builder profile includes customizable settings:

| Setting             | Description                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| **Profile Picture** | Displayed on the [Builder Leaderboard](https://builders.polymarket.com) |
| **Builder Name**    | Public name shown on the leaderboard                                    |
| **Builder Address** | Your unique builder identifier (read-only)                              |
| **Builder Code**    | The `bytes32` code you attach to orders                                 |
| **Current Tier**    | Your rate limit tier: Unverified, Verified, or Partner                  |

## Environment Variables

Store your builder code as an environment variable:

<Tabs>
  <Tab title="Bash">
    ```bash .env theme={null}
    POLY_BUILDER_CODE=0x0000000000000000000000000000000000000000000000000000000000000001
    ```
  </Tab>

  <Tab title="TypeScript">
    ```typescript theme={null}
    const builderCode = process.env.POLY_BUILDER_CODE!;
    ```
  </Tab>

  <Tab title="Python">
    ```python theme={null}
    import os

    builder_code = os.environ["POLY_BUILDER_CODE"]
    ```
  </Tab>
</Tabs>

## Using Your Builder Code

Pass `builderCode` on every order to attribute it to your builder profile:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const response = await client.createAndPostOrder(
    {
      tokenID: "0x...",
      price: 0.55,
      size: 100,
      side: Side.BUY,
      builderCode: process.env.POLY_BUILDER_CODE!,
    },
    { tickSize: "0.01", negRisk: false },
  );
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import OrderArgs, PartialCreateOrderOptions
  from py_clob_client_v2.order_builder.constants import BUY

  response = client.create_and_post_order(
      OrderArgs(
          token_id="0x...",
          price=0.55,
          size=100,
          side=BUY,
          builder_code=os.environ["POLY_BUILDER_CODE"],
      ),
      options=PartialCreateOrderOptions(tick_size="0.01", neg_risk=False),
  )
  ```
</CodeGroup>

See [Order Attribution](/trading/orders/attribution) for full details.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Rate limit exceeded">
    **Cause:** You've exceeded your tier's daily transaction limit.

    **Solution:**

    * Wait until the daily limit resets
    * [Contact Polymarket](/builders/tiers#contact) to upgrade your tier
  </Accordion>

  <Accordion title="Builder code not found">
    **Cause:** You haven't created a builder profile yet.

    **Solution:** Go to
    [polymarket.com/settings?tab=builder](https://polymarket.com/settings?tab=builder)
    and set up your profile to get a builder code.
  </Accordion>
</AccordionGroup>

## Next Steps

<CardGroup cols={2}>
  <Card title="Attribute Orders" icon="tag" href="/trading/orders/attribution">
    Attach your builder code to orders for volume credit.
  </Card>

  <Card title="Understand Tiers" icon="layer-group" href="/builders/tiers">
    Learn about rate limits and how to upgrade.
  </Card>
</CardGroup>
