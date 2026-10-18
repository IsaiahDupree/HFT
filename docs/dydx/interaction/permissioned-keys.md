# Permissioned Keys – dYdX Documentation

> Source: https://docs.dydx.xyz/interaction/permissioned-keys

Permissioned Keys provide a way for different traders to share the same account. The account owner can grant different permissions to permissioned users.

A permission, or set of permissions, is also known as an **authenticator**.

This guide covers both sides: the **owner** (grants permissions) and the **trader** (the permissioned user).

## Owner

There are 2 ways to set up Permissioned API Keys:
1. Via the Trade interface — default permissions to trade on all cross-margin pairs.
2. Via API — fully customisable.

### Setup Permissioned API Keys via Trade Interface

On dYdX.trade, after signing in:
- click `More → API Trading Keys`.
- Click `Generate New API Key`. This generates a new keypair (API Wallet Address + Private Key).
  - **One-time view** — save your Private Key immediately. It will not be shown again and is not stored by dYdX.
- Check the terms and click `Authorize API Key`.

### Create an authenticator (custom)

Compose two sub-authenticators:
- `signatureVerification` — contains the trader's public key (must be present in every authenticator set).
- `messageFilter` — gRPC message ID of the allowed transaction (e.g. `MsgPlaceOrder`).

Then compose with `AllOf`:

```python
# trader_key = trader_wallet.public_key.key
auth = Authenticator.compose(
    AuthenticatorType.AllOf,
    [
        Authenticator.signature_verification(trader_key),
        Authenticator.message_filter("/dydxprotocol.clob.MsgPlaceOrder"),
    ],
)
```

### Add the authenticator

```python
response = await node.add_authenticator(wallet, auth)
```

### List authenticators

```python
authenticators = await node.get_authenticators(wallet.address)
id = authenticators.account_authenticators[-1]
```

### Remove the authenticator

```python
response = await node.remove_authenticator(wallet, id)
```

## Trader

### Setup the permissioned wallet

```typescript
const fromWallet = await LocalWallet.fromPrivateKey(DYDX_TEST_PRIVATE_KEY, BECH32_PREFIX);
const authenticatedSubaccount = SubaccountInfo.forPermissionedWallet(
    fromWallet,
    address,           // owner dydx address
    subaccountNumber,  // subaccount to trade on behalf of
    [authenticatorId],
);
```

### Using the authenticator

```typescript
const client = await CompositeClient.connect(network);
const tx = await client.placeShortTermOrder(
    authenticatedSubaccount,
    'ETH-USD',
    side,
    price,
    0.01,
    clientId,
    goodTilBlock,
    timeInForce,
    false,
    undefined,
);
```
