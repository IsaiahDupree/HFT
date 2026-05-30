> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Overview

> Trading on the Polymarket CLOB

Polymarket's CLOB (Central Limit Order Book) is a hybrid-decentralized trading system — offchain order matching with onchain settlement via the [Exchange contract](https://github.com/Polymarket/ctf-exchange/tree/main/src) ([audited by Chainsecurity](https://github.com/Polymarket/ctf-exchange/blob/main/audit/ChainSecurity_Polymarket_Exchange_audit.pdf)). All trading is non-custodial. Orders are [EIP-712](https://eips.ethereum.org/EIPS/eip-712) signed messages, and matched trades settle atomically on Polygon. The operator cannot set prices or execute unauthorized trades.

We recommend using the open-source SDK clients, which handle order signing, authentication, and submission:

<CardGroup cols={3}>
  <Card title="TypeScript Client" icon="github" href="https://github.com/Polymarket/clob-client-v2">
    <p className="font-mono text-[0.8rem]">
      npm install @polymarket/clob-client-v2 viem
    </p>
  </Card>

  <Card title="Python Client" icon="github" href="https://github.com/Polymarket/py-clob-client-v2">
    <p className="font-mono text-[0.8rem]">pip install py-clob-client-v2</p>
  </Card>

  <Card title="Rust Client" icon="github" href="https://github.com/Polymarket/rs-clob-client-v2">
    <p className="font-mono text-[0.8rem]">
      cargo add polymarket\_client\_sdk\_v2 --features clob
    </p>
  </Card>
</CardGroup>

