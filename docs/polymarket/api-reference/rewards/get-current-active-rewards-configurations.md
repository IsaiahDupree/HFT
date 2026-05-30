> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get current active rewards configurations

> Returns all current active rewards configurations grouped by market.

When `sponsored=true`, returns sponsored reward configurations instead.

Results are paginated (500 items per page). Use next_cursor to fetch subsequent pages.
A next_cursor value of "LTE=" indicates the last page.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /rewards/markets/current
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
  /rewards/markets/current:
    get:
      tags:
        - Rewards
      summary: Get current active rewards configurations
      description: >
        Returns all current active rewards configurations grouped by market.


        When `sponsored=true`, returns sponsored reward configurations instead.


        Results are paginated (500 items per page). Use next_cursor to fetch
        subsequent pages.

        A next_cursor value of "LTE=" indicates the last page.
      operationId: getCurrentRewards
      parameters:
        - name: sponsored
          in: query
          description: >-
            If true, returns sponsored reward configurations instead of standard
            ones
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
          description: Successfully retrieved current rewards configurations
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaginatedCurrentReward'
              example:
                limit: 500
                count: 1
                next_cursor: LTE=
                data:
                  - condition_id: >-
                      0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af
                    rewards_max_spread: 99
                    rewards_min_size: 10
                    rewards_config:
                      - id: 0
                        asset_address: '0x9c4E1703476E875070EE25b56A58B008CFb8FA78'
                        start_date: '2024-03-01'
                        end_date: '2500-12-31'
                        rate_per_day: 2
                        total_rewards: 92
                      - id: 0
                        asset_address: '0x69308FB512518e39F9b16112fA8d994F4e2Bf8bB'
                        start_date: '2024-03-01'
                        end_date: '2500-12-31'
                        rate_per_day: 1
                        total_rewards: 46
                    sponsored_daily_rate: 0.5
                    sponsors_count: 2
                    native_daily_rate: 2.5
                    total_daily_rate: 3
        '400':
          description: Bad request - Invalid next_cursor
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
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
    PaginatedCurrentReward:
      type: object
      description: Paginated list of current reward configurations
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
            $ref: '#/components/schemas/CurrentReward'
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
    CurrentReward:
      type: object
      description: Current active reward configuration for a market
      properties:
        condition_id:
          type: string
          description: Condition ID of the market
        rewards_max_spread:
          type: number
          description: Maximum spread for rewards eligibility
        rewards_min_size:
          type: number
          description: Minimum order size for rewards eligibility
        rewards_config:
          type: array
          items:
            $ref: '#/components/schemas/CurrentRewardConfig'
        sponsored_daily_rate:
          type: number
          format: double
          description: Sponsored daily rate (omitted when zero)
        sponsors_count:
          type: integer
          description: Number of sponsors (omitted when zero)
        native_daily_rate:
          type: number
          format: double
          description: Computed native daily rate excluding sponsors (omitted when zero)
        total_daily_rate:
          type: number
          format: double
          description: Computed total daily rate including sponsors (omitted when zero)
      required:
        - condition_id
    CurrentRewardConfig:
      type: object
      description: Reward configuration entry for a current rewards market
      properties:
        id:
          type: integer
          description: Rewards config ID (always 0 on /rewards/markets/current)
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
      required:
        - asset_address
        - start_date
        - rate_per_day

````