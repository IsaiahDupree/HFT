> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# TypeScript SDK

> Build with the unified Polymarket TypeScript SDK.

The unified TypeScript SDK gives you a consistent surface across Polymarket discovery, market data, trading, account data, and realtime streams.

<Note>
  The TypeScript SDK is currently in beta. We are keeping it in this beta phase
  while we address issues and harden the SDK before transitioning to a more
  stable release.
</Note>

## Quickstart

<Steps>
  <Step title="Install the Package">
    Install the SDK from your package manager.

    <CodeGroup>
      ```bash pnpm theme={null}
      pnpm add @polymarket/client@beta
      ```

      ```bash npm theme={null}
      npm install @polymarket/client@beta
      ```

      ```bash yarn theme={null}
      yarn add @polymarket/client@beta
      ```
    </CodeGroup>
  </Step>

  <Step title="Create a Public Client">
    Create an instance of the `PublicClient`.

    ```ts theme={null}
    import { createPublicClient } from "@polymarket/client";

    const client = createPublicClient();
    ```
  </Step>

  <Step title="Fetch Markets">
    Fetch a page of markets to discover active trading opportunities.

    ```ts theme={null}
    const markets = client.listMarkets({
      closed: false,
      pageSize: 5,
    });

    const firstPage = await markets.firstPage();

    for (const market of firstPage.items) {
      // market: Market
    }
    ```
  </Step>
</Steps>

## SDK Patterns

The SDK normalizes data across API seams and uses consistent patterns for pagination and typed error handling across public and authenticated workflows.

### Typed Primitives

Common primitives such as IDs, decimal values, date/time strings, and EVM addresses are represented with explicit SDK types so integrations can avoid treating every value as a plain string.

```ts theme={null}
type Market = {
  id: MarketId;
  conditionId: ConditionId | null;
  state: {
    startDate?: IsoDateTimeString | null;
    endDate?: IsoDateTimeString | null;
  };
  outcomes: {
    yes: {
      tokenId: TokenId | null;
      price: DecimalString | null;
    };
  };
  resolution: {
    resolvedBy: EvmAddress | null;
  };
  // …
};
```

### Market and Event Data

Market and event responses use normalized field names and TypeScript shapes instead of service-specific response formats.

<CodeGroup>
  ```ts Market theme={null}
  type Market = {
    id: MarketId;
    slug?: string | null;
    conditionId: ConditionId | null;
    question?: string | null;
    description?: string | null;
    category?: string | null;
    image?: string | null;
    icon?: string | null;
    state: MarketState;
    outcomes: MarketOutcomes;
    metrics: MarketMetrics;
    prices: MarketPrices;
    trading: MarketTrading;
    resolution: MarketResolution;
    rewards: MarketRewards;
    sports: MarketSportsMetadata;
    tags: MarketTag[];
    // …
  };
  ```

  ```ts Event theme={null}
  type Event = {
    id: EventId;
    slug?: string | null;
    title?: string | null;
    subtitle?: string | null;
    description?: string | null;
    category?: string | null;
    subcategory?: string | null;
    image?: string | null;
    icon?: string | null;
    createdAt?: IsoDateTimeString | null;
    updatedAt?: IsoDateTimeString | null;
    publishedAt?: IsoDateTimeString | null;
    state: EventState;
    schedule: EventSchedule;
    metrics: EventMetrics;
    trading: EventTrading;
    estimation: EventEstimation;
    sports: EventSportsMetadata;
    partners: EventPartner[];
    markets: Market[];
    series: EventSeries[];
    // …
  };
  ```
</CodeGroup>

### Pagination

List methods return a consistent paginator interface across paginated endpoints. Use `for await` to iterate through pages.

```ts theme={null}
const markets = client.listMarkets({
  closed: false,
  pageSize: 10,
});

for await (const page of markets) {
  // page.items: Market[]
}
```

You can also fetch the first page directly and resume later from a cursor.

```ts theme={null}
const firstPage = await markets.firstPage();
// firstPage.items: Market[]

for await (const page of markets.from(firstPage.nextCursor)) {
  // page.items: Market[]
}
```

### Error Handling

Each public action exposes a matching error guard. Use it to handle expected SDK errors and rethrow anything unexpected.

<Note>
  Error guards make exhaustive checks easier and help surface newly added SDK
  error cases during upgrades.
</Note>

