> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get trades

> Retrieves trades for the authenticated user. Returns paginated results.
Requires readonly or level 2 API key authentication.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /data/trades
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
  /data/trades:
    get:
      tags:
        - Trade
      summary: Get trades
      description: |
        Retrieves trades for the authenticated user. Returns paginated results.
        Requires readonly or level 2 API key authentication.
      operationId: getTrades
      parameters:
        - name: id
          in: query
          description: Trade ID to filter by specific trade
          required: false
          schema:
            type: string
          example: trade-123
        - name: maker_address
          in: query
          description: Maker address to filter trades
          required: true
          schema:
            type: string
            pattern: ^0x[a-fA-F0-9]{40}$
          example: '0x1234567890123456789012345678901234567890'
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
          description: Successfully retrieved trades
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TradesResponse'
              examples:
                example:
                  summary: User trades response
                  value:
                    limit: 100
                    next_cursor: MTAw
                    count: 2
                    data:
                      - id: trade-123
                        taker_order_id: '0xabcdef1234567890abcdef1234567890abcdef12'
                        market: >-
                          0x0000000000000000000000000000000000000000000000000000000000000001
                        asset_id: >-
                          15871154585880608648532107628464183779895785213830018178010423617714102767076
                        side: BUY
                        size: '100000000'
                        fee_rate_bps: '30'
                        price: '0.5'
                        status: TRADE_STATUS_CONFIRMED
                        match_time: '1700000000'
                        last_update: '1700000000'
                        outcome: 'YES'
                        bucket_index: 0
                        owner: f4f247b7-4ac7-ff29-a152-04fda0a8755a
                        maker_address: '0x1234567890123456789012345678901234567890'
                        transaction_hash: >-
                          0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
                        trader_side: TAKER
                        maker_orders: []
        '400':
          description: Bad request - Invalid parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid trade params payload
        '401':
          description: Unauthorized - Invalid API key or authentication failed
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid API key
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Internal server error
      security:
        - polyApiKey: []
          polyAddress: []
          polySignature: []
          polyPassphrase: []
          polyTimestamp: []
components:
  schemas:
    TradesResponse:
      type: object
      description: Paginated trades response
      required:
        - limit
        - next_cursor
        - count
        - data
      properties:
        limit:
          type: integer
          description: Maximum number of items per page
          example: 100
        next_cursor:
          type: string
          description: >-
            Cursor for next page (base64 encoded offset). "LTE=" indicates no
            more pages
          example: MTAw
        count:
          type: integer
          description: Number of items in current response
          example: 2
        data:
          type: array
          description: Array of trades
          items:
            $ref: '#/components/schemas/Trade'
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
    Trade:
      type: object
      description: Trade information
      required:
        - id
        - taker_order_id
        - market
        - asset_id
        - side
        - size
        - price
        - status
        - match_time
        - last_update
        - outcome
        - bucket_index
        - owner
        - maker_address
        - trader_side
      properties:
        id:
          type: string
          description: Trade ID
          example: trade-123
        taker_order_id:
          type: string
          description: Taker order ID (hash)
          example: '0xabcdef1234567890abcdef1234567890abcdef12'
        market:
          type: string
          description: Market (condition ID)
          pattern: ^0x[a-fA-F0-9]{64}$
          example: '0x0000000000000000000000000000000000000000000000000000000000000001'
        asset_id:
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
        fee_rate_bps:
          type: string
          description: Fee rate in basis points
          example: '30'
        price:
          type: string
          description: Trade price
          example: '0.5'
        status:
          type: string
          description: Trade status
          enum:
            - TRADE_STATUS_CONFIRMED
            - TRADE_STATUS_FAILED
            - TRADE_STATUS_RETRYING
            - TRADE_STATUS_MATCHED
            - TRADE_STATUS_MINED
          example: TRADE_STATUS_CONFIRMED
        match_time:
          type: string
          description: Match time (Unix timestamp)
          example: '1700000000'
        match_time_nano:
          type: string
          description: Match time in nanoseconds
          example: '1700000000000000000'
        last_update:
          type: string
          description: Last update time (Unix timestamp)
          example: '1700000000'
        outcome:
          type: string
          description: Market outcome
          example: 'YES'
        bucket_index:
          type: integer
          description: Bucket index
          example: 0
        owner:
          type: string
          description: Owner UUID
          example: f4f247b7-4ac7-ff29-a152-04fda0a8755a
        maker_address:
          type: string
          description: Maker address
          pattern: ^0x[a-fA-F0-9]{40}$
          example: '0x1234567890123456789012345678901234567890'
        transaction_hash:
          type: string
          description: Transaction hash
          pattern: ^0x[a-fA-F0-9]{64}$
          example: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
        err_msg:
          type:
            - string
            - 'null'
          description: Error message (if any)
          example: null
        maker_orders:
          type: array
          description: Array of maker orders associated with this trade
          items:
            type: object
            properties:
              order_id:
                type: string
                description: Order ID (hash)
              owner:
                type: string
                description: Owner UUID
              maker_address:
                type: string
                description: Maker address
              matched_amount:
                type: string
                description: Matched amount
              price:
                type: string
                description: Price
              fee_rate_bps:
                type: string
                description: Fee rate in basis points
              asset_id:
                type: string
                description: Asset ID
              outcome:
                type: string
                description: Outcome
              side:
                type: string
                enum:
                  - BUY
                  - SELL
          example: []
        trader_side:
          type: string
          description: Trader side (TAKER or MAKER)
          enum:
            - TAKER
            - MAKER
          example: TAKER
  securitySchemes:
    polyApiKey:
      type: apiKey
      in: header
      name: POLY_API_KEY
      description: Your API key
    polyAddress:
      type: apiKey
      in: header
      name: POLY_ADDRESS
      description: Ethereum address associated with the API key
    polySignature:
      type: apiKey
      in: header
      name: POLY_SIGNATURE
      description: HMAC signature of the request
    polyPassphrase:
      type: apiKey
      in: header
      name: POLY_PASSPHRASE
      description: API key passphrase
    polyTimestamp:
      type: apiKey
      in: header
      name: POLY_TIMESTAMP
      description: Unix timestamp of the request

````