> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get single order by ID

> Retrieves a specific order by its ID (order hash) for the authenticated user.
Builder-authenticated clients can also use this endpoint to retrieve orders attributed to their builder account.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /data/order/{orderID}
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
  /data/order/{orderID}:
    get:
      tags:
        - Trade
      summary: Get single order by ID
      description: >
        Retrieves a specific order by its ID (order hash) for the authenticated
        user.

        Builder-authenticated clients can also use this endpoint to retrieve
        orders attributed to their builder account.
      operationId: getOrder
      parameters:
        - name: orderID
          in: path
          description: Order ID (order hash)
          required: true
          schema:
            type: string
          example: '0x0000000000000000000000000000000000000000000000000000000000000001'
      responses:
        '200':
          description: Successfully retrieved order
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OpenOrder'
              example:
                id: '0xabcdef1234567890abcdef1234567890abcdef12'
                status: ORDER_STATUS_LIVE
                owner: f4f247b7-4ac7-ff29-a152-04fda0a8755a
                maker_address: '0x1234567890123456789012345678901234567890'
                market: >-
                  0x0000000000000000000000000000000000000000000000000000000000000001
                asset_id: 0xabc123def456...
                side: BUY
                original_size: '100000000'
                size_matched: '0'
                price: '0.5'
                outcome: 'YES'
                expiration: '1735689600'
                order_type: GTC
                associate_trades: []
                created_at: 1700000000
        '400':
          description: Bad request - Invalid order ID
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid orderID
        '401':
          description: Unauthorized - Invalid API key or authentication failed
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid API key
        '404':
          description: Order not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Order not found
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
    OpenOrder:
      type: object
      required:
        - id
        - status
        - owner
        - maker_address
        - market
        - asset_id
        - side
        - original_size
        - size_matched
        - price
        - expiration
        - order_type
        - created_at
        - outcome
      properties:
        id:
          type: string
          description: Order ID (order hash)
          example: '0xabcdef1234567890abcdef1234567890abcdef12'
        status:
          type: string
          description: Order status
          enum:
            - ORDER_STATUS_LIVE
            - ORDER_STATUS_INVALID
            - ORDER_STATUS_CANCELED_MARKET_RESOLVED
            - ORDER_STATUS_CANCELED
            - ORDER_STATUS_MATCHED
        owner:
          type: string
          description: UUID of the order owner
          example: f4f247b7-4ac7-ff29-a152-04fda0a8755a
        maker_address:
          type: string
          description: Ethereum address of the maker
          example: '0x1234567890123456789012345678901234567890'
        market:
          type: string
          description: Market (condition ID)
          example: '0x0000000000000000000000000000000000000000000000000000000000000001'
        asset_id:
          type: string
          description: Asset ID (token ID)
          example: 0xabc123def456...
        side:
          type: string
          description: Order side
          enum:
            - BUY
            - SELL
          example: BUY
        original_size:
          type: string
          description: Original order size in fixed-math with 6 decimals
          example: '100000000'
        size_matched:
          type: string
          description: Size that has been matched in fixed-math with 6 decimals
          example: '0'
        price:
          type: string
          description: Order price
          example: '0.5'
        outcome:
          type: string
          description: Market outcome (YES/NO)
          example: 'YES'
        expiration:
          type: string
          description: Unix timestamp when the order expires
          example: '1735689600'
        order_type:
          type: string
          description: Order type
          enum:
            - GTC
            - FOK
            - GTD
            - FAK
          example: GTC
        associate_trades:
          type: array
          description: Array of associated trade IDs
          items:
            type: string
          example:
            - trade-123
        created_at:
          type: integer
          description: Unix timestamp when the order was created
          example: 1700000000
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