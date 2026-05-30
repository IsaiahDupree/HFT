> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get order books (request body)

> Retrieves order book summaries for multiple token IDs using a request body.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml post /books
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
  /books:
    post:
      tags:
        - Market Data
      summary: Get order books (request body)
      description: >
        Retrieves order book summaries for multiple token IDs using a request
        body.
      operationId: getBooksPost
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: array
              items:
                $ref: '#/components/schemas/BookRequest'
            example:
              - token_id: 0xabc123def456...
              - token_id: 0xdef456abc123...
      responses:
        '200':
          description: Successfully retrieved order books
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/OrderBookSummary'
              example:
                - market: '0x1234567890123456789012345678901234567890'
                  asset_id: 0xabc123def456...
                  timestamp: '1234567890'
                  hash: a1b2c3d4e5f6...
                  bids:
                    - price: '0.45'
                      size: '100'
                  asks:
                    - price: '0.46'
                      size: '150'
                  min_order_size: '1'
                  tick_size: '0.01'
                  neg_risk: false
                  last_trade_price: '0.45'
        '400':
          description: Bad request - Invalid payload
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid payload
      security: []
components:
  schemas:
    BookRequest:
      type: object
      required:
        - token_id
      properties:
        token_id:
          type: string
          description: Token ID (asset ID)
          example: 0xabc123def456...
        side:
          type: string
          description: Order side (optional, not used for midpoint calculation)
          enum:
            - BUY
            - SELL
          example: BUY
    OrderBookSummary:
      type: object
      required:
        - market
        - asset_id
        - timestamp
        - hash
        - bids
        - asks
        - min_order_size
        - tick_size
        - neg_risk
        - last_trade_price
      properties:
        market:
          type: string
          description: Market condition ID
          example: '0x1234567890123456789012345678901234567890'
        asset_id:
          type: string
          description: Token ID (asset ID)
          example: 0xabc123def456...
        timestamp:
          type: string
          description: Timestamp of the order book snapshot
          example: '1234567890'
        hash:
          type: string
          description: Hash of the order book summary
          example: a1b2c3d4e5f6...
        bids:
          type: array
          description: List of bid orders (sorted by price descending)
          items:
            $ref: '#/components/schemas/OrderSummary'
        asks:
          type: array
          description: List of ask orders (sorted by price ascending)
          items:
            $ref: '#/components/schemas/OrderSummary'
        min_order_size:
          type: string
          description: Minimum order size
          example: '1'
        tick_size:
          type: string
          description: Minimum price increment (tick size)
          example: '0.01'
        neg_risk:
          type: boolean
          description: Whether negative risk is enabled for this market
          example: false
        last_trade_price:
          type: string
          description: Last trade price
          example: '0.45'
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
    OrderSummary:
      type: object
      required:
        - price
        - size
      properties:
        price:
          type: string
          description: Order price
          example: '0.45'
        size:
          type: string
          description: Order size
          example: '100'

````