```ts theme={null}
import { ListMarketsError } from "@polymarket/client";

try {
  const markets = client.listMarkets({
    closed: false,
    pageSize: 10,
  });

  const firstPage = await markets.firstPage();
  // firstPage.items: Market[]
} catch (error) {
  if (!ListMarketsError.isError(error)) {
    throw error;
  }

  switch (error.name) {
    case "RateLimitError":
      // Retry later.
      break;
    case "UserInputError":
      // Fix the request parameters.
      break;
    default:
    // …
  }
}
```

## Market Data

Use market data methods to fetch market and event details, order books, current prices, historical prices, and batch quotes.

<CodeGroup>
  ```ts Market theme={null}
  const market = await client.fetchMarket({
    url: "https://polymarket.com/market/eth-flipped-in-2026",
  });

  const market = await client.fetchMarket({
    slug: "eth-flipped-in-2026",
  });

  const market = await client.fetchMarket({
    id: "12345",
  });
  ```

  ```ts Event theme={null}
  const event = await client.fetchEvent({
    url: "https://polymarket.com/event/presidential-election-2028",
  });

  const event = await client.fetchEvent({
    slug: "presidential-election-2028",
  });

  const event = await client.fetchEvent({
    id: "12345",
  });
  ```
</CodeGroup>

Then fetch related tags, order books, prices, and history.

<CodeGroup>
  ```ts Tags theme={null}
  const marketTags = await client.fetchMarketTags({
    id: market.id,
  });

  const eventTags = await client.fetchEventTags({
    id: event.id,
  });
  ```

  ```ts Order Book theme={null}
  const book = await client.fetchOrderBook({
    tokenId: market.outcomes.yes.tokenId!,
  });
  ```

  ```ts Prices theme={null}
  import { OrderSide } from "@polymarket/client";

  const buyPrice = await client.fetchPrice({
    tokenId: market.outcomes.yes.tokenId!,
    side: OrderSide.BUY,
  });

  const midpoint = await client.fetchMidpoint({
    tokenId: market.outcomes.yes.tokenId!,
  });

  const spread = await client.fetchSpread({
    tokenId: market.outcomes.yes.tokenId!,
  });

  const lastTrade = await client.fetchLastTradePrice({
    tokenId: market.outcomes.yes.tokenId!,
  });
  ```

  ```ts History theme={null}
  const history = await client.fetchPriceHistory({
    tokenId: market.outcomes.yes.tokenId!,
    interval: "1d",
  });
  ```

  ```ts Batch Reads theme={null}
  import { OrderSide } from "@polymarket/client";

  const prices = await client.fetchPrices([
    {
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.BUY,
    },
    {
      tokenId: market.outcomes.no.tokenId!,
      side: OrderSide.BUY,
    },
  ]);

  const midpoints = await client.fetchMidpoints([
    {
      tokenId: market.outcomes.yes.tokenId!,
    },
    {
      tokenId: market.outcomes.no.tokenId!,
    },
  ]);
  ```
</CodeGroup>

## Discovery

Use discovery methods to browse events, markets, teams, tags, comments, sports metadata, and search results. The examples below show a few common entry points.

<Tabs>
  <Tab title="Events">
    ```ts theme={null}
    const events = client.listEvents({
      pageSize: 10,
    });

    for await (const page of events) {
      // page.items: Event[]
    }
    ```
  </Tab>

  <Tab title="Markets">
    ```ts theme={null}
    const markets = client.listMarkets({
      closed: false,
      pageSize: 10,
    });

    for await (const page of markets) {
      // page.items: Market[]
    }
    ```
  </Tab>

  <Tab title="Teams">
    ```ts theme={null}
    const teams = client.listTeams({
      league: ["NBA"],
      pageSize: 10,
    });

    for await (const page of teams) {
      // page.items: Team[]
    }
    ```
  </Tab>

  <Tab title="Tags">
    ```ts theme={null}
    const tags = client.listTags({
      pageSize: 10,
    });

    for await (const page of tags) {
      // page.items: Tag[]
    }

    const tag = await client.fetchTag({
      slug: "politics",
    });

    const relatedTags = await client.fetchRelatedTags({
      slug: "politics",
    });

    const relatedResources = await client.fetchRelatedTagResources({
      slug: "politics",
      status: "active",
    });
    ```
  </Tab>

  <Tab title="Comments">
    ```ts theme={null}
    const comments = client.listComments({
      parentEntityId: "12345",
      parentEntityType: "Event",
      pageSize: 20,
    });

    for await (const page of comments) {
      // page.items: Comment[]
    }

    const thread = await client.fetchCommentsById({
      id: "456",
      getPositions: true,
    });

    const userComments = client.listCommentsByUserAddress({
      address: "0x1234...",
      pageSize: 10,
      order: "DESC",
    });

    for await (const page of userComments) {
      // page.items: Comment[]
    }
    ```
  </Tab>

  <Tab title="Sports">
    ```ts theme={null}
    const sports = await client.listSports();

    // sports: SportsMetadata[]
    ```
  </Tab>

  <Tab title="Search">
    ```ts theme={null}
    const results = client.search({
      q: "ethereum",
      pageSize: 10,
    });

    for await (const page of results) {
      // page.items.events: Event[]
      // page.items.tags: SearchTag[]
      // page.items.profiles: Profile[]
    }
    ```
  </Tab>
