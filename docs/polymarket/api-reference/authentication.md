> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Authentication

> How to authenticate requests to the CLOB API

The CLOB API uses two levels of authentication: **L1 (Private Key)** and **L2 (API Key)**. Either can be accomplished using the CLOB client or REST API.

## Public vs Authenticated

<CardGroup cols={1}>
  <Card title="Public (No Auth)" icon="unlock">
    The **Gamma API**, **Data API**, and CLOB read endpoints (orderbook, prices, spreads) require no authentication.
  </Card>

  <Card title="Authenticated (CLOB)" icon="lock">
    CLOB trading endpoints (placing orders, cancellations, heartbeat) require all 5 `POLY_*` L2 HTTP headers.
  </Card>
</CardGroup>

***

## Two-Level Authentication Model

The CLOB uses two levels of authentication: L1 (Private Key) and L2 (API Key). Either can be accomplished using the CLOB client or REST API

### L1 Authentication

L1 authentication uses the wallet's private key to sign an EIP-712 message used in the request header. It proves ownership and control over the private key. The private key stays in control of the user and all trading activity remains non-custodial.

**Used for:**

* Creating API credentials
* Deriving existing API credentials
* Signing and creating user's orders locally

### L2 Authentication

L2 uses API credentials (apiKey, secret, passphrase) generated from L1 authentication. These are used solely to authenticate requests made to the CLOB API. Requests are signed using HMAC-SHA256.

**Used for:**

* Cancel or get user's open orders
* Check user's balances and allowances
* Post user's signed orders

<Info>
  Even with L2 authentication headers, methods that create user orders still
  require the user to sign the order payload.
</Info>

***

## Getting API Credentials

Before making authenticated requests, you need to obtain API credentials using L1 authentication.

### Using the SDK

<Tabs>
  <Tab title="TypeScript">
    ```typescript theme={null}
    import { ClobClient } from "@polymarket/clob-client-v2";
    import { createWalletClient, http } from "viem";
    import { privateKeyToAccount } from "viem/accounts";

    const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
    const signer = createWalletClient({ account, transport: http() });

    const client = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137, // Polygon mainnet
      signer,
    });

    // Creates new credentials or derives existing ones
    const credentials = await client.createOrDeriveApiKey();

    console.log(credentials);
    // {
    //   key: "550e8400-e29b-41d4-a716-446655440000",
    //   secret: "base64EncodedSecretString",
    //   passphrase: "randomPassphraseString"
    // }
    ```
  </Tab>

  <Tab title="Python">
    ```python theme={null}
    from py_clob_client_v2 import ClobClient
    import os

    client = ClobClient(
        host="https://clob.polymarket.com",
        chain_id=137,  # Polygon mainnet
        key=os.getenv("PRIVATE_KEY")
    )

    # Creates new credentials or derives existing ones
    credentials = client.create_or_derive_api_key()

    print(credentials)
    # {
    #     "apiKey": "550e8400-e29b-41d4-a716-446655440000",
    #     "secret": "base64EncodedSecretString",
    #     "passphrase": "randomPassphraseString"
    # }
    ```
  </Tab>

  <Tab title="Rust">
    ```rust theme={null}
    use std::str::FromStr;
    use polymarket_client_sdk_v2::POLYGON;
    use polymarket_client_sdk_v2::auth::{LocalSigner, Signer};
    use polymarket_client_sdk_v2::clob::{Client, Config};

    let private_key = std::env::var("POLYMARKET_PRIVATE_KEY")?;
    let signer = LocalSigner::from_str(&private_key)?
        .with_chain_id(Some(POLYGON));

    // Creates new credentials or derives existing ones,
    // then initializes the authenticated client — all in one step
    let client = Client::new("https://clob.polymarket.com", Config::default())?
        .authentication_builder(&signer)
        .authenticate()
        .await?;

    let credentials = client.credentials();
    println!("API Key: {}", credentials.key());
    ```
  </Tab>
</Tabs>

<Warning>
  **Never commit private keys to version control.** Always use environment
  variables or secure key management systems.
</Warning>

### Using the REST API

