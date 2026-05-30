> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get raw rewards for a specific market

> Returns an array of present and future rewards configured on a market.

When `sponsored=true`, sponsored daily rates are folded into each config's
`rate_per_day` .

Results are paginated (100 items per page). Use next_cursor to fetch subsequent pages.
A next_cursor value of "LTE=" indicates the last page.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /rewards/markets/{condition_id}
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
  /rewards/markets/{condition_id}:
    get:
      tags:
        - Rewards
      summary: Get raw rewards for a specific market
      description: >
        Returns an array of present and future rewards configured on a market.


        When `sponsored=true`, sponsored daily rates are folded into each
        config's

        `rate_per_day` .


        Results are paginated (100 items per page). Use next_cursor to fetch
        subsequent pages.

        A next_cursor value of "LTE=" indicates the last page.
      operationId: getRawRewardsForMarket
      parameters:
        - name: condition_id
          in: path
          required: true
          description: The condition ID of the market
          schema:
            type: string
          example: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af'
        - name: sponsored
          in: query
          description: If true, folds sponsored daily rates into each config's rate_per_day
          required: false
          schema:
            type: boolean
            default: false
        - name: next_cursor
          in: query
          description: Pagination cursor from previous response
          required: false
          schema:
            type: string
      responses:
        '200':
          description: Successfully retrieved rewards for market
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaginatedMarketReward'
              example:
                limit: 100
                count: 1
                next_cursor: LTE=
                data:
                  - condition_id: >-
                      0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af
                    question: Will Trump win the 2024 Iowa Caucus?
                    market_slug: will-trump-win-the-2024-iowa-caucus
                    event_slug: will-trump-win-the-2024-iowa-caucus
                    image: >-
                      https://polymarket-upload.s3.us-east-2.amazonaws.com/trump1+copy.png
                    rewards_max_spread: 99
                    rewards_min_size: 10
                    market_competitiveness: 0.42
                    tokens:
                      - token_id: >-
                          1343197538147866997676250008839231694243646439454152539053893078719042421992
                        outcome: 'YES'
                        price: 0.8
                      - token_id: >-
                          16678291189211314787145083999015737376658799626183230671758641503291735614088
                        outcome: 'NO'
                        price: 0.2
                    rewards_config:
                      - id: 1
                        asset_address: '0x9c4E1703476E875070EE25b56A58B008CFb8FA78'
                        start_date: '2024-03-01'
                        end_date: '2500-12-31'
                        rate_per_day: 0.25
                        total_rewards: 0
                        total_days: 174161
                      - id: 2
                        asset_address: '0x9c4E1703476E875070EE25b56A58B008CFb8FA78'
                        start_date: '2024-03-01'
                        end_date: '2024-05-31'
                        rate_per_day: 1
                        total_rewards: 92
                        total_days: 92
        '400':
          description: Bad request - Invalid market or next_cursor
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_market:
                  summary: Empty condition ID
                  value:
                    error: Invalid market
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
    PaginatedMarketReward:
      type: object
      description: Paginated list of market reward configurations
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
            $ref: '#/components/schemas/MarketReward'
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
    MarketReward:
      type: object
      description: Market with raw reward configurations
      properties:
        condition_id:
          type: string
          description: Condition ID of the market
        question:
          type: string
          description: Market question
        market_slug:
          type: string
          description: URL slug for the market
        event_slug:
          type: string
          description: URL slug for the event
        image:
          type: string
          description: URL to market image
        rewards_max_spread:
          type: number
          description: Maximum spread for rewards eligibility
        rewards_min_size:
          type: number
          description: Minimum order size for rewards eligibility
        market_competitiveness:
          type: number
          format: double
          description: Competitiveness score of the market
        tokens:
          type: array
          items:
            $ref: '#/components/schemas/RewardsToken'
        rewards_config:
          type: array
          items:
            $ref: '#/components/schemas/RewardsConfig'
      required:
        - condition_id
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