> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Matching Engine Restarts

> Maintenance windows, restart handling, and post-restart post-only mode

The Polymarket matching engine undergoes restarts for maintenance and upgrades. This page covers how to detect and handle downtime, the post-restart post-only period, and where to get advance notice of changes.

***

## Announcements

Matching engine changes — planned restarts, updates, and maintenance windows — are announced **before they happen** in these channels:

<CardGroup cols={2}>
  <Card title="Telegram" icon="telegram" href="https://t.me/polytradingapis">
    Join the Polymarket Trading APIs channel for real-time announcements.
  </Card>

  <Card title="Discord" icon="discord" href="https://discord.com/channels/710897173927297116/1473553279421255803">
    Join the #trading-apis channel in the Polymarket Discord.
  </Card>
</CardGroup>

Announcements typically include **what's changing**, the **scheduled time**, and the **expected downtime window**. The goal is \~2 days notice when possible.

***

## Handling HTTP 425

During a restart window, the CLOB API returns **HTTP 425 (Too Early)** on all order-related endpoints. This tells your client that the matching engine is restarting and will be back shortly.

After every restart, the matching engine enters **post-only mode for 2 minutes**. During this period, cancels are accepted and new orders must use `postOnly: true`; non-post-only orders are rejected.

### Recommended Retry Strategy

<Steps>
  <Step title="Detect 425">
    When you receive an HTTP `425` response, the matching engine is restarting. Do not treat this as a permanent error.
  </Step>

  <Step title="Back off and retry">
    Wait and retry with exponential backoff. Start at 1–2 seconds and increase the interval on each retry.
  </Step>

  <Step title="Handle post-only mode">
    Once `425` responses stop, the engine is back online but remains in post-only mode for 2 minutes. During that period, only cancels and orders with `postOnly: true` are accepted.
  </Step>
</Steps>

### Code Examples

Check the HTTP status code on responses to the CLOB API and retry on `425`:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const CLOB_HOST = "https://clob.polymarket.com";

  async function postWithRetry(path: string, body: any, headers: Record<string, string>) {
    const MAX_RETRIES = 10;
    let delay = 1000;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const response = await fetch(`${CLOB_HOST}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });

      if (response.status === 425) {
        console.log(`Engine restarting, retrying in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30000);
        continue;
      }

      return response;
    }
    throw new Error("Engine restart exceeded maximum retry attempts");
  }
  ```

  ```python Python theme={null}
  import time
  import requests

  CLOB_HOST = "https://clob.polymarket.com"

  def post_with_retry(path, body, headers, max_retries=10):
      delay = 1

      for attempt in range(max_retries):
          response = requests.post(
              f"{CLOB_HOST}{path}",
              json=body,
              headers=headers,
          )

          if response.status_code == 425:
              print(f"Engine restarting, retrying in {delay}s...")
              time.sleep(delay)
              delay = min(delay * 2, 30)
              continue

          return response

      raise Exception("Engine restart exceeded maximum retry attempts")
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::error::{Kind, StatusCode};

  // Wrap SDK calls with retry logic for HTTP 425.
  // Re-build and re-sign the order each attempt since SignedOrder is consumed.
  let mut delay = std::time::Duration::from_secs(1);

  for _ in 0..10 {
      let order = client.limit_order()
          .token_id(token_id).price(price).size(size).side(side)
          .build().await?;
      let signed = client.sign(&signer, order).await?;

      match client.post_order(signed).await {
          Ok(response) => return Ok(response),
          Err(err) if err.kind() == Kind::Status => {
              if let Some(status) = err.downcast_ref::<polymarket_client_sdk_v2::error::Status>() {
                  if status.status_code == StatusCode::from_u16(425).unwrap() {
                      eprintln!("Engine restarting, retrying in {delay:?}...");
                      tokio::time::sleep(delay).await;
                      delay = (delay * 2).min(std::time::Duration::from_secs(30));
                      continue;
                  }
              }
              return Err(err);
          }
          Err(err) => return Err(err),
      }
  }
  ```
</CodeGroup>

***

## Restricted Trading Modes

During restricted trading modes, order placement behavior changes for `POST /order` and `POST /orders`. Cancel endpoints continue to accept cancels unless trading is fully disabled.

### Cancel-Only Mode

In cancel-only mode, new orders are rejected, but cancel requests are still accepted.

`POST /order` and `POST /orders` return `503`:

```json theme={null}
{
  "error": "Trading is currently cancel-only. New orders are not accepted, but cancels are allowed."
}
```

### Post-Only Mode

After every restart, the matching engine enters post-only mode for **2 minutes**. Cancel requests are accepted and new orders must use `postOnly: true`. Non-post-only orders are rejected.

`POST /order` returns `503` with a retry delay in both the response body and the `Retry-After` HTTP header:

```json theme={null}
{
  "error": "post-only mode: only post-only orders and cancels are allowed",
  "code": "post_only_mode",
  "retry_after_seconds": 79
}
```

`POST /orders` returns per-order errors for non-post-only orders in the batch:

```json theme={null}
[
  {
    "errorMsg": "post-only mode: only post-only orders and cancels are allowed",
    "orderID": "",
    "takingAmount": "",
    "makingAmount": "",
    "status": "",
    "success": true
  },
  {
    "errorMsg": "post-only mode: only post-only orders and cancels are allowed",
    "orderID": "",
    "takingAmount": "",
    "makingAmount": "",
    "status": "",
    "success": true
  }
]
```

When you receive either restricted-mode response, do not retry the same non-post-only order unchanged. Cancel existing orders, retry after the indicated delay when one is provided, or resubmit eligible maker orders with `postOnly: true`.

***

## Best Practices

* **Subscribe to announcement channels** — get notified before restarts happen so you can prepare
* **Handle 425 gracefully** — treat it as a temporary condition, not an error; your retry logic should resume automatically
* **Handle 503 mode responses on order placement** — cancel-only and post-only responses require changing order flow, not blind retrying
* **Avoid aggressive retries** — the engine needs time to reload orderbooks; rapid-fire retries won't speed things up and may hit rate limits once the engine is back
* **Log restart events** — track when your client encounters 425s to correlate with announced maintenance windows