While we highly recommend using our provided clients to handle signing and authentication, the following is for developers who choose NOT to use our [Python](https://github.com/Polymarket/py-clob-client-v2) or [TypeScript](https://github.com/Polymarket/clob-client-v2) clients.

**Create API Credentials**

```bash theme={null}
POST https://clob.polymarket.com/auth/api-key
```

**Derive API Credentials**

```bash theme={null}
GET https://clob.polymarket.com/auth/derive-api-key
```

Required L1 headers:

| Header           | Description            |
| ---------------- | ---------------------- |
| `POLY_ADDRESS`   | Polygon signer address |
| `POLY_SIGNATURE` | CLOB EIP-712 signature |
| `POLY_TIMESTAMP` | Current UNIX timestamp |
| `POLY_NONCE`     | Nonce (default: 0)     |

The `POLY_SIGNATURE` is generated by signing the following EIP-712 struct:

<Accordion title="EIP-712 Signing Example">
  <CodeGroup>
    ```typescript TypeScript theme={null}
    const domain = {
      name: "ClobAuthDomain",
      version: "1",
      chainId: chainId, // Polygon Chain ID 137
    };

    const types = {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    };

    const value = {
      address: signingAddress, // The Signing address
      timestamp: ts,            // The CLOB API server timestamp
      nonce: nonce,             // The nonce used
      message: "This message attests that I control the given wallet",
    };

    const sig = await signer._signTypedData(domain, types, value);
    ```

    ```python Python theme={null}
    domain = {
        "name": "ClobAuthDomain",
        "version": "1",
        "chainId": chainId,  # Polygon Chain ID 137
    }

    types = {
        "ClobAuth": [
            {"name": "address", "type": "address"},
            {"name": "timestamp", "type": "string"},
            {"name": "nonce", "type": "uint256"},
            {"name": "message", "type": "string"},
        ]
    }

    value = {
        "address": signingAddress,  # The signing address
        "timestamp": ts,            # The CLOB API server timestamp
        "nonce": nonce,             # The nonce used
        "message": "This message attests that I control the given wallet",
    }

    sig = signer.sign_typed_data(domain, types, value)
    ```
  </CodeGroup>
</Accordion>

Reference implementations:

* [TypeScript](https://github.com/Polymarket/clob-client-v2/blob/main/src/signing/eip712.ts)
* [Python](https://github.com/Polymarket/py-clob-client-v2/blob/main/py_clob_client_v2/signing/eip712.py)

Response:

```json theme={null}
{
  "apiKey": "550e8400-e29b-41d4-a716-446655440000",
  "secret": "base64EncodedSecretString",
  "passphrase": "randomPassphraseString"
}
```

**You'll need all three values for L2 authentication.**

***

## L2 Authentication Headers

All trading endpoints require these 5 headers:

| Header            | Description                   |
| ----------------- | ----------------------------- |
| `POLY_ADDRESS`    | Polygon signer address        |
| `POLY_SIGNATURE`  | HMAC signature for request    |
| `POLY_TIMESTAMP`  | Current UNIX timestamp        |
| `POLY_API_KEY`    | User's API `apiKey` value     |
| `POLY_PASSPHRASE` | User's API `passphrase` value |

The `POLY_SIGNATURE` for L2 is an HMAC-SHA256 signature created using the user's API credentials `secret` value. Reference implementations can be found in the [TypeScript](https://github.com/Polymarket/clob-client-v2/blob/main/src/signing/hmac.ts) and [Python](https://github.com/Polymarket/py-clob-client-v2/blob/main/py_clob_client_v2/signing/hmac.py) clients.

### CLOB Client

<Tabs>
  <Tab title="TypeScript">
    ```typescript theme={null}
    import { ClobClient, Side } from "@polymarket/clob-client-v2";
    import { createWalletClient, http } from "viem";
    import { privateKeyToAccount } from "viem/accounts";

    const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
    const signer = createWalletClient({ account, transport: http() });
    const depositWalletAddress = process.env.DEPOSIT_WALLET_ADDRESS!;

    const client = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer,
      creds: apiCreds, // Generated from L1 auth, API credentials enable L2 methods
      signatureType: 3, // POLY_1271, explained below
      funderAddress: depositWalletAddress, // deposit wallet funder
    });

    // Now you can trade!
    const order = await client.createAndPostOrder(
      { tokenID: "123456", price: 0.65, size: 100, side: Side.BUY },
      { tickSize: "0.01", negRisk: false }
    );
    ```
  </Tab>

  <Tab title="Python">
    ```python theme={null}
    from py_clob_client_v2 import ClobClient, OrderArgs, PartialCreateOrderOptions
    from py_clob_client_v2.order_builder.constants import BUY
    import os

    client = ClobClient(
        host="https://clob.polymarket.com",
        chain_id=137,
        key=os.getenv("PRIVATE_KEY"),
        creds=api_creds,  # Generated from L1 auth, API credentials enable L2 methods
        signature_type=3,  # POLY_1271, explained below
        funder=os.getenv("DEPOSIT_WALLET_ADDRESS")
    )

    # Now you can trade!
    order = client.create_and_post_order(
        OrderArgs(token_id="123456", price=0.65, size=100, side=BUY),
        options=PartialCreateOrderOptions(tick_size="0.01", neg_risk=False),
    )
    ```
  </Tab>

  <Tab title="Rust">
    ```rust theme={null}
    use polymarket_client_sdk_v2::clob::types::{Side, SignatureType};
    use polymarket_client_sdk_v2::types::dec;

    let deposit_wallet = std::env::var("DEPOSIT_WALLET_ADDRESS")?.parse()?;

    let client = Client::new("https://clob.polymarket.com", Config::default())?
        .authentication_builder(&signer)
        .funder(deposit_wallet)
        .signature_type(SignatureType::Poly1271)
        .authenticate()
        .await?;

    // Now you can trade!
    let order = client.limit_order()
        .token_id("123456".parse()?)
        .price(dec!(0.65))
        .size(dec!(100))
        .side(Side::Buy)
        .build().await?;
    let signed = client.sign(&signer, order).await?;
    let response = client.post_order(signed).await?;
    ```
  </Tab>
</Tabs>

<Info>
  Even with L2 authentication headers, methods that create user orders still
  require the user to sign the order payload.
</Info>

***

## Signature Types and Funder

When initializing the L2 client, you must specify your wallet **signatureType** and the **funder** address which holds the funds:

| Signature Type | Value | Description                                                                                                                |
| -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| EOA            | `0`   | Standard Ethereum wallet (MetaMask). Funder is the EOA address and will need POL to pay gas on transactions.               |
| POLY\_PROXY    | `1`   | Existing Polymarket proxy wallet flow, commonly used by users who logged in via Magic Link email/Google.                   |
| GNOSIS\_SAFE   | `2`   | Existing Gnosis Safe wallet flow. Existing Safe users can continue using this type.                                        |
| POLY\_1271     | `3`   | Deposit wallet flow for new API users. The funder is the deposit wallet address and orders are validated through ERC-1271. |

<Tip>
  New API users should use deposit wallets with `POLY_1271`. Existing Safe and
  Proxy users are unaffected and can keep using their current funder address and
  signature type. See the [Deposit Wallet Guide](/trading/deposit-wallets) for
  setup details.
</Tip>

***

## Security Best Practices

<AccordionGroup>
  <Accordion title="Never expose private keys">
    Store private keys in environment variables or secure key management systems. Never commit them to version control.

    ```bash theme={null}
    # .env (never commit this file)
    PRIVATE_KEY=0x...
    ```
  </Accordion>

  <Accordion title="Implement request signing on the server">
    Never expose your API secret in client-side code. All authenticated requests should originate from your backend.
  </Accordion>
</AccordionGroup>

***

## Troubleshooting

<AccordionGroup>
  <Accordion title="Error - INVALID_SIGNATURE">
    Your wallet's private key is incorrect or improperly formatted.

    **Solutions:**

    * Verify your private key is a valid hex string (starts with "0x")
    * Ensure you're using the correct key for the intended address
    * Check that the key has proper permissions
  </Accordion>

  <Accordion title="Error - NONCE_ALREADY_USED">
    The nonce you provided has already been used to create an API key.

    **Solutions:**

    * Use `deriveApiKey()` with the same nonce to retrieve existing credentials
    * Or use a different nonce with `createApiKey()`
  </Accordion>

  <Accordion title="Error - Invalid Funder Address">
    Your funder address is incorrect or doesn't match your wallet.

    **Solution:** Check your Polymarket profile address at [polymarket.com/settings](https://polymarket.com/settings).

    If it does not exist or user has never logged into Polymarket.com, deploy it first before creating L2 authentication.
  </Accordion>

  <Accordion title="Lost both credentials and nonce">
    Unfortunately, there's no way to recover lost API credentials without the nonce. You'll need to create new credentials:

    ```typescript theme={null}
    // Create fresh credentials with a new nonce
    const newCreds = await client.createApiKey();
    // Save the nonce this time!
    ```
  </Accordion>
</AccordionGroup>

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Place Your First Order" icon="plus" href="/trading/quickstart">
    Learn how to create and submit orders.
  </Card>

  <Card title="Geographic Restrictions" icon="globe" href="/api-reference/geoblock">
    Check trading availability by region.
  </Card>
</CardGroup>