<Info>
  You can also use the REST API directly, but you'll need to manage [EIP-712
  order
  signing](https://github.com/Polymarket/clob-client-v2/blob/main/src/signing/eip712.ts)
  and [HMAC authentication
  headers](https://github.com/Polymarket/clob-client-v2/blob/main/src/signing/hmac.ts)
  yourself. See [REST API Headers](#rest-api-headers) below.
</Info>

***

## Authentication

The CLOB uses two levels of authentication:

| Level  | Method                          | Purpose                                   |
| ------ | ------------------------------- | ----------------------------------------- |
| **L1** | EIP-712 signature (private key) | Create or derive API credentials          |
| **L2** | HMAC-SHA256 (API credentials)   | Place orders, cancel orders, query trades |

You use your private key once to derive **L2 credentials** (API key, secret, passphrase), which authenticate all subsequent trading requests.

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { ClobClient } from "@polymarket/clob-client-v2";
  import { createWalletClient, http } from "viem";
  import { privateKeyToAccount } from "viem/accounts";

  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const signer = createWalletClient({ account, transport: http() });

  // Derive L2 API credentials
  const tempClient = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: 137,
    signer,
  });
  const apiCreds = await tempClient.createOrDeriveApiKey();
  ```

  ```python Python theme={null}
  from py_clob_client_v2 import ClobClient
  import os

  private_key = os.getenv("PRIVATE_KEY")

  # Derive L2 API credentials
  temp_client = ClobClient("https://clob.polymarket.com", key=private_key, chain_id=137)
  api_creds = temp_client.create_or_derive_api_key()
  ```

  ```rust Rust theme={null}
  use std::str::FromStr;
  use polymarket_client_sdk_v2::POLYGON;
  use polymarket_client_sdk_v2::auth::{LocalSigner, Signer};
  use polymarket_client_sdk_v2::clob::{Client, Config};

  let private_key = std::env::var("POLYMARKET_PRIVATE_KEY")?;
  let signer = LocalSigner::from_str(&private_key)?
      .with_chain_id(Some(POLYGON));

  // Derive L2 API credentials and initialize client in one step
  let client = Client::new("https://clob.polymarket.com", Config::default())?
      .authentication_builder(&signer)
      .authenticate()
      .await?;
  ```
</CodeGroup>

***

## Signature Types

When initializing the trading client, you must specify your wallet's **signature type** and **funder address**:

| Wallet Type      | ID  | When to Use                                                                                                    | Funder Address              |
| ---------------- | --- | -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **EOA**          | `0` | Standalone wallet — you pay your own gas (POL for gas)                                                         | Your EOA wallet address     |
| **POLY\_PROXY**  | `1` | Existing Polymarket proxy wallet flow                                                                          | Your proxy wallet address   |
| **GNOSIS\_SAFE** | `2` | Existing Gnosis Safe wallet flow                                                                               | Your Safe wallet address    |
| **POLY\_1271**   | `3` | Deposit wallet flow for new API users. Orders are signed by the owner/session signer and validated by ERC-1271 | Your deposit wallet address |

<Note>
  New API users should use deposit wallets with signature type `3`. Existing
  Proxy and Safe users are unaffected and can keep using signature types `1` and
  `2`. Type `0` is for standalone EOA wallets only.
</Note>

### Initialize the Trading Client

<CodeGroup>
  ```typescript TypeScript theme={null}
  const depositWalletAddress = process.env.DEPOSIT_WALLET_ADDRESS!;

  const client = new ClobClient({
    host: "https://clob.polymarket.com",
    chain: 137,
    signer,
    creds: apiCreds,
    signatureType: 3, // POLY_1271
    funderAddress: depositWalletAddress,
  });
  ```

  ```python Python theme={null}
  deposit_wallet_address = os.getenv("DEPOSIT_WALLET_ADDRESS")

  client = ClobClient(
      "https://clob.polymarket.com",
      key=private_key,
      chain_id=137,
      creds=api_creds,
      signature_type=3,  # POLY_1271
      funder=deposit_wallet_address
  )
  ```

  ```rust Rust theme={null}
  use polymarket_client_sdk_v2::clob::types::SignatureType;

  let deposit_wallet = std::env::var("DEPOSIT_WALLET_ADDRESS")?.parse()?;

  let client = Client::new("https://clob.polymarket.com", Config::default())?
      .authentication_builder(&signer)
      .funder(deposit_wallet)
      .signature_type(SignatureType::Poly1271)
      .authenticate()
      .await?;
  ```
</CodeGroup>

***

## REST API Headers

If you're using the REST API directly (without the SDK), you need to attach authentication headers to each request.

**L1 Headers** — for creating or deriving API credentials:

| Header           | Description         |
| ---------------- | ------------------- |
| `POLY_ADDRESS`   | Your wallet address |
| `POLY_SIGNATURE` | EIP-712 signature   |
| `POLY_TIMESTAMP` | Unix timestamp      |
| `POLY_NONCE`     | Request nonce       |

**L2 Headers** — for all trading operations (orders, cancellations, queries):

| Header            | Description                          |
| ----------------- | ------------------------------------ |
| `POLY_ADDRESS`    | Your wallet address                  |
| `POLY_SIGNATURE`  | HMAC-SHA256 signature of the request |
| `POLY_TIMESTAMP`  | Unix timestamp                       |
| `POLY_API_KEY`    | Your API key                         |
| `POLY_PASSPHRASE` | Your API passphrase                  |

<Note>
  Even with L2 authentication, methods that create orders still require the
  user's private key for EIP-712 order payload signing. L2 credentials
  authenticate the request, but the order itself must be signed by the key.
</Note>

***

## Client Methods

<CardGroup cols={2}>
  <Card title="Public Methods" icon="globe" href="/trading/clients/public">
    Market data, orderbooks, prices, and spreads — no auth required.
  </Card>

  <Card title="L1 Methods" icon="key" href="/trading/clients/l1">
    Sign orders and derive API credentials with your private key.
  </Card>

  <Card title="L2 Methods" icon="lock" href="/trading/clients/l2">
    Place orders, cancel orders, query trades, and manage notifications.
  </Card>

  <Card title="Builder Methods" icon="hammer" href="/trading/clients/builder">
    Track orders and trades attributed to your builder code.
  </Card>
</CardGroup>

***

## Server Infrastructure

The CLOB matching engine runs in the following regions:

* **Primary Servers**: eu-west-2
* **Closest Non-Georestricted Region**: eu-west-1

<Tip>
  **Direct co-location available.** Users who complete the [KYC/KYB
  form](https://docs.google.com/forms/d/e/1FAIpQLSfY-3Dl3yxq8HKFjFad8YzKZmm0k3Gdg29HD6gL-K-AmI6KXw/viewform) can get access to co-locate
  directly in `eu-west-2` for the lowest possible latency to Polymarket's
  primary servers. See [Geographic
  Restrictions](/api-reference/geoblock#server-infrastructure) for full
  geographic availability details.
</Tip>

***

## What Is in This Section

<CardGroup cols={2}>
  <Card title="Quickstart" icon="bolt" href="/trading/quickstart">
    Place your first order end-to-end
  </Card>

  <Card title="Orderbook" icon="chart-bar" href="/trading/orderbook">
    Reading the orderbook, prices, spreads, and midpoints
  </Card>

  <Card title="Orders" icon="list-check" href="/trading/orders/create">
    Order types, tick sizes, creating, cancelling, and querying orders
  </Card>

  <Card title="Fees" icon="receipt" href="/trading/fees">
    Fee structure, fee-enabled markets, and maker rebates
  </Card>

  <Card title="Gasless Transactions" icon="gas-pump" href="/trading/gasless">
    Execute onchain operations without paying gas
  </Card>

  <Card title="CTF Tokens" icon="coins" href="/trading/ctf/overview">
    Split, merge, and redeem outcome tokens
  </Card>

  <Card title="Bridge" icon="bridge" href="/trading/bridge/deposit">
    Deposit and withdraw funds across chains
  </Card>
</CardGroup>
