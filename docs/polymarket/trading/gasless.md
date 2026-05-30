> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Gasless Transactions

> Execute onchain operations without paying gas fees

Polymarket's **Relayer Client** enables gasless transactions for your users. Instead of requiring users to hold POL for gas, Polymarket's infrastructure pays all transaction fees. This creates a seamless experience where users only need pUSD to trade.

## How It Works

The relayer acts as a transaction sponsor:

1. Your app creates a transaction
2. The user signs it with their private key
3. Your app sends it to Polymarket's relayer
4. The relayer submits it onchain and pays the gas fee
5. The transaction executes from the user's wallet

## What Is Covered

Polymarket pays gas for all operations routed through the relayer:

| Operation             | Description                                       |
| --------------------- | ------------------------------------------------- |
| **Wallet deployment** | Deploy deposit wallets for new API users          |
| **Token approvals**   | Approve contracts to spend pUSD or outcome tokens |
| **CTF operations**    | Split, merge, and redeem positions                |
| **Transfers**         | Move tokens between addresses                     |

## Authentication

The relayer uses **Relayer API Keys**. You can create one from [Settings > API Keys](https://polymarket.com/settings?tab=api-keys) on the Polymarket website.

<Note>
  **Already have a builder signing key?** Your existing HMAC-based builder API
  key keeps working with the Relayer — no need to rotate or reissue. Order
  attribution is now associated with the native `builderCode` field in CLOB V2.
  See [Migrating to CLOB V2](/v2-migration#builder-program) for context.
</Note>

Include these headers with your requests:

| Header                    | Description                   |
| ------------------------- | ----------------------------- |
| `RELAYER_API_KEY`         | Your Relayer API key          |
| `RELAYER_API_KEY_ADDRESS` | The address that owns the key |

<Info>
  If you want to use the Relayer API Key directly without the SDK, see the
  [Relayer API Reference](/api-reference/relayer).
</Info>

## Prerequisites

Before using the relayer, you need:

| Requirement                  | Source                                                              |
| ---------------------------- | ------------------------------------------------------------------- |
| Relayer API Key              | [Settings > API Keys](https://polymarket.com/settings?tab=api-keys) |
| User's private key or signer | Your wallet integration                                             |
| pUSD balance                 | For trading (not for gas)                                           |

## Installation

<CodeGroup>
  ```bash npm theme={null}
  npm install @polymarket/builder-relayer-client
  ```

  ```bash pip theme={null}
  pip install py-builder-relayer-client
  ```
</CodeGroup>

## Client Setup

Initialize the relayer client with your Relayer API Key:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { createWalletClient, http, Hex } from "viem";
  import { privateKeyToAccount } from "viem/accounts";
  import { polygon } from "viem/chains";
  import { RelayClient } from "@polymarket/builder-relayer-client";

  const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(process.env.RPC_URL),
  });

  const client = new RelayClient({
    host: "https://relayer-v2.polymarket.com/",
    chain: 137,
    signer: wallet,
    relayerApiKey: process.env.RELAYER_API_KEY!,
    relayerApiKeyAddress: process.env.RELAYER_API_KEY_ADDRESS!,
  });
  ```

  ```python Python theme={null}
  import os
  from py_builder_relayer_client.client import RelayClient

  client = RelayClient(
      host="https://relayer-v2.polymarket.com",
      chain=137,
      signer=os.getenv("PRIVATE_KEY"),
      relayer_api_key=os.environ["RELAYER_API_KEY"],
      relayer_api_key_address=os.environ["RELAYER_API_KEY_ADDRESS"],
  )
  ```
</CodeGroup>

<Warning>
  Never expose your Relayer API Key in client-side code. Use environment
  variables or a secrets manager.
</Warning>

## Wallet Types

Use deposit wallets for new API users. Existing Safe and Proxy users can keep
using their current wallet type and signature flow.

| Type               | Deployment                               | Best For                            |
| ------------------ | ---------------------------------------- | ----------------------------------- |
| **Deposit Wallet** | Call `deployDepositWallet()`             | New API users                       |
| **Safe**           | Call `deploy()` before first transaction | Existing Safe integrations          |
| **Proxy**          | Auto-deploys on first transaction        | Existing Polymarket.com proxy users |

<Info>
  For the new deposit wallet flow, including `WALLET-CREATE`, signed `WALLET`
  batches, and `POLY_1271` CLOB orders, see the [Deposit Wallet
  Guide](/trading/deposit-wallets).
</Info>

<CodeGroup>
  ```typescript Safe Wallet (TypeScript) theme={null}
  import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";

  const client = new RelayClient({
    host: "https://relayer-v2.polymarket.com/",
    chain: 137,
    signer: wallet,
    relayerApiKey: process.env.RELAYER_API_KEY!,
    relayerApiKeyAddress: process.env.RELAYER_API_KEY_ADDRESS!,
    txType: RelayerTxType.SAFE,
  });

  // Deploy before first transaction
  const response = await client.deploy();
  const result = await response.wait();
  console.log("Safe Address:", result?.proxyAddress);
  ```

  ```python Safe Wallet (Python) theme={null}
  from py_builder_relayer_client.client import RelayClient

  # client initialized with relayer credentials (see Client Setup above)

  # Deploy before first transaction
  response = client.deploy()
  result = response.wait()
  print("Safe Address:", result.get("proxyAddress"))
  ```

  ```typescript Proxy Wallet (TypeScript) theme={null}
  import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";

  const client = new RelayClient({
    host: "https://relayer-v2.polymarket.com/",
    chain: 137,
    signer: wallet,
    relayerApiKey: process.env.RELAYER_API_KEY!,
    relayerApiKeyAddress: process.env.RELAYER_API_KEY_ADDRESS!,
    txType: RelayerTxType.PROXY,
  });

  // No deploy needed - auto-deploys on first transaction
  ```

  ```python Proxy Wallet (Python) theme={null}
  from py_builder_relayer_client.client import RelayClient

  # client initialized with relayer credentials (see Client Setup above)
  # No deploy needed - auto-deploys on first transaction
  ```
</CodeGroup>

## Executing Transactions

Use the `execute` method to send transactions through the relayer:

```typescript theme={null}
interface Transaction {
  to: string; // Target contract address
  data: string; // Encoded function call
  value: string; // POL to send (usually "0")
}

const response = await client.execute(transactions, "Description");
const result = await response.wait();
```

### Token Approval

Approve contracts to spend tokens:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { encodeFunctionData, maxUint256 } from "viem";

  const pUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
  const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

  const approveTx = {
    to: pUSD,
    data: encodeFunctionData({
      abi: [
        {
          name: "approve",
          type: "function",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ type: "bool" }],
        },
      ],
      functionName: "approve",
      args: [CTF, maxUint256],
    }),
    value: "0",
  };

  const response = await client.execute([approveTx], "Approve pUSD for CTF");
  await response.wait();
  ```

  ```python Python theme={null}
  from web3 import Web3

  pUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB"
  CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
  MAX_UINT256 = 2**256 - 1

  approve_tx = {
      "to": pUSD,
      "data": Web3().eth.contract(
          address=pUSD,
          abi=[{
              "name": "approve",
              "type": "function",
              "inputs": [
                  {"name": "spender", "type": "address"},
                  {"name": "amount", "type": "uint256"}
              ],
              "outputs": [{"type": "bool"}]
          }]
      ).encode_abi(abi_element_identifier="approve", args=[CTF, MAX_UINT256]),
      "value": "0"
  }

  response = client.execute([approve_tx], "Approve pUSD for CTF")
  response.wait()
  ```
</CodeGroup>

### Redeem Positions

Exchange winning tokens for pUSD after market resolution:

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { encodeFunctionData } from "viem";

  const redeemTx = {
    to: CTF_ADDRESS,
    data: encodeFunctionData({
      abi: [
        {
          name: "redeemPositions",
          type: "function",
          inputs: [
            { name: "collateralToken", type: "address" },
            { name: "parentCollectionId", type: "bytes32" },
            { name: "conditionId", type: "bytes32" },
            { name: "indexSets", type: "uint256[]" },
          ],
          outputs: [],
        },
      ],
      functionName: "redeemPositions",
      args: [collateralToken, parentCollectionId, conditionId, indexSets],
    }),
    value: "0",
  };

  const response = await client.execute([redeemTx], "Redeem positions");
  await response.wait();
  ```

  ```python Python theme={null}
  CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"

  redeem_tx = {
      "to": CTF,
      "data": Web3().eth.contract(
          address=CTF,
          abi=[{
              "name": "redeemPositions",
              "type": "function",
              "inputs": [
                  {"name": "collateralToken", "type": "address"},
                  {"name": "parentCollectionId", "type": "bytes32"},
                  {"name": "conditionId", "type": "bytes32"},
                  {"name": "indexSets", "type": "uint256[]"}
              ],
              "outputs": []
          }]
      ).encode_abi(
          abi_element_identifier="redeemPositions",
          args=[collateral_token, parent_collection_id, condition_id, index_sets]
      ),
      "value": "0"
  }

  response = client.execute([redeem_tx], "Redeem positions")
  response.wait()
  ```
</CodeGroup>

### Batch Transactions

Execute multiple operations atomically in a single call:

<CodeGroup>
  ```typescript TypeScript theme={null}
  const approveTx = {
    to: pUSD,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [CTF, maxUint256],
    }),
    value: "0",
  };

  const transferTx = {
    to: pUSD,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [recipientAddress, parseUnits("50", 6)],
    }),
    value: "0",
  };

  // Both execute atomically
  const response = await client.execute(
    [approveTx, transferTx],
    "Approve and transfer",
  );
  await response.wait();
  ```

  ```python Python theme={null}
  approve_tx = {
      "to": pUSD,
      "data": contract.encode_abi(
          abi_element_identifier="approve",
          args=[CTF, MAX_UINT256]
      ),
      "value": "0"
  }

  transfer_tx = {
      "to": pUSD,
      "data": contract.encode_abi(
          abi_element_identifier="transfer",
          args=[recipient_address, 50 * 10**6]
      ),
      "value": "0"
  }

  # Both execute atomically
  response = client.execute([approve_tx, transfer_tx], "Approve and transfer")
  response.wait()
  ```
</CodeGroup>

<Tip>
  Batching reduces latency and ensures all transactions succeed or fail
  together.
</Tip>

## Transaction States

Track transaction progress through these states:

| State             | Terminal | Description                     |
| ----------------- | -------- | ------------------------------- |
| `STATE_NEW`       | No       | Transaction received by relayer |
| `STATE_EXECUTED`  | No       | Submitted onchain               |
| `STATE_MINED`     | No       | Included in a block             |
| `STATE_CONFIRMED` | Yes      | Finalized successfully          |
| `STATE_FAILED`    | Yes      | Failed permanently              |
| `STATE_INVALID`   | Yes      | Rejected as invalid             |

## Contract Addresses

See [Contracts](/resources/contracts) for all Polymarket smart contract addresses on Polygon.

## Resources

* [Builder Relayer Client (TypeScript)](https://github.com/Polymarket/builder-relayer-client)
* [Builder Relayer Client (Python)](https://github.com/Polymarket/py-builder-relayer-client)

## Next Steps

<CardGroup cols={2}>
  <Card title="Negative Risk Markets" icon="scale-balanced" href="/advanced/neg-risk">
    Learn about capital-efficient trading for multi-outcome events.
  </Card>

  <Card title="Positions & Tokens" icon="coins" href="/concepts/positions-tokens">
    Understand token operations like split, merge, and redeem.
  </Card>
</CardGroup>
