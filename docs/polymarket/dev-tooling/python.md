> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Python SDK

> Build with the unified Polymarket Python SDK.

The unified Python SDK gives you a consistent surface across Polymarket discovery, market data, trading, account data, and realtime streams.

<Note>
  The Python SDK is currently in beta. We are keeping it in this beta phase
  while we address issues and harden the SDK before transitioning to a more
  stable release.
</Note>

The SDK ships parallel async and sync clients with matching method names and arguments: `AsyncPublicClient` / `PublicClient` for public reads, and `AsyncSecureClient` / `SecureClient` for authenticated reads and trading. Prefer the async clients for servers, bots, and any code that already runs inside an event loop. Use the sync clients for scripts, notebooks, and one-off tools where an event loop would just add ceremony. Realtime stream subscriptions are async only and require the async clients.

Examples below show the body of an `async def main()` function; wrap them with `asyncio.run(main())` to run as a script, as shown in [Quickstart](#quickstart). To switch a snippet to sync, swap `AsyncPublicClient` / `AsyncSecureClient` for `PublicClient` / `SecureClient`, drop `await`, replace `async with` with `with`, replace `async for` with `for`, and remove the `asyncio.run(...)` wrapper.

## Quickstart

<Steps>
  <Step title="Install the Package">
    Install the SDK from PyPI.

    <CodeGroup>
      ```bash uv theme={null}
      uv add polymarket-client
      ```

      ```bash pip theme={null}
      pip install polymarket-client
      ```

      ```bash poetry theme={null}
      poetry add polymarket-client
      ```
    </CodeGroup>
  </Step>

  <Step title="Create a Public Client">
    Create an instance of the `AsyncPublicClient` inside an `async with` block so its network transports are released when you are done.

    ```python theme={null}
    from polymarket import AsyncPublicClient

    async with AsyncPublicClient() as client:
        ...
    ```
  </Step>

  <Step title="Fetch Markets">
    Fetch a page of markets to discover active trading opportunities.

    <CodeGroup>
      ```python Async theme={null}
      import asyncio

      from polymarket import AsyncPublicClient


      async def main() -> None:
          async with AsyncPublicClient() as client:
              markets = client.list_markets(closed=False, page_size=5)
              first_page = await markets.first_page()

              for market in first_page.items:
                  # market: Market
                  ...


      asyncio.run(main())
      ```

      ```python Sync theme={null}
      from polymarket import PublicClient


      with PublicClient() as client:
          markets = client.list_markets(closed=False, page_size=5)
          first_page = markets.first_page()

          for market in first_page.items:
              # market: Market
              ...
      ```
    </CodeGroup>
  </Step>
</Steps>

## SDK Patterns

The SDK uses consistent patterns for pagination, Python-native model values, and structured SDK exceptions across public and authenticated workflows.

### Typed Primitives

Identifiers and EVM addresses are exposed as `typing.NewType` aliases (`MarketId`, `ConditionId`, `TokenId`, `EventId`, `EvmAddress`, …) so static type checkers can keep them distinct from plain strings. Precision-sensitive price, size, and amount fields generally use `decimal.Decimal`; date and time fields use `datetime.date` or `datetime.datetime`.

```python theme={null}
from datetime import datetime
from decimal import Decimal

from polymarket import ConditionId, EvmAddress, MarketId, TokenId


class Market:
    id: MarketId
    condition_id: ConditionId | None
    state: MarketState
    outcomes: MarketOutcomes
    resolution: MarketResolution
    # …


class MarketState:
    start_date: datetime | None
    end_date: datetime | None
    # …


class MarketOutcome:
    label: str
    token_id: TokenId | None
    price: Decimal | None


class MarketResolution:
    resolved_by: EvmAddress | None
    # …
```

### Market and Event Data

Market and event responses are returned as SDK models with snake\_case fields and nested submodels.

<CodeGroup>
  ```python Market theme={null}
  class Market:
      id: MarketId
      slug: str | None
      condition_id: ConditionId | None
      question: str | None
      description: str | None
      category: str | None
      image: str | None
      icon: str | None
      state: MarketState
      outcomes: MarketOutcomes
      metrics: MarketMetrics
      prices: MarketPrices
      trading: MarketTrading
      resolution: MarketResolution
      rewards: MarketRewards
      sports: MarketSportsMetadata
      tags: tuple[MarketTag, ...]
      # …
  ```

  ```python Event theme={null}
  class Event:
      id: EventId
      slug: str | None
      title: str | None
      subtitle: str | None
      description: str | None
      category: str | None
      subcategory: str | None
      image: str | None
      icon: str | None
      created_at: datetime | None
      updated_at: datetime | None
      published_at: datetime | None
      state: EventState
      schedule: EventSchedule
      metrics: EventMetrics
      trading: EventTrading
      estimation: EventEstimation
      sports: EventSportsMetadata
      partners: tuple[EventPartner, ...]
      markets: tuple[Market, ...]
      series: tuple[EventSeries, ...]
      # …
  ```
</CodeGroup>

### Environment Configuration

Production is the default environment. Pass an `Environment` object when your integration needs to target a different deployment or custom endpoint set. The client owns network transports, so use `async with` (or call `await client.close()`) to release them when you are done.

```python theme={null}
from polymarket import AsyncPublicClient, PRODUCTION


async with AsyncPublicClient(environment=PRODUCTION) as client:
    ...
```

### Pagination

With async clients, list methods return an `AsyncPaginator` across paginated endpoints. Use `async for` to iterate through pages.

```python theme={null}
async with AsyncPublicClient() as client:
    markets = client.list_markets(closed=False, page_size=10)

    async for page in markets:
        # page.items: tuple[Market, ...]
        ...
```

You can also fetch the first page directly and resume later from a cursor.

```python theme={null}
first_page = await markets.first_page()
# first_page.items: tuple[Market, ...]

async for page in markets.from_cursor(first_page.next_cursor):
    # page.items: tuple[Market, ...]
    ...
```

When you only care about the items and not page boundaries, iterate them directly.

```python theme={null}
async for market in markets.items():
    # market: Market
    ...
```

### Error Handling

All SDK exceptions inherit from `PolymarketError`. Catch specific subclasses to handle known cases, and catch `PolymarketError` as the final SDK fallback.

<Note>
  Catching `PolymarketError` last ensures error subclasses added in future SDK
  releases do not pass through unhandled.
</Note>

```python theme={null}
from polymarket import (
    AsyncPublicClient,
    PolymarketError,
    RateLimitError,
    UserInputError,
)

async with AsyncPublicClient() as client:
    try:
        markets = client.list_markets(closed=False, page_size=10)
        first_page = await markets.first_page()
        # first_page.items: tuple[Market, ...]
    except RateLimitError:
        # Retry later.
        ...
    except UserInputError:
        # Fix the request parameters.
        ...
    except PolymarketError:
        # Handle any other SDK error.
        ...
```

## Market Data

Use market data methods to fetch market and event details, order books, current prices, historical prices, and batch quotes.

<CodeGroup>
  ```python Market theme={null}
  market = await client.get_market(
      url="https://polymarket.com/market/eth-flipped-in-2026",
  )

  market_by_slug = await client.get_market(slug="eth-flipped-in-2026")

  market_by_id = await client.get_market(id="12345")
  ```

  ```python Event theme={null}
  event = await client.get_event(
      url="https://polymarket.com/event/presidential-election-2028",
  )

  event_by_slug = await client.get_event(slug="presidential-election-2028")

  event_by_id = await client.get_event(id="12345")
  ```
</CodeGroup>

Then fetch related tags, order books, prices, and history.

<CodeGroup>
  ```python Tags theme={null}
  market_tags = await client.get_market_tags(market.id)

  event_tags = await client.get_event_tags(event.id)
  ```

  ```python Order Book theme={null}
  yes_token_id = market.outcomes.yes.token_id
  if yes_token_id is None:
      raise RuntimeError("Market does not have a YES token id")

  book = await client.get_order_book(token_id=yes_token_id)
  ```

  ```python Prices theme={null}
  yes_token_id = market.outcomes.yes.token_id
  if yes_token_id is None:
      raise RuntimeError("Market does not have a YES token id")

  buy_price = await client.get_price(token_id=yes_token_id, side="BUY")

  midpoint = await client.get_midpoint(token_id=yes_token_id)

  spread = await client.get_spread(token_id=yes_token_id)

  last_trade = await client.get_last_trade_price(token_id=yes_token_id)
  ```

  ```python History theme={null}
  yes_token_id = market.outcomes.yes.token_id
  if yes_token_id is None:
      raise RuntimeError("Market does not have a YES token id")

  history = await client.get_price_history(token_id=yes_token_id, interval="1d")
  ```

  ```python Batch Reads theme={null}
  from polymarket import PriceRequest

  yes_token_id = market.outcomes.yes.token_id
  no_token_id = market.outcomes.no.token_id
  if yes_token_id is None or no_token_id is None:
      raise RuntimeError("Market does not have both outcome token ids")

  prices = await client.get_prices(
      requests=[
          PriceRequest(token_id=yes_token_id, side="BUY"),
          PriceRequest(token_id=no_token_id, side="BUY"),
      ],
  )

  midpoints = await client.get_midpoints(token_ids=[yes_token_id, no_token_id])
  ```
</CodeGroup>

## Discovery

Use discovery methods to browse events, markets, teams, tags, comments, sports metadata, and search results. The examples below show a few common entry points.

<Tabs>
  <Tab title="Events">
    ```python theme={null}
    events = client.list_events(page_size=10)

    async for page in events:
        # page.items: tuple[Event, ...]
        ...
    ```
  </Tab>

  <Tab title="Markets">
    ```python theme={null}
    markets = client.list_markets(closed=False, page_size=10)

    async for page in markets:
        # page.items: tuple[Market, ...]
        ...
    ```
  </Tab>

  <Tab title="Teams">
    ```python theme={null}
    teams = client.list_teams(league="NBA", page_size=10)

    async for page in teams:
        # page.items: tuple[Team, ...]
        ...
    ```
  </Tab>

  <Tab title="Tags">
    ```python theme={null}
    tags = client.list_tags(page_size=10)

    async for page in tags:
        # page.items: tuple[Tag, ...]
        ...

    tag = await client.get_tag(slug="politics")

    related_tags = await client.get_related_tags(slug="politics")

    related_resources = await client.get_related_tag_resources(
        slug="politics",
        status="active",
    )
    ```
  </Tab>

  <Tab title="Comments">
    ```python theme={null}
    import os

    comments = client.list_comments(
        parent_entity_id="12345",
        parent_entity_type="Event",
        page_size=20,
    )

    async for page in comments:
        # page.items: tuple[Comment, ...]
        ...

    thread = await client.get_comment_thread("456", get_positions=True)

    user_comments = client.list_comments_by_user_address(
        address=os.environ["POLYMARKET_TARGET_WALLET_ADDRESS"],
        page_size=10,
        order="DESC",
    )

    async for page in user_comments:
        # page.items: tuple[Comment, ...]
        ...
    ```
  </Tab>

  <Tab title="Sports">
    ```python theme={null}
    sports = await client.get_sports()

    # sports: tuple[SportsMetadata, ...]
    ```
  </Tab>

  <Tab title="Search">
    ```python theme={null}
    results = client.search(q="ethereum", page_size=10)

    async for page in results:
        for search_results in page.items:
            # search_results.events: tuple[Event, ...]
            # search_results.tags: tuple[SearchTag, ...]
            # search_results.profiles: tuple[Profile, ...]
            ...
    ```
  </Tab>
</Tabs>

## Realtime Streams

Subscribe through one SDK interface even when events come from different stream families. The SDK routes each subscription spec to the right stream and merges the results into one async iterator. Subscriptions are async only and require `AsyncPublicClient` or `AsyncSecureClient`.

```python theme={null}
from polymarket import AsyncPublicClient
from polymarket.streams import CryptoPricesSpec, MarketSpec


yes_token_id = market.outcomes.yes.token_id
if yes_token_id is None:
    raise RuntimeError("Market does not have a YES token id")

async with AsyncPublicClient() as client:
    stream = await client.subscribe(
        [
            MarketSpec(token_ids=[yes_token_id]),
            CryptoPricesSpec(
                topic="prices.crypto.binance",
                symbols=["btcusdt"],
            ),
        ],
    )

    async with stream:
        async for event in stream:
            # event:
            #   | MarketBookEvent
            #   | MarketPriceChangeEvent
            #   | MarketLastTradePriceEvent
            #   | MarketTickSizeChangeEvent
            #   | MarketBestBidAskEvent
            #   | NewMarketEvent
            #   | MarketResolvedEvent
            #   | CryptoPricesBinanceEvent
            print(type(event).__name__)
            break
```

`AsyncSecureClient.subscribe` accepts the same public subscription specs and adds `UserSpec` for user-scoped order and trade events on the authenticated wallet.

```python theme={null}
import os

from polymarket import AsyncSecureClient
from polymarket.streams import UserSpec


async with await AsyncSecureClient.create(
    private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
    wallet=os.environ.get("POLYMARKET_WALLET_ADDRESS"),
) as secure_client:
    user_stream = await secure_client.subscribe(UserSpec())

    async with user_stream:
        async for event in user_stream:
            # event:
            #   | UserOrderEvent
            #   | UserTradeEvent
            print(type(event).__name__)
            break
```

## Authenticated Client

Create a secure client when you need wallet-scoped reads or trading.

<Note>
  Secure clients own multiple network transports. Wrap them in `async with`,
  or call `await secure_client.close()` when you are done, to release the
  underlying connections. The snippets below show client creation and
  subsequent calls as a flat sequence for readability — in real code, keep
  the client inside an `async with` block or close it explicitly.
</Note>

### Private Key Setup

The Python SDK authenticates with a local private key. Pass `wallet` when you want to operate on a Polymarket wallet address that differs from the signer address; if omitted, the client uses the signer address as the account wallet.

```python theme={null}
import os

from polymarket import AsyncSecureClient


async with await AsyncSecureClient.create(
    private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
    wallet=os.environ.get("POLYMARKET_WALLET_ADDRESS"),
) as secure_client:
    ...
```

Keep private keys and API credentials in your secret manager or local environment. Do not commit them to source control.

### API Key Authentication

Configure an API key when the SDK needs to set up gasless wallet operations.

<CodeGroup>
  ```python Relayer API Key theme={null}
  import os

  from polymarket import AsyncSecureClient, RelayerApiKey


  secure_client = await AsyncSecureClient.create(
      private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
      wallet=os.environ.get("POLYMARKET_WALLET_ADDRESS"),
      api_key=RelayerApiKey(
          key=os.environ["POLYMARKET_RELAYER_API_KEY"],
          address=os.environ["POLYMARKET_RELAYER_API_KEY_ADDRESS"],
      ),
  )
  ```

  ```python Builder API Key theme={null}
  import os

  from polymarket import AsyncSecureClient, BuilderApiKey


  secure_client = await AsyncSecureClient.create(
      private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
      wallet=os.environ.get("POLYMARKET_WALLET_ADDRESS"),
      api_key=BuilderApiKey(
          key=os.environ["POLYMARKET_BUILDER_API_KEY"],
          secret=os.environ["POLYMARKET_BUILDER_SECRET"],
          passphrase=os.environ["POLYMARKET_BUILDER_PASSPHRASE"],
      ),
  )
  ```
</CodeGroup>

<Note>
  Builder API keys are supported for backwards compatibility with builders that
  still use them for gasless workflows. They are not used for order attribution.
  Use `builder_code` on orders for attribution.
</Note>

### Trading Setup

Before placing orders, make sure the authenticated wallet has the required trading approvals. If you use gasless wallet operations, configure API key authentication first.

<Note>
  From this point forward, snippets in Trading Setup, Trading, Position
  Lifecycle, and Wallet Operations submit real on-chain transactions or
  live orders against the configured environment when executed. Review
  each call before running it against a wallet that holds funds.
</Note>

<Steps>
  <Step title="Check Gasless Readiness">
    Optionally check whether the deposit wallet for the authenticated EOA is already deployed. The result is informational — call `setup_gasless_wallet()` in the next step regardless, since it is idempotent on deployment and is the call that binds the client to the deposit wallet.

    ```python theme={null}
    is_gasless_ready = await secure_client.is_gasless_ready()
    ```
  </Step>

  <Step title="Set Up Gasless Wallet">
    Always call `setup_gasless_wallet()` for gasless workflows. It deploys the deposit wallet if needed and returns a new client bound to the deposit wallet address. Close the previous client when you replace it.

    ```python theme={null}
    gasless_client = await secure_client.setup_gasless_wallet()
    await secure_client.close()
    secure_client = gasless_client
    ```
  </Step>

  <Step title="Set Up Trading Approvals">
    Set up the approvals required for trading and wait for the setup transaction to complete.

    ```python theme={null}
    handle = await secure_client.setup_trading_approvals()
    outcome = await handle.wait()

    # outcome.transaction_hash: TransactionHash
    ```
  </Step>
</Steps>

### Trading

Use a secure client to create, sign, and submit orders. Limit orders specify the price and size you want to trade. Market orders execute against resting liquidity immediately.

Order placement returns a discriminated response. Check `response.ok` before reading order details.

#### Place Orders

<Tabs>
  <Tab title="Limit Order">
    ```python theme={null}
    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    response = await secure_client.place_limit_order(
        token_id=yes_token_id,
        side="BUY",
        price="0.52",
        size="10",
    )

    if response.ok:
        # response.order_id: str
        ...
    else:
        # response.code: OrderResponseErrorCode
        # response.message: str
        ...
    ```
  </Tab>

  <Tab title="Expiring Limit Order">
    ```python theme={null}
    import time

    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    response = await secure_client.place_limit_order(
        token_id=yes_token_id,
        side="SELL",
        price="0.52",
        size="10",
        expiration=int(time.time()) + 60 * 60,
    )

    if response.ok:
        # response.order_id: str
        ...
    else:
        # response.code: OrderResponseErrorCode
        # response.message: str
        ...
    ```
  </Tab>

  <Tab title="Partial-Fill Market Order">
    ```python theme={null}
    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    response = await secure_client.place_market_order(
        token_id=yes_token_id,
        side="BUY",
        amount="10",
        max_spend="11",
        order_type="FAK",
    )

    if response.ok:
        # response.order_id: str
        ...
    else:
        # response.code: OrderResponseErrorCode
        # response.message: str
        ...
    ```
  </Tab>

  <Tab title="All-Or-Nothing Market Order">
    ```python theme={null}
    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    response = await secure_client.place_market_order(
        token_id=yes_token_id,
        side="SELL",
        shares="10",
        order_type="FOK",
    )

    if response.ok:
        # response.order_id: str
        ...
    else:
        # response.code: OrderResponseErrorCode
        # response.message: str
        ...
    ```
  </Tab>

  <Tab title="Builder Code">
    ```python theme={null}
    import os

    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    response = await secure_client.place_limit_order(
        token_id=yes_token_id,
        side="BUY",
        price="0.52",
        size="10",
        builder_code=os.environ["POLYMARKET_BUILDER_CODE"],
    )

    if response.ok:
        # response.order_id: str
        ...
    else:
        # response.code: OrderResponseErrorCode
        # response.message: str
        ...
    ```
  </Tab>
</Tabs>

#### Create, Then Post

Create signed orders separately when you want to review, store, or batch them before submitting.

<Tabs>
  <Tab title="Single Order">
    ```python theme={null}
    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    order = await secure_client.create_limit_order(
        token_id=yes_token_id,
        side="BUY",
        price="0.52",
        size="10",
    )

    response = await secure_client.post_order(order)

    if response.ok:
        # response.order_id: str
        ...
    else:
        # response.code: OrderResponseErrorCode
        # response.message: str
        ...
    ```
  </Tab>

  <Tab title="Batch Orders">
    ```python theme={null}
    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    first_order = await secure_client.create_limit_order(
        token_id=yes_token_id,
        side="BUY",
        price="0.52",
        size="10",
    )

    second_order = await secure_client.create_limit_order(
        token_id=yes_token_id,
        side="SELL",
        price="0.58",
        size="5",
    )

    responses = await secure_client.post_orders([first_order, second_order])

    for response in responses:
        if response.ok:
            # response.order_id: str
            ...
        else:
            # response.code: OrderResponseErrorCode
            # response.message: str
            ...
    ```
  </Tab>
</Tabs>

### Position Lifecycle

Use position lifecycle methods to split collateral into outcome tokens, merge complete sets back into collateral, or redeem resolved positions. These examples assume the secure client is configured with API key authentication as shown in [API Key Authentication](#api-key-authentication).

<Tabs>
  <Tab title="Split Position">
    ```python theme={null}
    condition_id = market.condition_id
    if condition_id is None:
        raise RuntimeError("Market does not have a condition id")

    handle = await secure_client.split_position(
        condition_id=condition_id,
        amount=1,
    )

    outcome = await handle.wait()

    # outcome.transaction_hash: TransactionHash
    ```
  </Tab>

  <Tab title="Merge Positions">
    ```python theme={null}
    condition_id = market.condition_id
    if condition_id is None:
        raise RuntimeError("Market does not have a condition id")

    handle = await secure_client.merge_positions(
        condition_id=condition_id,
        amount="max",
    )

    outcome = await handle.wait()

    # outcome.transaction_hash: TransactionHash
    ```
  </Tab>

  <Tab title="Redeem Positions">
    ```python theme={null}
    handle = await secure_client.redeem_positions(
        market_id=market.id,
    )

    outcome = await handle.wait()

    # outcome.transaction_hash: TransactionHash
    ```
  </Tab>
</Tabs>

### Wallet Operations

Use wallet operation methods for direct token movements from the authenticated wallet. Amounts are in base units. These examples assume the secure client is configured with API key authentication as shown in [API Key Authentication](#api-key-authentication).

```python theme={null}
import os

handle = await secure_client.transfer_erc20(
    token_address=secure_client.environment.collateral_token,
    recipient_address=os.environ["POLYMARKET_RECIPIENT_ADDRESS"],
    amount=1_000_000,
)

outcome = await handle.wait()

# outcome.transaction_hash: TransactionHash
```

### Order Management

Manage open orders for the authenticated wallet after placement. These examples assume `order_id` comes from an accepted order response.

<Tabs>
  <Tab title="Get Order">
    ```python theme={null}
    order = await secure_client.get_order(order_id=order_id)

    # order: OpenOrder
    ```
  </Tab>

  <Tab title="List Open Orders">
    ```python theme={null}
    condition_id = market.condition_id
    if condition_id is None:
        raise RuntimeError("Market does not have a condition id")

    open_orders = secure_client.list_open_orders(market=condition_id)

    async for page in open_orders:
        # page.items: tuple[OpenOrder, ...]
        ...
    ```
  </Tab>

  <Tab title="Cancel Order">
    ```python theme={null}
    response = await secure_client.cancel_order(order_id=order_id)

    # response.canceled: tuple[str, ...]
    ```
  </Tab>

  <Tab title="Cancel Market Orders">
    ```python theme={null}
    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    response = await secure_client.cancel_market_orders(token_id=yes_token_id)

    # response.canceled: tuple[str, ...]
    ```
  </Tab>
</Tabs>

### Rewards and Scoring

Use rewards methods to inspect active reward programs and scoring methods to check whether orders are eligible for scoring. `list_current_rewards` and `list_market_rewards` are public reads and are also available on `AsyncPublicClient` / `PublicClient`; `get_order_scoring` and `get_orders_scoring` require a secure client because they read account-scoped order data.

<Tabs>
  <Tab title="Current Rewards">
    ```python theme={null}
    rewards = secure_client.list_current_rewards()

    async for page in rewards:
        # page.items: tuple[CurrentReward, ...]
        ...
    ```
  </Tab>

  <Tab title="Market Rewards">
    ```python theme={null}
    condition_id = market.condition_id
    if condition_id is None:
        raise RuntimeError("Market does not have a condition id")

    rewards = secure_client.list_market_rewards(condition_id=condition_id)

    async for page in rewards:
        # page.items: tuple[MarketReward, ...]
        ...
    ```
  </Tab>

  <Tab title="Order Scoring">
    ```python theme={null}
    scoring = await secure_client.get_order_scoring(order_id=order_id)

    # scoring: bool
    ```
  </Tab>

  <Tab title="Batch Order Scoring">
    ```python theme={null}
    scoring = await secure_client.get_orders_scoring(
        order_ids=[first_order_id, second_order_id],
    )

    # scoring: dict[str, bool]
    ```
  </Tab>
</Tabs>

### Account Data

Secure clients read account-scoped data for the authenticated wallet by default. Methods that take a `user=` parameter (positions, portfolio value, activity) accept a different wallet address to read its data instead.

<Tabs>
  <Tab title="Positions">
    ```python theme={null}
    positions = secure_client.list_positions(
        market=[market.id],
        page_size=10,
    )

    async for page in positions:
        # page.items: tuple[Position, ...]
        ...
    ```
  </Tab>

  <Tab title="Portfolio Value">
    ```python theme={null}
    value = await secure_client.get_portfolio_values(market=[market.id])

    # value: tuple[PortfolioValue, ...]
    ```
  </Tab>

  <Tab title="Activity">
    ```python theme={null}
    activity = secure_client.list_activity(
        market=[market.id],
        page_size=10,
    )

    async for page in activity:
        for item in page.items:
            match item.type:
                case "TRADE":
                    # item.token_id: TokenId
                    # item.shares: Decimal
                    ...
                case "REWARD":
                    # item.amount: Decimal
                    ...
                case _:
                    # SPLIT / MERGE / REDEEM / CONVERSION / MAKER_REBATE
                    # / REFERRAL_REWARD / YIELD
                    ...
    ```
  </Tab>

  <Tab title="Trades">
    ```python theme={null}
    yes_token_id = market.outcomes.yes.token_id
    if yes_token_id is None:
        raise RuntimeError("Market does not have a YES token id")

    trades = secure_client.list_account_trades(token_id=yes_token_id)

    async for page in trades:
        # page.items: tuple[ClobTrade, ...]
        ...
    ```
  </Tab>

  <Tab title="Notifications">
    ```python theme={null}
    notifications = await secure_client.get_notifications()

    # notifications: tuple[Notification, ...]
    ```
  </Tab>
</Tabs>

### Authentication Sessions

Secure clients expose the API credentials created for the authenticated session. Store them securely if you want to reuse the session later without producing a new authentication signature while the credentials remain valid.

<Tabs>
  <Tab title="Save Credentials">
    ```python theme={null}
    import os

    from polymarket import AsyncSecureClient


    secure_client = await AsyncSecureClient.create(
        private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
        wallet=os.environ.get("POLYMARKET_WALLET_ADDRESS"),
    )

    saved_credentials = secure_client.credentials.model_dump(mode="json")
    ```
  </Tab>

  <Tab title="Reuse Credentials">
    ```python theme={null}
    import os

    from polymarket import ApiKeyCreds, AsyncSecureClient


    credentials = ApiKeyCreds.model_validate(saved_credentials)

    secure_client = await AsyncSecureClient.create(
        private_key=os.environ["POLYMARKET_PRIVATE_KEY"],
        wallet=os.environ.get("POLYMARKET_WALLET_ADDRESS"),
        credentials=credentials,
    )
    ```
  </Tab>
</Tabs>
