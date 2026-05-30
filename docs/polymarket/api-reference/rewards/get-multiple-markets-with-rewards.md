> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get multiple markets with rewards

> Returns a list of active markets with their reward configurations.
Supports text search, tag filtering, numeric filters, and sorting.

Results are paginated (100 items per page by default). Use next_cursor to fetch subsequent pages.
A next_cursor value of "LTE=" indicates the last page.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /rewards/markets/multi
openapi: 3.1.0
info:
  title: Polymarket CLOB API
  description: Polymarket CLOB API Reference
  license:
    name: MIT
    identifier: MIT
  version: 1.0.0
servers:
  - url: https://clob.polymarket.com
    description: Production CLOB API
  - url: https://clob-staging.polymarket.com
    description: Staging CLOB API
security: []
tags:
  - name: Trade
    description: Trade endpoints
  - name: Markets
    description: Market data endpoints
  - name: Account
    description: Account and authentication endpoints
  - name: Notifications
    description: User notification endpoints
  - name: Rewards
    description: Rewards and earnings endpoints
  - name: Rebates
    description: Maker rebate endpoints
paths:
  /rewards/markets/multi:
    get:
      tags:
        - Rewards
      summary: Get multiple markets with rewards
      description: >
        Returns a list of active markets with their reward configurations.

        Supports text search, tag filtering, numeric filters, and sorting.


        Results are paginated (100 items per page by default). Use next_cursor
        to fetch subsequent pages.

        A next_cursor value of "LTE=" indicates the last page.
      operationId: getMultiMarkets
      parameters:
        - name: q
          in: query
          description: Text search on market question/description
          required: false
          schema:
            type: string
        - name: tag_slug
          in: query
          description: >-
            Filter by tag slug. Can be repeated for OR logic (e.g.,
            ?tag_slug=sports&tag_slug=politics)
          required: false
          schema:
            type: string
        - name: event_id
          in: query
          description: >-
            Filter by event ID. Can be repeated for multiple events (e.g.,
            ?event_id=100&event_id=200)
          required: false
          schema:
            type: string
        - name: event_title
          in: query
          description: Search event titles using case-insensitive pattern matching
          required: false
          schema:
            type: string
        - name: order_by
          in: query
          description: Field to sort results by
          required: false
          schema:
            type: string
            enum:
              - market_id
              - created_at
              - volume_24hr
              - spread
              - competitiveness
              - max_spread
              - min_size
              - question
              - one_day_price_change
              - rate_per_day
              - price
              - end_date
              - start_date
              - reward_end_date
        - name: position
          in: query
          description: Sort direction
          required: false
          schema:
            type: string
            enum:
              - ASC
              - DESC
        - name: min_volume_24hr
          in: query
          description: Minimum 24-hour volume filter
          required: false
          schema:
            type: number
            format: double
        - name: max_volume_24hr
          in: query
          description: Maximum 24-hour volume filter
          required: false
          schema:
            type: number
            format: double
        - name: min_spread
          in: query
          description: Minimum spread filter
          required: false
          schema:
            type: number
            format: double
        - name: max_spread
          in: query
          description: Maximum spread filter
          required: false
          schema:
            type: number
            format: double
        - name: min_price
          in: query
          description: Minimum first token price filter
          required: false
          schema:
            type: number
            format: double
        - name: max_price
          in: query
          description: Maximum first token price filter
          required: false
          schema:
            type: number
            format: double
        - name: next_cursor
          in: query
          description: Pagination cursor from previous response
          required: false
          schema:
            type: string
        - name: page_size
          in: query
          description: Number of items per page (max 500, values above are capped)
          required: false
          schema:
            type: integer
            default: 100
            maximum: 500
      responses:
        '200':
          description: Successfully retrieved markets with rewards
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaginatedMultiMarketInfo'
              example:
                limit: 50
                count: 1
                next_cursor: NQ==
                data:
                  - condition_id: >-
                      0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af
                    event_id: '12345'
                    event_slug: 2024-us-election
                    created_at: '2024-05-01T12:00:00Z'
                    group_item_title: ''
                    image: https://example.com/image.png
                    market_competitiveness: 0.42
                    market_id: '248849'
                    market_slug: will-trump-win-the-2024-iowa-caucus
                    one_day_price_change: 0.03
                    question: Will Trump win the 2024 Iowa Caucus?
                    rewards_max_spread: 99
                    rewards_min_size: 10
                    spread: 0.12
                    end_date: '2024-08-10 00:00:00'
                    tokens:
                      - token_id: >-
                          1343197538147866997676250008839231694243646439454152539053893078719042421992
                        outcome: 'YES'
                        price: 0.8
                      - token_id: >-
                          16678291189211314787145083999015737376658799626183230671758641503291735614088
                        outcome: 'NO'
                        price: 0.2
                    volume_24hr: 12345.67
                    rewards_config:
                      - id: 7
                        asset_address: '0x9c4E1703476E875070EE25b56A58B008CFb8FA78'
                        start_date: '2024-03-01'
                        end_date: '2500-12-31'
                        rate_per_day: 2
                        total_rewards: 92
        '400':
          description: Bad request - Invalid parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_order_by:
                  summary: Invalid order_by value
                  value:
                    error: Invalid order_by
                invalid_position:
                  summary: Invalid position value
                  value:
                    error: Invalid position
                invalid_cursor:
                  summary: Invalid pagination cursor
                  value:
                    error: Invalid next_cursor
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Internal server error
components:
  schemas:
    PaginatedMultiMarketInfo:
      type: object
      description: Paginated list of markets with rewards and trading metrics
      properties:
        limit:
          type: integer
          description: Maximum number of items per page
        count:
          type: integer
          description: Number of items in the current response
        next_cursor:
          type: string
          description: Cursor for the next page. "LTE=" indicates the last page.
        data:
          type: array
          items:
            $ref: '#/components/schemas/MultiMarketInfo'
      required:
        - limit
        - count
        - next_cursor
        - data
    ErrorResponse:
      type: object
      required:
        - error
      properties:
        error:
          type: string
          description: Error message
        code:
          type: string
          description: Machine-readable error code, when provided
        retry_after_seconds:
          type: integer
          description: Number of seconds to wait before retrying, when provided
    MultiMarketInfo:
      type: object
      description: Market with rewards configuration and trading metrics
      properties:
        condition_id:
          type: string
          description: Condition ID of the market
        event_id:
          type: string
          description: Event ID
        event_slug:
          type: string
          description: URL slug for the event
        created_at:
          type: string
          format: date-time
          description: Market creation timestamp
        group_item_title:
          type: string
          description: Title within an event group
        image:
          type: string
          description: URL to market image
        market_competitiveness:
          type: number
          format: double
          description: Competitiveness score of the market
        market_id:
          type: string
          description: Market ID
        market_slug:
          type: string
          description: URL slug for the market
        one_day_price_change:
          type: number
          format: double
          description: Price change over the last 24 hours
        question:
          type: string
          description: Market question
        rewards_max_spread:
          type: number
          description: Maximum spread for rewards eligibility
        rewards_min_size:
          type: number
          description: Minimum order size for rewards eligibility
        spread:
          type: number
          format: double
          description: Current spread
        end_date:
          type: string
          description: Market end date
        tokens:
          type: array
          items:
            $ref: '#/components/schemas/RewardsToken'
        volume_24hr:
          type: number
          format: double
          description: 24-hour trading volume
        rewards_config:
          type: array
          items:
            $ref: '#/components/schemas/RewardsConfig'
      required:
        - condition_id
        - market_id
        - question
        - tokens
    RewardsToken:
      type: object
      description: Token information for rewards markets
      properties:
        token_id:
          type: string
          description: Token ID
        outcome:
          type: string
          description: Outcome name (e.g., "YES", "NO")
        price:
          type: number
          format: double
          description: Current price of the token
      required:
        - token_id
        - outcome
    RewardsConfig:
      type: object
      description: Rewards configuration for a market
      properties:
        id:
          type: integer
          description: Rewards config ID
        asset_address:
          type: string
          description: Address of the reward asset
        start_date:
          type: string
          format: date
          description: Start date of the rewards period
        end_date:
          type: string
          format: date
          description: End date of the rewards period
        rate_per_day:
          type: number
          format: double
          description: Daily reward rate
        total_rewards:
          type: number
          format: double
          description: Total rewards amount
        remaining_reward_amount:
          type: number
          format: double
          description: Remaining reward amount
        total_days:
          type: integer
          description: Total number of days in the rewards period
      required:
        - asset_address
        - start_date
        - rate_per_day

````