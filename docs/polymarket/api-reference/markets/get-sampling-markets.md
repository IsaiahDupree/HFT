> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get sampling markets



## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /sampling-markets
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
  /sampling-markets:
    get:
      tags:
        - Markets
      summary: Get sampling markets
      operationId: getSamplingMarkets
      parameters:
        - name: next_cursor
          in: query
          required: false
          schema:
            type: string
      responses:
        '200':
          description: Successful response
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaginatedMarkets'
        '400':
          description: Invalid request
        '500':
          description: Internal server error
      security: []
components:
  schemas:
    PaginatedMarkets:
      type: object
      properties:
        limit:
          type: integer
        next_cursor:
          type: string
        count:
          type: integer
        data:
          type: array
          items:
            $ref: '#/components/schemas/Market'
    Market:
      type: object
      properties:
        enable_order_book:
          type: boolean
        active:
          type: boolean
        closed:
          type: boolean
        archived:
          type: boolean
        accepting_orders:
          type: boolean
        accepting_order_timestamp:
          type: string
          format: date-time
        minimum_order_size:
          type: number
          format: double
        minimum_tick_size:
          type: number
          format: double
        condition_id:
          type: string
        question_id:
          type: string
        question:
          type: string
        description:
          type: string
        market_slug:
          type: string
        end_date_iso:
          type: string
          format: date-time
        game_start_time:
          type: string
          format: date-time
        seconds_delay:
          type: integer
        fpmm:
          type: string
        maker_base_fee:
          type: integer
          format: int64
        taker_base_fee:
          type: integer
          format: int64
        notifications_enabled:
          type: boolean
        neg_risk:
          type: boolean
        neg_risk_market_id:
          type: string
        neg_risk_request_id:
          type: string
        icon:
          type: string
        image:
          type: string
        rewards:
          $ref: '#/components/schemas/Rewards'
        is_50_50_outcome:
          type: boolean
        tokens:
          type: array
          items:
            $ref: '#/components/schemas/Token'
        tags:
          type: array
          items:
            type: string
    Rewards:
      type: object
      properties:
        rates:
          type: array
          items:
            type: object
            properties:
              asset_address:
                type: string
              rewards_daily_rate:
                type: number
                format: double
        min_size:
          type: number
          format: double
        max_spread:
          type: number
          format: double
    Token:
      type: object
      properties:
        token_id:
          type: string
        outcome:
          type: string
        price:
          type: number
          format: double
        winner:
          type: boolean

````