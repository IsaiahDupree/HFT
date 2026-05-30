> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Clients & SDKs

> Official open-source libraries for interacting with Polymarket

Polymarket provides official open-source clients in TypeScript, Python, and Rust. All three support the full CLOB API including market data, order management, and authentication.

## Installation

<CodeGroup>
  ```bash TypeScript theme={null}
  npm install @polymarket/clob-client-v2 viem
  ```

  ```bash Python theme={null}
  pip install py-clob-client-v2
  ```

  ```bash Rust theme={null}
  cargo add polymarket_client_sdk_v2 --features clob
  ```
</CodeGroup>

## Quick Example

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { ClobClient } from "@polymarket/clob-client-v2";

  const client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: 137,
    signer,
    creds: apiCreds,
  });

  const markets = await client.getMarkets();
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import ClobClient

  client = ClobClient(
      "https://clob.polymarket.com",
      key=private_key,
      chain_id=137,
      creds=api_creds,
  )

  markets = client.get_markets()
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::{Client, Config};

  let client = Client::new("https://clob.polymarket.com", Config::default())?
      .authentication_builder(&signer)
      .authenticate()
      .await?;

  let markets = client.markets(None).await?;
  ```
</CodeGroup>

## Source Code

| Language   | Package                      | Repository                                                                                 |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| TypeScript | `@polymarket/clob-client-v2` | [github.com/Polymarket/clob-client-v2](https://github.com/Polymarket/clob-client-v2)       |
| Python     | `py-clob-client-v2`          | [github.com/Polymarket/py-clob-client-v2](https://github.com/Polymarket/py-clob-client-v2) |
| Rust       | `polymarket_client_sdk_v2`   | [github.com/Polymarket/rs-clob-client-v2](https://github.com/Polymarket/rs-clob-client-v2) |

Each repository includes working examples in the `/examples` directory.

## Relayer SDK

For [gasless transactions](/trading/gasless), the relayer client handles deposit
wallet creation and signed wallet batches for new API users. Existing Safe and
Proxy wallet flows remain supported.

| Language   | Package                              | Repository                                                                                                 |
| ---------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| TypeScript | `@polymarket/builder-relayer-client` | [github.com/Polymarket/builder-relayer-client](https://github.com/Polymarket/builder-relayer-client)       |
| Python     | `py-builder-relayer-client`          | [github.com/Polymarket/py-builder-relayer-client](https://github.com/Polymarket/py-builder-relayer-client) |

## Next Steps

<CardGroup cols={2}>
  <Card title="Quickstart" icon="rocket" href="/quickstart">
    Set up your client and place your first order.
  </Card>

  <Card title="Authentication" icon="lock" href="/api-reference/authentication">
    Understand L1/L2 auth and API credentials.
  </Card>
</CardGroup>
