> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get builder trades

> Retrieves trades attributed to a builder code.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /builder/trades
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
  /builder/trades:
    get:
      tags:
        - Trade
      summary: Get builder trades
      description: |
        Retrieves trades attributed to a builder code.
      operationId: getBuilderTrades
      parameters:
        - name: builder_code
          in: query
          description: Builder code to fetch attributed trades for
          required: true
          schema:
            type: string
            pattern: ^0x[a-fA-F0-9]{64}$
          example: '0x0000000000000000000000000000000000000000000000000000000000000001'
        - name: id
          in: query
          description: Trade ID to filter by specific trade
          required: false
          schema:
            type: string
          example: trade-123
        - name: market
          in: query
          description: Market (condition ID) to filter trades
          required: false
          schema:
            type: string
            pattern: ^0x[a-fA-F0-9]{64}$
          example: '0x0000000000000000000000000000000000000000000000000000000000000001'
        - name: asset_id
          in: query
          description: Asset ID (token ID) to filter trades
          required: false
          schema:
            type: string
          example: >-
            15871154585880608648532107628464183779895785213830018178010423617714102767076
        - name: before
          in: query
          description: Filter trades before this Unix timestamp
          required: false
          schema:
            type: string
            pattern: ^\d+$
          example: '1700000000'
        - name: after
          in: query
          description: Filter trades after this Unix timestamp
          required: false
          schema:
            type: string
            pattern: ^\d+$
          example: '1600000000'
        - name: next_cursor
          in: query
          description: Cursor for pagination (base64 encoded offset)
          required: false
          schema:
            type: string
          example: MA==
      responses:
        '200':
          description: Successfully retrieved builder trades
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/BuilderTradesResponse'
              examples:
                example:
                  summary: Builder trades response
                  value:
                    limit: 300
                    next_cursor: MzAw
                    count: 2
                    data:
                      - id: trade-123
                        tradeType: TAKER
                        takerOrderHash: '0xabcdef1234567890abcdef1234567890abcdef12'
                        builder: >-
                          0x0000000000000000000000000000000000000000000000000000000000000001
                        market: >-
                          0x0000000000000000000000000000000000000000000000000000000000000001
                        assetId: >-
                          15871154585880608648532107628464183779895785213830018178010423617714102767076
                        side: BUY
                        size: '100000000'
                        sizeUsdc: '50000000'
                        price: '0.5'
                        status: TRADE_STATUS_CONFIRMED
                        outcome: 'YES'
                        outcomeIndex: 0
                        owner: f4f247b7-4ac7-ff29-a152-04fda0a8755a
                        maker: '0x1234567890123456789012345678901234567890'
                        transactionHash: >-
                          0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
                        matchTime: '1700000000'
                        bucketIndex: 0
                        fee: '300000'
                        feeUsdc: '150000'
                        createdAt: '2024-01-01T00:00:00Z'
                        updatedAt: '2024-01-01T00:00:00Z'
        '400':
          description: Bad request - Invalid parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: invalid builder trade params
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: could not fetch builder trades
components:
  schemas:
    BuilderTradesResponse:
      type: object
      description: Paginated builder trades response
      required:
        - limit
        - next_cursor
        - count
        - data
      properties:
        limit:
          type: integer
          description: Maximum number of items per page
          example: 300
        next_cursor:
          type: string
          description: >-
            Cursor for next page (base64 encoded offset). "LTE=" indicates no
            more pages
          example: MzAw
        count:
          type: integer
          description: Number of items in current response
          example: 2
        data:
          type: array
          description: Array of builder trades
          items:
            $ref: '#/components/schemas/BuilderTrade'
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
    BuilderTrade:
      type: object
      description: Builder trade information
      required:
        - id
        - tradeType
        - takerOrderHash
        - builder
        - market
        - assetId
        - side
        - size
        - sizeUsdc
        - price
        - status
        - outcome
        - outcomeIndex
        - owner
        - maker
        - transactionHash
        - matchTime
        - bucketIndex
        - fee
        - feeUsdc
      properties:
        id:
          type: string
          description: Trade ID
          example: trade-123
        tradeType:
          type: string
          description: Trade type
          example: TAKER
        takerOrderHash:
          type: string
          description: Taker order hash
          example: '0xabcdef1234567890abcdef1234567890abcdef12'
        builder:
          type: string
          description: Builder code attributed to the trade
          pattern: ^0x[a-fA-F0-9]{64}$
          example: '0x0000000000000000000000000000000000000000000000000000000000000001'
        market:
          type: string
          description: Market (condition ID)
          pattern: ^0x[a-fA-F0-9]{64}$
          example: '0x0000000000000000000000000000000000000000000000000000000000000001'
        assetId:
          type: string
          description: Asset ID (token ID)
          example: >-
            15871154585880608648532107628464183779895785213830018178010423617714102767076
        side:
          type: string
          description: Trade side
          enum:
            - BUY
            - SELL
          example: BUY
        size:
          type: string
          description: Trade size
          example: '100000000'
        sizeUsdc:
          type: string
          description: Trade size in USDC
          example: '50000000'
        price:
          type: string
          description: Trade price
          example: '0.5'
        status:
          type: string
          description: Trade status
          example: TRADE_STATUS_CONFIRMED
        outcome:
          type: string
          description: Market outcome
          example: 'YES'
        outcomeIndex:
          type: integer
          description: Outcome index
          example: 0
        owner:
          type: string
          description: Owner UUID
          example: f4f247b7-4ac7-ff29-a152-04fda0a8755a
        maker:
          type: string
          description: Maker address
          pattern: ^0x[a-fA-F0-9]{40}$
          example: '0x1234567890123456789012345678901234567890'
        transactionHash:
          type: string
          description: Transaction hash
          pattern: ^0x[a-fA-F0-9]{64}$
          example: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
        matchTime:
          type: string
          description: Match time (Unix timestamp)
          example: '1700000000'
        bucketIndex:
          type: integer
          description: Bucket index
          example: 0
        fee:
          type: string
          description: Fee amount
          example: '300000'
        feeUsdc:
          type: string
          description: Fee amount in USDC
          example: '150000'
        err_msg:
          type:
            - string
            - 'null'
          description: Error message (if any)
          example: null
        createdAt:
          type: string
          format: date-time
          description: Creation timestamp
          example: '2024-01-01T00:00:00Z'
        updatedAt:
          type: string
          format: date-time
          description: Last update timestamp
          example: '2024-01-01T00:00:00Z'

````