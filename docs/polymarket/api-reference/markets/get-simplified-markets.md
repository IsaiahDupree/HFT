> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get simplified markets



## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /simplified-markets
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
  /simplified-markets:
    get:
      tags:
        - Markets
      summary: Get simplified markets
      operationId: getSimplifiedMarkets
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
                $ref: '#/components/schemas/PaginatedSimplifiedMarkets'
        '400':
          description: Invalid request
        '500':
          description: Internal server error
      security: []
components:
  schemas:
    PaginatedSimplifiedMarkets:
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
            $ref: '#/components/schemas/SimplifiedMarket'
    SimplifiedMarket:
      type: object
      properties:
        condition_id:
          type: string
        rewards:
          $ref: '#/components/schemas/Rewards'
        tokens:
          type: array
          items:
            $ref: '#/components/schemas/Token'
        active:
          type: boolean
        closed:
          type: boolean
        archived:
          type: boolean
        accepting_orders:
          type: boolean
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