> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Quickstart

> Place your first order on Polymarket

This guide walks you through placing an order on Polymarket end-to-end.

<Steps>
  <Step title="Install the SDK">
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
  </Step>

  <Step title="Set Up Your Client">
    Derive your API credentials and initialize the trading client. This example uses
    a deposit wallet with signature type `3` (`POLY_1271`), which is the wallet path
    for new API users:

    <CodeGroup>
      ```typescript TypeScript theme={null}
      import { ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
      import { createWalletClient, http } from "viem";
      import { privateKeyToAccount } from "viem/accounts";

      const HOST = "https://clob.polymarket.com";
      const CHAIN_ID = 137; // Polygon mainnet
      const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
      const signer = createWalletClient({ account, transport: http() });
      const depositWalletAddress = process.env.DEPOSIT_WALLET_ADDRESS!;

      // Derive API credentials
      const tempClient = new ClobClient({ host: HOST, chain: CHAIN_ID, signer });
      const apiCreds = await tempClient.createOrDeriveApiKey();

      // Initialize trading client
      const client = new ClobClient({
        host: HOST,
        chain: CHAIN_ID,
        signer,
        creds: apiCreds,
        signatureType: SignatureTypeV2.POLY_1271,
        funderAddress: depositWalletAddress,
      });
      ```

      ```python Python theme={null}
      from py_clob_client_v2 import ClobClient, SignatureTypeV2
      import os

      host = "https://clob.polymarket.com"
      chain = 137  # Polygon mainnet
      private_key = os.getenv("PRIVATE_KEY")
      deposit_wallet_address = os.getenv("DEPOSIT_WALLET_ADDRESS")

      # Derive API credentials
      temp_client = ClobClient(host, key=private_key, chain_id=chain)
      api_creds = temp_client.create_or_derive_api_key()

      # Initialize trading client
      client = ClobClient(
          host,
          key=private_key,
          chain_id=chain,
          creds=api_creds,
          signature_type=SignatureTypeV2.POLY_1271,
          funder=deposit_wallet_address
      )
      ```

      ```rust Rust theme={null}
      use std::str::FromStr;
      use polymarket_client_sdk_v2::POLYGON;
      use polymarket_client_sdk_v2::auth::{LocalSigner, Signer};
      use polymarket_client_sdk_v2::clob::types::SignatureType;
      use polymarket_client_sdk_v2::clob::{Client, Config};

      let private_key = std::env::var("POLYMARKET_PRIVATE_KEY")?;
      let signer = LocalSigner::from_str(&private_key)?
          .with_chain_id(Some(POLYGON));
      let deposit_wallet = std::env::var("DEPOSIT_WALLET_ADDRESS")?.parse()?;

      // Derive API credentials and initialize client
      let client = Client::new("https://clob.polymarket.com", Config::default())?
          .authentication_builder(&signer)
          .funder(deposit_wallet)
          .signature_type(SignatureType::Poly1271)
          .authenticate()
          .await?;
      ```
    </CodeGroup>

    <Note>
      Existing EOA, Safe, and Proxy integrations can keep using their current
      signature type and funder address. See [Signature
      Types](/trading/overview#signature-types) for all wallet types.
    </Note>

    <Warning>
      Before trading from a deposit wallet, the deposit wallet needs **pUSD** and
      the required trading approvals. See the [Deposit Wallet
      Guide](/trading/deposit-wallets) for wallet creation, funding, approvals, and
      balance sync.
    </Warning>
  </Step>

  <Step title="Place an Order">
    Get a token ID from the [Markets API](/market-data/fetching-markets), then create and submit your order:

    <CodeGroup>
      ```typescript TypeScript theme={null}
      import { Side, OrderType } from "@polymarket/clob-client-v2";

      const response = await client.createAndPostOrder(
        {
          tokenID: "YOUR_TOKEN_ID",
          price: 0.5,
          size: 10,
          side: Side.BUY,
        },
        {
          tickSize: "0.01",
          negRisk: false, // Set to true for multi-outcome markets
        },
        OrderType.GTC,
      );

      console.log("Order ID:", response.orderID);
      console.log("Status:", response.status);
      ```

      ```python Python theme={null}
      from py_clob_client_v2 import OrderArgs, OrderType, PartialCreateOrderOptions
      from py_clob_client_v2.order_builder.constants import BUY

      response = client.create_and_post_order(
          OrderArgs(
              token_id="YOUR_TOKEN_ID",
              price=0.50,
              size=10,
              side=BUY,
          ),
          options=PartialCreateOrderOptions(
              tick_size="0.01",
              neg_risk=False,  # Set to True for multi-outcome markets
          ),
          order_type=OrderType.GTC
      )

      print("Order ID:", response["orderID"])
      print("Status:", response["status"])
      ```

      ```rust Rust theme={null}
      use polymarket_client_sdk_v2::clob::types::Side;
      use polymarket_client_sdk_v2::types::dec;

      let token_id = "YOUR_TOKEN_ID".parse()?;

      // Tick size and neg risk are auto-fetched by the order builder
      let order = client
          .limit_order()
          .token_id(token_id)
          .price(dec!(0.50))
          .size(dec!(10))
          .side(Side::Buy)
          .build()
          .await?;
      let signed_order = client.sign(&signer, order).await?;
      let response = client.post_order(signed_order).await?;

      println!("Order ID: {}", response.order_id);
      println!("Status: {:?}", response.status);
      ```
    </CodeGroup>

    <Tip>
      Look up a market's `tickSize` and `negRisk` values using the SDK's
      `getTickSize()` and `getNegRisk()` methods, or from the market object returned
      by the API.
    </Tip>
  </Step>

  <Step title="Check Your Orders">
    <CodeGroup>
      ```typescript TypeScript theme={null}
      // View all open orders
      const openOrders = await client.getOpenOrders();
      console.log(`You have ${openOrders.length} open orders`);

      // View your trade history
      const trades = await client.getTrades();
      console.log(`You've made ${trades.length} trades`);

      // Cancel an order
      await client.cancelOrder(response.orderID);
      ```

      ```python Python theme={null}
      # View all open orders
      open_orders = client.get_orders()
      print(f"You have {len(open_orders)} open orders")

      # View your trade history
      trades = client.get_trades()
      print(f"You've made {len(trades)} trades")

      # Cancel an order
      client.cancel(order_id=response["orderID"])
      ```

      ```rust Rust theme={null}
      use polymarket_client_sdk_v2::clob::types::request::{OrdersRequest, TradesRequest};

      // View all open orders
      let open_orders = client.orders(&OrdersRequest::default(), None).await?;
      println!("You have {} open orders", open_orders.data.len());

      // View your trade history
      let trades = client.trades(&TradesRequest::default(), None).await?;
      println!("You've made {} trades", trades.data.len());

      // Cancel an order
      client.cancel_order(&response.order_id).await?;
      ```
    </CodeGroup>
  </Step>
</Steps>

***

## Troubleshooting

<AccordionGroup>
  <Accordion title="L2 AUTH NOT AVAILABLE - Invalid Signature">
    Wrong private key, signature type, or funder address for the derived API credentials.

    * Check that `signatureType` matches your account type (`0`, `1`, `2`, or `3`)
    * Ensure `funder` is correct for your wallet type
    * Re-derive credentials with `createOrDeriveApiKey()` if unsure
  </Accordion>

  <Accordion title="Order rejected - insufficient balance">
    Your funder address doesn't have enough tokens:

    * **BUY orders**: need pUSD in your funder address
    * **SELL orders**: need outcome tokens in your funder address
    * Ensure you have more pUSD than what's committed in open orders
  </Accordion>

  <Accordion title="Order rejected - insufficient allowance">
    You need to approve the Exchange contract to spend your tokens. Deposit wallet
    approvals must be executed from the deposit wallet through a relayer `WALLET`
    batch. Existing Safe and Proxy users should use their current relayer approval
    flow.
  </Accordion>

  <Accordion title="What is my funder address">
    Your funder address is the wallet where your funds are held:

    * **EOA (type 0)**: Your wallet address directly
    * **Deposit wallet (type 3)**: The deposit wallet deployed for the owner or session signer
    * **Proxy/Safe wallet (type 1 or 2)**: Existing Polymarket.com wallet address

    New API users should create a deposit wallet. Existing Proxy and Safe users
    can continue using their current wallet address.
  </Accordion>

  <Accordion title="Blocked by Cloudflare or Geoblock">
    You're trying to place a trade from a restricted region. See [Geographic Restrictions](/api-reference/geoblock) for details.
  </Accordion>
</AccordionGroup>

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Create Orders" icon="plus" href="/trading/orders/create">
    Order types, tick sizes, and error handling
  </Card>

  <Card title="Order Attribution" icon="tag" href="/trading/orders/attribution">
    Attribute orders to your builder account for volume credit
  </Card>
</CardGroup>
