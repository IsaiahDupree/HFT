> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Deposit Wallets

> Create deposit wallets, execute wallet actions, and place POLY_1271 orders

Deposit wallets are the wallet path for **new API users**. Existing Safe and
Proxy users are unaffected and can continue using their current wallet setup.

For newly-created polymarket.com accounts using the deposit wallet flow, a
deposit wallet is automatically deployed for you.

<Info>
  This guide is for developers integrating directly with the APIs or SDKs. It
  does not change existing user balances, existing proxy wallets, or existing
  Safes.
</Info>

## Where Deposit Wallets Fit

| Area                 | Existing Safe/Proxy users           | New API user deposit wallet flow                 |
| -------------------- | ----------------------------------- | ------------------------------------------------ |
| Wallet type          | Existing proxy wallet or Safe       | Deposit wallet                                   |
| Wallet deployment    | Existing relayer Safe/proxy flow    | Relayer `WALLET-CREATE`                          |
| Deployment signature | Existing Safe/proxy deployment flow | No user signature in the `WALLET-CREATE` payload |
| Wallet calls         | Safe/proxy relayer transactions     | Relayer `WALLET` batches                         |
| Order signature type | `0`, `1`, or `2`                    | `3`, also called `POLY_1271`                     |
| Order maker          | EOA, proxy, or Safe                 | Deposit wallet address                           |
| Order signer field   | EOA for existing types              | Deposit wallet address                           |
| Signing key          | User EOA or session signer          | Deposit wallet owner or approved session signer  |

## Mental Model

A deposit wallet is a per-user ERC-1967 proxy deployed by a deposit wallet
factory. The wallet holds pUSD and conditional tokens on-chain.

The owner or session signer signs two different kinds of payloads:

1. A **deposit wallet Batch** for on-chain wallet calls. This is submitted to the
   relayer as a `WALLET` transaction.
2. A **CLOB order** with `signatureType = 3`. The CLOB validates this through
   ERC-1271 on the deposit wallet.

These signatures are not interchangeable. A `WALLET` batch uses a normal
65-byte EIP-712 signature over the `DepositWallet` `Batch` type. A CLOB order
uses an ERC-7739-wrapped `POLY_1271` signature and is longer than a normal ECDSA
signature.

## Integration Flow

<Steps>
  <Step title="Create or identify the owner signer">
    Use the EOA or session signer that will own the deposit wallet. This signer is
    also the key that signs deposit wallet batches and CLOB order payloads unless
    your session signer flow delegates signing elsewhere.
  </Step>

  <Step title="Deploy the deposit wallet">
    Submit a relayer `WALLET-CREATE` request. The body only needs the transaction
    type, owner address, and deposit wallet factory address.

    The deposit wallet address is deterministic. TypeScript relayer users can call
    `deriveDepositWalletAddress()`, and Python relayer users can call
    `get_expected_deposit_wallet()`. Other integrations should store the address
    returned by onboarding or derive it with the deterministic formula below.
  </Step>

  <Step title="Fund the deposit wallet">
    Transfer pUSD to the deposit wallet address. pUSD held by the EOA does not count
    as CLOB buying power for deposit wallet orders.
  </Step>

  <Step title="Approve trading contracts from the wallet">
    Approvals must be made **from the deposit wallet**, not from the owner EOA. Build
    ERC-20 or ERC-1155 approval calldata and submit it through a relayer `WALLET`
    batch.
  </Step>

  <Step title="Sync CLOB balances">
    After funding or changing allowances, call the CLOB balance allowance update
    endpoint through the SDK or API. The request must use `signature_type = 3`.
  </Step>

  <Step title="Place orders with POLY_1271">
    Initialize the CLOB client with the deposit wallet as the funder and
    `POLY_1271` as the signature type. Orders must have both `maker` and `signer`
    set to the deposit wallet address.
  </Step>
</Steps>

## SDK Users

Use a relayer client or the raw relayer API for wallet deployment and wallet
batches. Use the CLOB client for order signing, posting, cancelling, balances,
and account data.