</Tabs>

## Realtime Streams

Subscribe through one SDK interface even when events are served by different websocket surfaces. The SDK routes each subscription spec to the right stream and merges the results into one stream.

```ts theme={null}
const stream = await client.subscribe([
  {
    topic: "market",
    tokenIds: [market.outcomes.yes.tokenId!],
  },
  {
    topic: "prices.crypto.binance",
    symbols: ["btcusdt"],
  },
]);

for await (const event of stream) {
  // event:
  //   | MarketBookEvent
  //   | MarketPriceChangeEvent
  //   | MarketLastTradePriceEvent
  //   | MarketTickSizeChangeEvent
  //   | CryptoPricesBinanceEvent

  if (shouldStopStreaming()) {
    await stream.close();
  }
}
```

## Authenticated Client

Create a secure client when you need wallet-scoped reads or trading.

### Wallet Integrations

The SDK is intended to support a variety of wallet libraries. At launch, we support [Viem](https://viem.sh), [Privy](https://www.privy.io/docs), and [Ethers v5](https://docs.ethers.org/v5/). We will expand support for more libraries based on demand.

<Tabs>
  <Tab title="Viem">
    <Steps>
      <Step title="Install the Packages">
        Install the SDK and Viem wallet tools.

        ```bash theme={null}
        pnpm add @polymarket/client@beta viem
        ```
      </Step>

      <Step title="Create the Secure Client">
        Use the private-key helper, or adapt an existing `viem` wallet client.

        <CodeGroup>
          ```ts Private Key theme={null}
          import { createSecureClient } from "@polymarket/client";
          import { privateKey } from "@polymarket/client/viem";

          const secureClient = await createSecureClient({
            wallet: "YOUR_POLYMARKET_WALLET_ADDRESS",
            signer: privateKey(process.env.PRIVATE_KEY),
          });
          ```

          ```ts Wallet Client theme={null}
          import { createSecureClient } from "@polymarket/client";
          import { signerFrom } from "@polymarket/client/viem";
          import { createWalletClient, http } from "viem";
          import { privateKeyToAccount } from "viem/accounts";
          import { polygon } from "viem/chains";

          const walletClient = createWalletClient({
            account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
            chain: polygon,
            transport: http(),
          });

          const secureClient = await createSecureClient({
            wallet: "YOUR_POLYMARKET_WALLET_ADDRESS",
            signer: signerFrom(walletClient),
          });
          ```
        </CodeGroup>
      </Step>
    </Steps>
  </Tab>

  <Tab title="Privy">
    <Steps>
      <Step title="Install the Packages">
        Install the SDK and Privy Node client.

        ```bash theme={null}
        pnpm add @polymarket/client@beta @privy-io/node
        ```
      </Step>

      <Step title="Create the Secure Client">
        Use the Privy Node client with the SDK's Privy signer adapter.

        ```ts theme={null}
        import { createSecureClient } from "@polymarket/client";
        import { signerFrom } from "@polymarket/client/privy";
        import { PrivyClient } from "@privy-io/node";

        const privy = new PrivyClient({
          appId: process.env.PRIVY_APP_ID!,
          appSecret: process.env.PRIVY_APP_SECRET!,
        });

        const secureClient = await createSecureClient({
          wallet: "YOUR_POLYMARKET_WALLET_ADDRESS",
          signer: signerFrom({
            privy,
            walletId: process.env.PRIVY_WALLET_ID!,
          }),
        });
        ```
      </Step>
    </Steps>
  </Tab>

  <Tab title="Ethers v5">
    <Steps>
      <Step title="Install the Packages">
        Install the SDK and the Ethers v5 package alias used by the adapter.

        ```bash theme={null}
        pnpm add @polymarket/client@beta ethers-v5@npm:ethers@^5.8.0
        ```
      </Step>

      <Step title="Create the Secure Client">
        Use the Ethers v5 signer adapter when your integration already manages an `ethers.Signer`.

        ```ts theme={null}
        import { createSecureClient } from "@polymarket/client";
        import { signerFrom } from "@polymarket/client/ethers-v5";
        import { ethers } from "ethers-v5";

        const provider = new ethers.providers.JsonRpcProvider(
          process.env.POLYGON_RPC_URL,
        );
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

        const secureClient = await createSecureClient({
          wallet: "YOUR_POLYMARKET_WALLET_ADDRESS",
          signer: signerFrom(wallet),
        });
        ```
      </Step>
    </Steps>
  </Tab>
</Tabs>

### Trading Setup

Before placing orders, configure API key authentication if you need gasless wallet setup, then make sure the authenticated wallet has the required trading approvals.

<Steps>
  <Step title="Configure API Key Authentication">
    Configure an API key when the SDK needs to set up gasless wallet operations.

    <CodeGroup>
      ```ts Relayer API Key theme={null}
      import { createSecureClient, relayerApiKey } from "@polymarket/client";

      let secureClient = await createSecureClient({
        wallet: "YOUR_POLYMARKET_WALLET_ADDRESS",
        signer,
        apiKey: relayerApiKey({
          key: process.env.RELAYER_API_KEY!,
          address: process.env.RELAYER_API_KEY_ADDRESS!,
        }),
      });
      ```

      ```ts Builder API Key theme={null}
      import { createSecureClient } from "@polymarket/client";
      import { builderApiKey } from "@polymarket/client/node";

      let secureClient = await createSecureClient({
        wallet: "YOUR_POLYMARKET_WALLET_ADDRESS",
        signer,
        apiKey: builderApiKey({
          key: process.env.BUILDER_API_KEY!,
          secret: process.env.BUILDER_SECRET!,
          passphrase: process.env.BUILDER_PASSPHRASE!,
        }),
      });
      ```
    </CodeGroup>

    <Note>
      Builder API keys are supported for backwards compatibility with builders that
      still use them for gasless workflows. They are not used for order attribution.
      Use `builderCode` on orders for attribution.
    </Note>
  </Step>

  <Step title="Check Gasless Readiness">
    Check whether the authenticated wallet is already ready for gasless transactions.

    ```ts theme={null}
    const isGaslessReady = await secureClient.isGaslessReady();
    ```
  </Step>

  <Step title="Set Up Gasless Wallet">
    If needed, set up the gasless wallet and continue with the returned secure client.

    ```ts theme={null}
    if (!isGaslessReady) {
      secureClient = await secureClient.setupGaslessWallet();
    }
    ```
  </Step>

  <Step title="Set Up Trading Approvals">
    Set up the approvals required for trading and wait for the setup transaction to complete.

    ```ts theme={null}
    const handle = await secureClient.setupTradingApprovals();
    await handle.wait();
    ```
  </Step>
</Steps>

### Trading

Use a secure client to create, sign, and submit orders. Limit orders specify the price and size you want to trade. Market orders execute against resting liquidity immediately.

Order placement returns a discriminated response. Check `response.ok` before reading order details.

#### Place Orders

<Tabs>
  <Tab title="Limit Order">
    ```ts theme={null}
    import { OrderSide } from "@polymarket/client";

    const response = await secureClient.placeLimitOrder({
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.BUY,
      price: 0.52,
      size: 10,
    });

    if (response.ok) {
      // response.orderId: string
    } else {
      // response.code: OrderResponseErrorCode
      // response.message: string
    }
    ```
  </Tab>

  <Tab title="Expiring Limit Order">
    ```ts theme={null}
    import { OrderSide } from "@polymarket/client";

    const response = await secureClient.placeLimitOrder({
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.SELL,
      price: 0.52,
      size: 10,
      expiration: Math.floor(Date.now() / 1000) + 60 * 60,
    });

    if (response.ok) {
      // response.orderId: string
    } else {
      // response.code: OrderResponseErrorCode
      // response.message: string
    }
    ```
  </Tab>

  <Tab title="Partial-Fill Market Order">
    ```ts theme={null}
    import { OrderSide, OrderType } from "@polymarket/client";

    const response = await secureClient.placeMarketOrder({
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.BUY,
      amount: 10,
      maxSpend: 11,
      orderType: OrderType.FAK,
    });

    if (response.ok) {
      // response.orderId: string
    } else {
      // response.code: OrderResponseErrorCode
      // response.message: string
    }
    ```
  </Tab>

  <Tab title="All-Or-Nothing Market Order">
    ```ts theme={null}
    import { OrderSide, OrderType } from "@polymarket/client";

    const response = await secureClient.placeMarketOrder({
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.SELL,
      shares: 10,
      orderType: OrderType.FOK,
    });

    if (response.ok) {
      // response.orderId: string
    } else {
      // response.code: OrderResponseErrorCode
      // response.message: string
    }
    ```
  </Tab>

  <Tab title="Builder Code">
    ```ts theme={null}
    import { OrderSide } from "@polymarket/client";

    const response = await secureClient.placeLimitOrder({
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.BUY,
      price: 0.52,
      size: 10,
      builderCode: "0xabc123...",
    });

    if (response.ok) {
      // response.orderId: string
    } else {
      // response.code: OrderResponseErrorCode
      // response.message: string
    }
    ```
  </Tab>
</Tabs>

#### Create, Then Post

Create signed orders separately when you want to review, store, or batch them before submitting.

<Tabs>
  <Tab title="Single Order">
    ```ts theme={null}
    import { OrderSide } from "@polymarket/client";

    const order = await secureClient.createLimitOrder({
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.BUY,
      price: 0.52,
      size: 10,
    });

    const response = await secureClient.postOrder(order);

    if (response.ok) {
      // response.orderId: string
    } else {
      // response.code: OrderResponseErrorCode
      // response.message: string
    }
    ```
  </Tab>

  <Tab title="Batch Orders">
    ```ts theme={null}
    import { OrderSide } from "@polymarket/client";

    const firstOrder = await secureClient.createLimitOrder({
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.BUY,
      price: 0.52,
      size: 10,
    });

    const secondOrder = await secureClient.createLimitOrder({
      tokenId: market.outcomes.yes.tokenId!,
      side: OrderSide.SELL,
      price: 0.58,
      size: 5,
    });

    const responses = await secureClient.postOrders([firstOrder, secondOrder]);

    for (const response of responses) {
      if (response.ok) {
        // response.orderId: string
      } else {
        // response.code: OrderResponseErrorCode
        // response.message: string
      }
    }
    ```
  </Tab>
</Tabs>

### Position Lifecycle

Use position lifecycle methods to split collateral into outcome tokens, merge complete sets back into collateral, or redeem resolved positions. These examples assume the secure client is configured with API key authentication as shown in [Trading Setup](#trading-setup).

<Tabs>
  <Tab title="Split Position">
    ```ts theme={null}
    const handle = await secureClient.splitPosition({
      conditionId: market.conditionId!,
      amount: 1n,
    });

    const outcome = await handle.wait();

    // outcome.transactionHash: TxHash
    ```
  </Tab>

  <Tab title="Merge Positions">
    ```ts theme={null}
    const handle = await secureClient.mergePositions({
      conditionId: market.conditionId!,
      amount: "max",
    });

    const outcome = await handle.wait();

    // outcome.transactionHash: TxHash
    ```
  </Tab>

  <Tab title="Redeem Positions">
    ```ts theme={null}
    const handle = await secureClient.redeemPositions({
      marketId: market.id,
    });

    const outcome = await handle.wait();

    // outcome.transactionHash: TxHash
    ```
  </Tab>
</Tabs>

### Wallet Operations

Use wallet operation methods for direct token movements from the authenticated wallet. These examples assume the secure client is configured with API key authentication as shown in [Trading Setup](#trading-setup).

```ts theme={null}
const handle = await secureClient.transferErc20({
  amount: 1n,
  recipientAddress: "RECIPIENT_ADDRESS",
  tokenAddress: secureClient.environment.collateralToken,
});

const outcome = await handle.wait();

// outcome.transactionHash: TxHash
```

### Order Management

Manage open orders for the authenticated wallet after placement. These examples assume `orderId` comes from an accepted order response.

<Tabs>
  <Tab title="Fetch Order">
    ```ts theme={null}
    const order = await secureClient.fetchOrder({
      orderId,
    });

    // order: OpenOrder
    ```
  </Tab>

  <Tab title="List Open Orders">
    ```ts theme={null}
    const openOrders = secureClient.listOpenOrders({
      market: market.id, // Or market.conditionId
    });

    for await (const page of openOrders) {
      // page.items: OpenOrder[]
    }
    ```
  </Tab>

  <Tab title="Cancel Order">
    ```ts theme={null}
    const response = await secureClient.cancelOrder({
      orderId,
    });

    // response.canceled: string[]
    ```
  </Tab>

  <Tab title="Cancel Market Orders">
    ```ts theme={null}
    const response = await secureClient.cancelMarketOrders({
      tokenId: market.outcomes.yes.tokenId!,
    });

    // response.canceled: string[]
    ```
  </Tab>
</Tabs>

### Rewards and Scoring

Use rewards methods to inspect active reward programs and scoring methods to check whether orders are eligible for scoring.

<Tabs>
  <Tab title="Current Rewards">
    ```ts theme={null}
    const rewards = client.listCurrentRewards();

    for await (const page of rewards) {
      // page.items: CurrentReward[]
    }
    ```
  </Tab>

  <Tab title="Market Rewards">
    ```ts theme={null}
    const rewards = client.listMarketRewards({
      conditionId: market.conditionId!,
    });

    for await (const page of rewards) {
      // page.items: MarketReward[]
    }
    ```
  </Tab>

  <Tab title="Order Scoring">
    ```ts theme={null}
    const scoring = await secureClient.fetchOrderScoring({
      orderId,
    });

    // scoring: boolean
    ```
  </Tab>

  <Tab title="Batch Order Scoring">
    ```ts theme={null}
    const scoring = await secureClient.fetchOrdersScoring({
      orderIds: [firstOrderId, secondOrderId],
    });

    // scoring: OrdersScoringResponse
    ```
  </Tab>
</Tabs>

### Account Data

Secure clients can read account-scoped data for the authenticated wallet.

<Tabs>
  <Tab title="Positions">
    ```ts theme={null}
    const positions = secureClient.listPositions({
      market: [market.id], // Or market.conditionId
      pageSize: 10,
    });

    for await (const page of positions) {
      // page.items: Position[]
    }
    ```
  </Tab>

  <Tab title="Portfolio Value">
    ```ts theme={null}
    const value = await secureClient.fetchPortfolioValue({
      market: [market.id], // Or market.conditionId
    });

    // value: Value[]
    ```
  </Tab>

  <Tab title="Activity">
    ```ts theme={null}
    import { ActivityType } from "@polymarket/client";

    const activity = secureClient.listActivity({
      market: [market.id], // Or market.conditionId
      pageSize: 10,
    });

    for await (const page of activity) {
      for (const item of page.items) {
        switch (item.type) {
          case ActivityType.TRADE:
            // item.tokenId: TokenId
            // item.shares: DecimalString
            break;
          case ActivityType.REWARD:
            // item.amount: DecimalString
            break;
          default:
          // …
        }
      }
    }
    ```
  </Tab>

  <Tab title="Trades">
    ```ts theme={null}
    const yesTokenId = market.outcomes.yes.tokenId!;

    const trades = secureClient.listAccountTrades({
      tokenId: yesTokenId,
    });

    for await (const page of trades) {
      // page.items: ClobTrade[]
    }
    ```
  </Tab>

  <Tab title="Notifications">
    ```ts theme={null}
    const notifications = await secureClient.fetchNotifications();

    // notifications: Notification[]
    ```
  </Tab>
</Tabs>

### Authentication Sessions

Secure clients expose the API credentials created for the authenticated session. Store them securely if you want to reuse the session later without requiring a new authentication signature while the credentials remain valid.

<Tabs>
  <Tab title="Save Credentials">
    ```ts theme={null}
    const secureClient = await createSecureClient({
      wallet: "YOUR_POLYMARKET_WALLET_ADDRESS",
      signer,
    });

    await storage.set("polymarketCredentials", secureClient.credentials);
    ```
  </Tab>

  <Tab title="Reuse Credentials">
    ```ts theme={null}
    const credentials = await storage.get("polymarketCredentials");

    const secureClient = await createSecureClient({
      wallet: "YOUR_POLYMARKET_WALLET_ADDRESS",
      signer,
      credentials,
    });
    ```
  </Tab>
</Tabs>
