> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Getting Started

> One-time setup for market making on Polymarket

Before you can start market making, you need to complete these one-time setup steps — deposit pUSD to Polygon, deploy a wallet, approve tokens for trading, and generate API credentials.

<Steps>
  <Step title="Deposit pUSD">
    Market makers need pUSD on Polygon to fund their trading operations.

    | Method                  | Best For                             | Documentation                                        |
    | ----------------------- | ------------------------------------ | ---------------------------------------------------- |
    | Bridge API              | Automated deposits from other chains | [Bridge Deposit](/trading/bridge/deposit)            |
    | Direct Polygon transfer | Already have pUSD on Polygon         | N/A                                                  |
    | Cross-chain bridge      | Large deposits from Ethereum         | [Supported Assets](/trading/bridge/supported-assets) |

    ### Using the Bridge API

    ```typescript theme={null}
    // Get deposit addresses for your Polymarket wallet
    const deposit = await fetch("https://bridge.polymarket.com/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "YOUR_POLYMARKET_WALLET_ADDRESS",
      }),
    });

    // Returns deposit addresses for EVM, SVM, and BTC networks
    const addresses = await deposit.json();
    // Send USDC to the appropriate address for your source chain
    ```
  </Step>

  <Step title="Deploy a Wallet">
    ### EOA

    Standard Ethereum wallet. You pay for all onchain transactions (approvals, splits, merges, trade execution).

    ### Deposit Wallet

    Deposit wallets are the recommended wallet path for new API users. They are
    deployed through Polymarket's relayer and use `POLY_1271` order signatures.

    See the [Deposit Wallet Guide](/trading/deposit-wallets) for the
    wallet creation, approval, balance sync, and order-signing flow.

    ### Existing Safe Wallets

    Existing Gnosis Safe users can continue using their current wallet. Safe wallets
    are deployed via Polymarket's relayer and support:

    * **Gasless transactions** — Polymarket pays gas fees for onchain operations
    * **Contract wallet** — Enables advanced features like batched transactions

    For existing Safe integrations, deploy a Safe wallet using the Relayer Client:

    <CodeGroup>
      ```typescript TypeScript theme={null}
      import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";

      const client = new RelayClient({
        host: "https://relayer-v2.polymarket.com/",
        chain: 137,
        signer,
        relayerApiKey: process.env.RELAYER_API_KEY!,
        relayerApiKeyAddress: process.env.RELAYER_API_KEY_ADDRESS!,
        txType: RelayerTxType.SAFE,
      });

      // Deploy the Safe wallet
      const response = await client.deploy();
      const result = await response.wait();
      console.log("Safe Address:", result?.proxyAddress);
      ```

      ```python Python theme={null}
      from py_builder_relayer_client.client import RelayClient

      # client initialized with Relayer API Key credentials (see Gasless Transactions)

      # Deploy the Safe wallet
      response = client.deploy()
      result = response.wait()
      print("Safe Address:", result.get("proxyAddress"))
      ```
    </CodeGroup>

    <Info>
      See [Gasless Transactions](/trading/gasless) for full Relayer Client setup
      including local and remote signing configurations.
    </Info>
  </Step>

  <Step title="Approve Tokens">
    Before trading, you must approve the exchange contracts to spend your tokens.

    ### Required Approvals

    | Token                | Spender               | Purpose                        |
    | -------------------- | --------------------- | ------------------------------ |
    | pUSD                 | CTF Contract          | Split pUSD into outcome tokens |
    | CTF (outcome tokens) | CTF Exchange          | Trade outcome tokens           |
    | CTF (outcome tokens) | Neg Risk CTF Exchange | Trade neg-risk market tokens   |

    ### Contract Addresses

    ```typescript theme={null}
    const ADDRESSES = {
      pUSD: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
      CTF: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
      CTF_EXCHANGE: "0xE111180000d2663C0091e4f400237545B87B996B",
      NEG_RISK_CTF_EXCHANGE: "0xe2222d279d744050d28e00520010520000310F59",
      NEG_RISK_ADAPTER: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
    };
    ```

    ### Approve via Relayer Client

    <CodeGroup>
      ```typescript TypeScript theme={null}
      import { ethers } from "ethers";
      import { Interface } from "ethers/lib/utils";

      const erc20Interface = new Interface([
        "function approve(address spender, uint256 amount) returns (bool)",
      ]);

      // Approve pUSD for CTF contract
      const approveTx = {
        to: ADDRESSES.pUSD,
        data: erc20Interface.encodeFunctionData("approve", [
          ADDRESSES.CTF,
          ethers.constants.MaxUint256,
        ]),
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
  </Step>

  <Step title="Generate API Credentials">
    To place orders and access authenticated endpoints, you need L2 API credentials derived from your wallet.

    <CodeGroup>
      ```typescript TypeScript theme={null}
      import { ClobClient } from "@polymarket/clob-client-v2";

      const client = new ClobClient({
        host: "https://clob.polymarket.com",
        chain: 137,
        signer,
      });

      // Derive API credentials from your wallet
      const credentials = await client.createOrDeriveApiKey();
      console.log("API Key:", credentials.key);
      console.log("Secret:", credentials.secret);
      console.log("Passphrase:", credentials.passphrase);
      ```

      ```python Python theme={null}
      from py_clob_client_v2 import ClobClient
      import os

      private_key = os.getenv("PRIVATE_KEY")

      temp_client = ClobClient("https://clob.polymarket.com", key=private_key, chain_id=137)
      credentials = temp_client.create_or_derive_api_key()
      ```

      ```rust Rust theme={null}
      use std::str::FromStr;
      use polymarket_client_sdk_v2::POLYGON;
      use polymarket_client_sdk_v2::auth::{LocalSigner, Signer};
      use polymarket_client_sdk_v2::clob::{Client, Config};

      let private_key = std::env::var("POLYMARKET_PRIVATE_KEY")?;
      let signer = LocalSigner::from_str(&private_key)?
          .with_chain_id(Some(POLYGON));

      // The Rust SDK derives credentials and initializes in one step
      let client = Client::new("https://clob.polymarket.com", Config::default())?
          .authentication_builder(&signer)
          .authenticate()
          .await?;
      ```
    </CodeGroup>

    See [Authentication](/trading/overview#authentication) for full details on signature types and REST API headers.
  </Step>
</Steps>

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Trading" icon="chart-line" href="/market-makers/trading">
    Post limit orders and manage quotes
  </Card>

  <Card title="Market Data" icon="database" href="/market-data/overview">
    Connect to real-time market data
  </Card>
</CardGroup>