<Tabs>
  <Tab title="TypeScript">
    Use the TypeScript clients with deposit wallet support:
    [@polymarket/builder-relayer-client](https://www.npmjs.com/package/@polymarket/builder-relayer-client)
    and
    [@polymarket/clob-client-v2](https://www.npmjs.com/package/@polymarket/clob-client-v2).

    ```bash theme={null}
    npm install @polymarket/builder-relayer-client @polymarket/clob-client-v2 @polymarket/builder-signing-sdk viem
    ```

    ### Deploy the Wallet

    ```typescript theme={null}
    import {
      BuilderApiKeyCreds,
      BuilderConfig,
    } from "@polymarket/builder-signing-sdk";
    import { RelayClient } from "@polymarket/builder-relayer-client";
    import { createWalletClient, Hex, http } from "viem";
    import { privateKeyToAccount } from "viem/accounts";
    import { polygon } from "viem/chains";

    const relayerUrl = process.env.RELAYER_URL!;
    const chainId = Number(process.env.CHAIN_ID ?? 137);
    const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(process.env.RPC_URL),
    });

    const builderCreds: BuilderApiKeyCreds = {
      key: process.env.BUILDER_API_KEY!,
      secret: process.env.BUILDER_SECRET!,
      passphrase: process.env.BUILDER_PASS_PHRASE!,
    };

    const builderConfig = new BuilderConfig({
      localBuilderCreds: builderCreds,
    });

    const relayer = new RelayClient(
      relayerUrl,
      chainId,
      walletClient,
      builderConfig,
    );

    const depositWalletAddress = await relayer.deriveDepositWalletAddress();
    const response = await relayer.deployDepositWallet();
    const confirmed = await response.wait();
    ```

    `deployDepositWallet()` submits a `WALLET-CREATE` transaction. It does not add a
    user signature to the deployment body.

    ### Execute a Wallet Batch

    ```typescript theme={null}
    import type { DepositWalletCall } from "@polymarket/builder-relayer-client";

    const calls: DepositWalletCall[] = [
      {
        target: process.env.PUSD_ADDRESS!,
        value: "0",
        data: approveCalldata,
      },
    ];

    const deadline = Math.floor(Date.now() / 1000 + 600).toString();
    const response = await relayer.executeDepositWalletBatch(
      calls,
      depositWalletAddress,
      deadline,
    );
    const confirmed = await response.wait();
    ```

    The TypeScript relayer client fetches the current `WALLET` nonce before signing
    and submitting the batch. The SDK signs the batch with this EIP-712 domain before
    submitting it to the relayer:

    ```typescript theme={null}
    {
      name: "DepositWallet",
      version: "1",
      chainId,
      verifyingContract: depositWalletAddress,
    }
    ```

    ### Trade From the Deposit Wallet

    ```typescript theme={null}
    import {
      AssetType,
      ClobClient,
      OrderType,
      Side,
      SignatureTypeV2,
    } from "@polymarket/clob-client-v2";

    const creds = {
      key: process.env.CLOB_API_KEY!,
      secret: process.env.CLOB_SECRET!,
      passphrase: process.env.CLOB_PASS_PHRASE!,
    };

    const clob = new ClobClient({
      host: process.env.CLOB_API_URL!,
      chain: chainId,
      signer: walletClient,
      creds,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: depositWalletAddress,
    });

    await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });

    const order = await clob.createAndPostOrder(
      {
        tokenID: process.env.TOKEN_ID!,
        price: 0.5,
        size: 10,
        side: Side.BUY,
      },
      { tickSize: "0.01", negRisk: false },
      OrderType.GTC,
    );
    ```
  </Tab>

  <Tab title="Python">
    Use the Python builder relayer client with deposit wallet support:
    [py-builder-relayer-client](https://pypi.org/project/py-builder-relayer-client/).

    ```bash theme={null}
    pip install py-builder-relayer-client
    ```

    ### Deploy the Wallet

    ```python theme={null}
    import os

    from py_builder_relayer_client.client import RelayClient
    from py_builder_signing_sdk.config import BuilderApiKeyCreds, BuilderConfig

    builder_config = BuilderConfig(
        local_builder_creds=BuilderApiKeyCreds(
            key=os.environ["BUILDER_API_KEY"],
            secret=os.environ["BUILDER_SECRET"],
            passphrase=os.environ["BUILDER_PASS_PHRASE"],
        )
    )

    relayer = RelayClient(
        os.environ["RELAYER_URL"],
        int(os.environ.get("CHAIN_ID", "137")),
        os.environ["PRIVATE_KEY"],
        builder_config,
    )

    deposit_wallet = relayer.get_expected_deposit_wallet()
    response = relayer.deploy_deposit_wallet()
    confirmed = response.wait()
    ```

    `get_expected_deposit_wallet()` derives the deterministic wallet address from
    the signer and the chain's deposit wallet configuration.

    ### Execute a Wallet Batch

    ```python theme={null}
    import time

    from py_builder_relayer_client.models import DepositWalletCall, TransactionType

    nonce_payload = relayer.get_nonce(
        relayer.signer.address(),
        TransactionType.WALLET.value,
    )
    wallet_nonce = str(nonce_payload["nonce"])

    call = DepositWalletCall(
        target=os.environ["PUSD_ADDRESS"],
        value="0",
        data=approve_calldata,
    )

    response = relayer.execute_deposit_wallet_batch(
        calls=[call],
        wallet_address=deposit_wallet,
        nonce=wallet_nonce,
        deadline=str(int(time.time()) + 600),
    )
    confirmed = response.wait()
    ```

    The Python relayer client mirrors the TypeScript wire format for `WALLET-CREATE`
    and `WALLET` requests, while keeping builder API key auth in the Python client.

    ### Trade From the Deposit Wallet

    Use the Python CLOB client with deposit wallet order support:
    [py-clob-client-v2](https://pypi.org/project/py-clob-client-v2/).

    ```bash theme={null}
    pip install py-clob-client-v2
    ```

    ```python theme={null}
    import os

    from py_clob_client_v2 import (
        ApiCreds,
        AssetType,
        BalanceAllowanceParams,
        ClobClient,
        OrderArgs,
        OrderType,
        PartialCreateOrderOptions,
        Side,
        SignatureTypeV2,
    )

    creds = ApiCreds(
        api_key=os.environ["CLOB_API_KEY"],
        api_secret=os.environ["CLOB_SECRET"],
        api_passphrase=os.environ["CLOB_PASS_PHRASE"],
    )

    clob = ClobClient(
        host=os.environ["CLOB_API_URL"],
        chain_id=int(os.environ.get("CHAIN_ID", "137")),
        key=os.environ["PRIVATE_KEY"],
        creds=creds,
        signature_type=SignatureTypeV2.POLY_1271,
        funder=deposit_wallet,
    )

    clob.update_balance_allowance(
        BalanceAllowanceParams(
            asset_type=AssetType.COLLATERAL,
            signature_type=SignatureTypeV2.POLY_1271,
        )
    )

    response = clob.create_and_post_order(
        order_args=OrderArgs(
            token_id=os.environ["TOKEN_ID"],
            price=0.50,
            size=10,
            side=Side.BUY,
        ),
        options=PartialCreateOrderOptions(tick_size="0.01", neg_risk=False),
        order_type=OrderType.GTC,
    )
    ```
  </Tab>

  <Tab title="Rust">
    ### Deploy the Wallet and Execute Wallet Batches

    The Rust SDK supports the CLOB order path for deposit wallets. It does not
    include a builder relayer client. Use the TypeScript or Python relayer client
    above, or the raw API flow below, to submit `WALLET-CREATE` and `WALLET`
    transactions.

    Use the Rust CLOB client with deposit wallet support:
    [polymarket\_client\_sdk\_v2](https://crates.io/crates/polymarket_client_sdk_v2).

    ```bash theme={null}
    cargo add polymarket_client_sdk_v2 --features clob
    ```

    Once the deposit wallet is deployed, funded, and approved, pass the deposit
    wallet address as the Rust CLOB client funder.

    ### Trade From the Deposit Wallet

    ```rust theme={null}
    use std::str::FromStr as _;

    use polymarket_client_sdk_v2::auth::{LocalSigner, Signer as _};
    use polymarket_client_sdk_v2::clob::types::request::UpdateBalanceAllowanceRequest;
    use polymarket_client_sdk_v2::clob::types::{AssetType, OrderType, Side, SignatureType};
    use polymarket_client_sdk_v2::clob::{Client, Config};
    use polymarket_client_sdk_v2::types::{Address, Decimal, U256};
    use polymarket_client_sdk_v2::{POLYGON, PRIVATE_KEY_VAR};

    let host = std::env::var("CLOB_API_URL")?;
    let token_id = U256::from_str(&std::env::var("TOKEN_ID")?)?;
    let deposit_wallet = Address::from_str(&std::env::var("DEPOSIT_WALLET")?)?;
    let signer =
        LocalSigner::from_str(&std::env::var(PRIVATE_KEY_VAR)?)?.with_chain_id(Some(POLYGON));

    let client = Client::new(&host, Config::default())?
        .authentication_builder(&signer)
        .funder(deposit_wallet)
        .signature_type(SignatureType::Poly1271)
        .authenticate()
        .await?;

    client
        .update_balance_allowance(
            UpdateBalanceAllowanceRequest::builder()
                .asset_type(AssetType::Collateral)
                .build(),
        )
        .await?;

    let _response = client
        .limit_order()
        .token_id(token_id)
        .side(Side::Buy)
        .price(Decimal::from_str("0.50")?)
        .size(Decimal::from_str("10")?)
        .order_type(OrderType::GTC)
        .build_sign_and_post(&signer)
        .await?;
    ```

    The Rust client sets `signatureType = 3` and builds the wrapped ERC-1271 order
    signature when `SignatureType::Poly1271` and a deposit wallet funder are
    configured.
  </Tab>
</Tabs>

## API Users

Direct API integrations need to implement the same two relayer operations and
the same CLOB order signature shape used by the SDKs.

### Deploy a Deposit Wallet

Submit this body to the relayer `/submit` endpoint:

```json theme={null}
{
  "type": "WALLET-CREATE",
  "from": "0xOwnerAddress",
  "to": "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07"
}
```

Field meanings:

| Field  | Description                                                         |
| ------ | ------------------------------------------------------------------- |
| `type` | Must be `WALLET-CREATE`                                             |
| `from` | Owner address for the deposit wallet                                |
| `to`   | Deposit wallet factory address for the active chain and environment |

Current factory addresses:

| Chain                 | Deposit wallet factory                       |
| --------------------- | -------------------------------------------- |
| Polygon mainnet `137` | `0x00000000000Fb5C9ADea0298D729A0CB3823Cc07` |

There is no user signature field in this payload. After submission, poll the
relayer transaction until it reaches `STATE_CONFIRMED` before treating the
deposit wallet as ready. `STATE_MINED` or `GET /deployed?...&type=WALLET` can
indicate that the wallet exists onchain before the relayer has completed wallet
registry updates, so submitting a deposit wallet batch before confirmation may
fail with a wallet registration error. Store the deployed wallet address from
the `WalletDeployed` event, from your onboarding flow, or derive it
deterministically using the SDK's chain config.

Deterministic address derivation follows the relayer clients:

```text theme={null}
walletId = bytes32(owner) // owner address left-padded to 32 bytes
args = abi.encode(factory, walletId)
salt = keccak256(args)
bytecodeHash = SoladyLibClone.initCodeHashERC1967(implementation, args)
depositWallet = CREATE2(factory, salt, bytecodeHash)
```

### Submit a Deposit Wallet Batch

For wallet actions such as token approvals, transfers, withdrawals, splits, or
merges, fetch the current `WALLET` nonce for the owner address, then sign a
`Batch` with the owner or session signer:

```http theme={null}
GET /nonce?address=0xOwnerAddress&type=WALLET
```

```typescript theme={null}
const types = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
};

const domain = {
  name: "DepositWallet",
  version: "1",
  chainId,
  verifyingContract: depositWalletAddress,
};

const message = {
  wallet: depositWalletAddress,
  nonce,
  deadline,
  calls,
};
```

Submit the signed batch to the relayer:

```json theme={null}
{
  "type": "WALLET",
  "from": "0xOwnerAddress",
  "to": "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
  "nonce": "0",
  "signature": "0x65ByteBatchSignature",
  "depositWalletParams": {
    "depositWallet": "0xDepositWallet",
    "deadline": "1760000000",
    "calls": [
      {
        "target": "0xTokenOrContract",
        "value": "0",
        "data": "0xCalldata"
      }
    ]
  }
}
```

The `signature` in a `WALLET` request is a normal 65-byte EIP-712 signature with
a `0x` prefix. This is different from the CLOB order signature described below.
After submitting a `WALLET` batch, poll its relayer transaction until
`STATE_CONFIRMED` before relying on its effects for later deposit wallet
actions.

### Place CLOB Orders

For deposit wallet orders, the raw order inside the `/order` request must use
`signatureType = 3`:

```json theme={null}
{
  "deferExec": false,
  "order": {
    "salt": 123456789,
    "maker": "0xDepositWallet",
    "signer": "0xDepositWallet",
    "tokenId": "TOKEN_ID",
    "makerAmount": "5000000",
    "takerAmount": "10000000",
    "side": "BUY",
    "expiration": "0",
    "signatureType": 3,
    "timestamp": "1760000000",
    "metadata": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "builder": "0x0000000000000000000000000000000000000000000000000000000000000000",
    "signature": "0xWrapped1271Signature"
  },
  "owner": "CLOB_API_KEY",
  "orderType": "GTC"
}
```

The signature is not the raw order EIP-712 signature. It is an ERC-7739-wrapped
signature that lets the deposit wallet validate the order through ERC-1271.

The owner or session signer signs a nested `TypedDataSign` payload under the
correct CTF Exchange V2 domain. The nested wallet fields are:

| Field               | Value                                                                |
| ------------------- | -------------------------------------------------------------------- |
| `name`              | `DepositWallet`                                                      |
| `version`           | `1`                                                                  |
| `chainId`           | Current chain ID                                                     |
| `verifyingContract` | Deposit wallet address                                               |
| `salt`              | `0x0000000000000000000000000000000000000000000000000000000000000000` |

The SDKs build this wrapper for you when you configure `POLY_1271` and the
deposit wallet funder address.

<Warning>
  If you sign the CLOB order as a normal EOA order, or if `maker` and `signer`
  are not both the deposit wallet address, the order will fail ERC-1271
  validation. `POLY_1271` is supported on V2 orders only.
</Warning>

### Sync Balance and Allowance

After funding the deposit wallet or approving contracts from it, update the CLOB
balance cache using `signature_type = 3`.

```http theme={null}
GET /balance-allowance/update?asset_type=COLLATERAL&signature_type=3
```

For conditional tokens, include the token ID:

```http theme={null}
GET /balance-allowance/update?asset_type=CONDITIONAL&token_id=TOKEN_ID&signature_type=3
```

Use normal CLOB L2 authentication headers for these requests. Relayer auth and
CLOB auth are separate systems.

## Common Issues

<AccordionGroup>
  <Accordion title="Order is rejected as invalid signature">
    Check all four signature inputs: `signatureType` must be `3`, order `maker` must
    be the deposit wallet, order `signer` must be the deposit wallet, and the order
    signature must be the ERC-7739-wrapped `POLY_1271` signature. Also confirm the
    order was signed against the correct CTF Exchange V2 verifying contract for the
    market.
  </Accordion>

  <Accordion title="Wallet batch is rejected">
    Fetch the current `WALLET` nonce fresh from the relayer before signing the batch.
    Confirm the deadline is still in the future and within the relayer's accepted
    range. The `WALLET` batch signature should be a normal 65-byte EIP-712 signature
    over `DepositWallet` `Batch`.
  </Accordion>

  <Accordion title="Order says not enough balance">
    Confirm pUSD is held by the deposit wallet address. Then update the CLOB balance
    cache with `signature_type = 3`. pUSD sitting on the owner EOA does not fund
    deposit wallet orders.
  </Accordion>

  <Accordion title="Allowance is missing">
    Approvals must come from the deposit wallet. An EOA `approve()` transaction does
    not approve spending from the deposit wallet. Submit approval calldata through a
    relayer `WALLET` batch.
  </Accordion>

  <Accordion title="Direct API auth is confusing">
    Relayer auth and CLOB auth are independent. Use the auth method required by your
    relayer environment for `/submit`. Use CLOB L1/L2 authentication for order and
    balance endpoints. Do not reuse relayer cookies or headers as CLOB auth.
  </Accordion>
</AccordionGroup>
