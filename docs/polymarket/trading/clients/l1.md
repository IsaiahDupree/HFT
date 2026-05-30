> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# L1 Methods

> These methods require a wallet signer (private key) but do not require user API credentials. Use these for initial setup.

## Client Initialization

L1 methods require the client to initialize with a signer.

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
      chain: 137,
      signer, // Signer required for L1 methods
    });

    // Ready to create user API credentials
    const apiKey = await client.createApiKey();
    ```
  </Tab>

  <Tab title="Python">
    ```python theme={null}
    from py_clob_client_v2 import ClobClient
    import os

    private_key = os.getenv("PRIVATE_KEY")

    client = ClobClient(
        host="https://clob.polymarket.com",
        chain_id=137,
        key=private_key  # Signer required for L1 methods
    )

    # Ready to create user API credentials
    api_key = client.create_api_key()
    ```
  </Tab>
</Tabs>

<Warning>
  Never commit private keys to version control. Always use environment variables
  or a secure key management system.
</Warning>

***

## API Key Management

***

### createApiKey

Creates a new API key (L2 credentials) for the wallet signer.

```typescript Signature theme={null}
async createApiKey(nonce?: number): Promise<ApiKeyCreds>
```

<ResponseField name="nonce" type="number">
  Optional custom nonce for deterministic key generation. Optional.
</ResponseField>

<ResponseField name="apiKey" type="string">
  The generated API key string.
</ResponseField>

<ResponseField name="secret" type="string">
  The secret associated with the API key.
</ResponseField>

<ResponseField name="passphrase" type="string">
  The passphrase associated with the API key.
</ResponseField>

***

### deriveApiKey

Derives an existing API key using a specific nonce. If you've already created credentials with a particular nonce, this returns the same credentials.

```typescript Signature theme={null}
async deriveApiKey(nonce?: number): Promise<ApiKeyCreds>
```

<ResponseField name="nonce" type="number">
  The nonce used when originally creating the key. Optional.
</ResponseField>

<ResponseField name="apiKey" type="string">
  The derived API key string.
</ResponseField>

<ResponseField name="secret" type="string">
  The secret associated with the API key.
</ResponseField>

<ResponseField name="passphrase" type="string">
  The passphrase associated with the API key.
</ResponseField>

***

### createOrDeriveApiKey

Convenience method that attempts to derive an API key with the default nonce, or creates a new one if it doesn't exist. **Recommended for initial setup.**

```typescript Signature theme={null}
async createOrDeriveApiKey(nonce?: number): Promise<ApiKeyCreds>
```

<ResponseField name="apiKey" type="string">
  The API key string, either derived or newly created.
</ResponseField>

<ResponseField name="secret" type="string">
  The secret associated with the API key.
</ResponseField>

<ResponseField name="passphrase" type="string">
  The passphrase associated with the API key.
</ResponseField>

***

## Order Signing

<Note>
  In CLOB V2, `expiration` is still accepted in order payloads for GTD/order
  expiry handling, but it is not part of the EIP-712 signed order struct. The
  signed struct uses `timestamp`, `metadata`, and `builder` instead of the V1
  `expiration`, `nonce`, `feeRateBps`, and `taker` fields.
</Note>

### createOrder

Create and sign a limit order locally without posting it to the CLOB. Use this when you want to sign orders in advance or implement custom submission logic. Submit via [`postOrder()`](/trading/clients/l2#postorder) or [`postOrders()`](/trading/clients/l2#postorders).

```typescript Signature theme={null}
async createOrder(
  userOrder: UserOrder,
  options?: Partial<CreateOrderOptions>
): Promise<SignedOrder>
```

<ResponseField name="tokenID" type="string">
  The token ID of the market outcome to trade.
</ResponseField>

<ResponseField name="price" type="number">
  The limit price for the order.
</ResponseField>

<ResponseField name="size" type="number">
  The size (number of shares) for the order.
</ResponseField>

<ResponseField name="side" type="Side">
  The side of the order (buy or sell).
</ResponseField>

<ResponseField name="expiration" type="number">
  Optional expiration timestamp included in the order payload for GTD/order
  expiry handling. This is not part of the CLOB V2 EIP-712 signed order struct.
</ResponseField>

<ResponseField name="tickSize" type="TickSize">
  The tick size used for order validation (CreateOrderOptions).
</ResponseField>

<ResponseField name="negRisk" type="boolean">
  Optional flag for negative risk markets (CreateOrderOptions). Optional.
</ResponseField>

<ResponseField name="salt" type="string">
  A random salt value for the signed order.
</ResponseField>

<ResponseField name="maker" type="string">
  The maker's address.
</ResponseField>

<ResponseField name="signer" type="string">
  The signer's address.
</ResponseField>

<ResponseField name="tokenId" type="string">
  The token ID in the signed order.
</ResponseField>

<ResponseField name="makerAmount" type="string">
  The maker amount as a string.
</ResponseField>

<ResponseField name="takerAmount" type="string">
  The taker amount as a string.
</ResponseField>

<ResponseField name="side" type="number">
  The side of the order as a number (0 = BUY, 1 = SELL).
</ResponseField>

<ResponseField name="expiration" type="string">
  The expiration timestamp included in the order payload. This is not part of
  the CLOB V2 EIP-712 signed order struct.
</ResponseField>

<ResponseField name="timestamp" type="string">
  Order creation timestamp in milliseconds, used for order uniqueness in CLOB
  V2.
</ResponseField>

<ResponseField name="metadata" type="string">
  Reserved `bytes32` metadata field.
</ResponseField>

<ResponseField name="builder" type="string">
  Builder code (`bytes32`) for attribution, or zero if no builder code is
  attached.
</ResponseField>

<ResponseField name="signatureType" type="number">
  The type identifier for the signature scheme used.
</ResponseField>

<ResponseField name="signature" type="string">
  The cryptographic signature of the order.
</ResponseField>

***

### createMarketOrder

Create and sign a market order locally without posting it to the CLOB. Submit via [`postOrder()`](/trading/clients/l2#postorder) or [`postOrders()`](/trading/clients/l2#postorders).

```typescript Signature theme={null}
async createMarketOrder(
  userMarketOrder: UserMarketOrder,
  options?: Partial<CreateOrderOptions>
): Promise<SignedOrder>
```

<ResponseField name="tokenID" type="string">
  The token ID of the market outcome to trade.
</ResponseField>

<ResponseField name="amount" type="number">
  The order amount. For BUY orders this is a dollar amount; for SELL orders this
  is the number of shares.
</ResponseField>

<ResponseField name="side" type="Side">
  The side of the order (buy or sell).
</ResponseField>

<ResponseField name="price" type="number">
  Optional price limit for the market order. Optional.
</ResponseField>

<ResponseField name="orderType" type="OrderType.FOK | OrderType.FAK">
  Optional order type, either FOK (Fill-Or-Kill) or FAK (Fill-And-Kill).
  Optional.
</ResponseField>

<ResponseField name="salt" type="string">
  A random salt value for the signed order.
</ResponseField>

<ResponseField name="maker" type="string">
  The maker's address.
</ResponseField>

<ResponseField name="signer" type="string">
  The signer's address.
</ResponseField>

<ResponseField name="tokenId" type="string">
  The token ID in the signed order.
</ResponseField>

<ResponseField name="makerAmount" type="string">
  The maker amount as a string.
</ResponseField>

<ResponseField name="takerAmount" type="string">
  The taker amount as a string.
</ResponseField>

<ResponseField name="side" type="number">
  The side of the order as a number (0 = BUY, 1 = SELL).
</ResponseField>

<ResponseField name="expiration" type="string">
  The expiration timestamp included in the order payload. This is not part of
  the CLOB V2 EIP-712 signed order struct.
</ResponseField>

<ResponseField name="timestamp" type="string">
  Order creation timestamp in milliseconds, used for order uniqueness in CLOB
  V2.
</ResponseField>

<ResponseField name="metadata" type="string">
  Reserved `bytes32` metadata field.
</ResponseField>

<ResponseField name="builder" type="string">
  Builder code (`bytes32`) for attribution, or zero if no builder code is
  attached.
</ResponseField>

<ResponseField name="signatureType" type="number">
  The type identifier for the signature scheme used.
</ResponseField>

<ResponseField name="signature" type="string">
  The cryptographic signature of the order.
</ResponseField>

***

## Troubleshooting

<AccordionGroup>
  <Accordion title="Error - INVALID_SIGNATURE">
    Your wallet's private key is incorrect or improperly formatted.

    **Solution:**

    * Verify your private key is a valid hex string (starts with `0x`)
    * Ensure you're using the correct key for the intended address
    * Check that the key has proper permissions
  </Accordion>

  <Accordion title="Error - NONCE_ALREADY_USED">
    The nonce you provided has already been used to create an API key.

    **Solution:**

    * Use `deriveApiKey()` with the same nonce to retrieve existing credentials
    * Or use a different nonce with `createApiKey()`
  </Accordion>

  <Accordion title="Error - Invalid Funder Address">
    Your funder address is incorrect or doesn't match your wallet.

    **Solution:** New API users should use the deposit wallet address as the
    funder with signature type `3`. Existing Safe and Proxy users should use
    their current smart-wallet address.
  </Accordion>

  <Accordion title="Lost API credentials but have nonce">
    Use `deriveApiKey()` with the original nonce:

    ```typescript theme={null}
    const recovered = await client.deriveApiKey(originalNonce);
    ```
  </Accordion>

  <Accordion title="Lost both credentials and nonce">
    There's no way to recover lost credentials without the nonce. Create new ones:

    ```typescript theme={null}
    // Create fresh credentials with a new nonce
    const newCreds = await client.createApiKey();
    // Save the nonce this time!
    ```
  </Accordion>
</AccordionGroup>

***

## See Also

<CardGroup cols={2}>
  <Card title="Authentication" icon="shield" href="/api-reference/authentication">
    Deep dive into L1 and L2 authentication.
  </Card>

  <Card title="Trading Quickstart" icon="bolt" href="/trading/quickstart">
    Initialize the client and place your first order.
  </Card>

  <Card title="Public Methods" icon="globe" href="/trading/clients/public">
    Access market data, orderbooks, and prices without auth.
  </Card>

  <Card title="L2 Methods" icon="lock" href="/trading/clients/l2">
    Place and manage orders with API credentials.
  </Card>
</CardGroup>
