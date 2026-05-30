> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Post multiple orders

> Creates multiple new orders in the order book. Orders are processed in parallel.
Maximum 15 orders per request.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml post /orders
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
  /orders:
    post:
      tags:
        - Trade
      summary: Post multiple orders
      description: >
        Creates multiple new orders in the order book. Orders are processed in
        parallel.

        Maximum 15 orders per request.
      operationId: postOrders
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: array
              items:
                $ref: '#/components/schemas/SendOrder'
              maxItems: 15
            examples:
              example:
                summary: Send multiple orders example
                value:
                  - order:
                      maker: '0x1234567890123456789012345678901234567890'
                      signer: '0x1234567890123456789012345678901234567890'
                      tokenId: 0xabc123def456...
                      makerAmount: '100000000'
                      takerAmount: '200000000'
                      side: BUY
                      expiration: '1735689600'
                      timestamp: '1735689600000'
                      metadata: ''
                      builder: >-
                        0x0000000000000000000000000000000000000000000000000000000000000000
                      signature: 0x1234abcd...
                      salt: 1234567890
                      signatureType: 0
                    owner: f4f247b7-4ac7-ff29-a152-04fda0a8755a
                    orderType: GTC
                    deferExec: false
                    postOnly: false
                  - order:
                      maker: '0x1234567890123456789012345678901234567890'
                      signer: '0x1234567890123456789012345678901234567890'
                      tokenId: 0xdef456abc789...
                      makerAmount: '200000000'
                      takerAmount: '100000000'
                      side: SELL
                      expiration: '1735689600'
                      timestamp: '1735689600000'
                      metadata: ''
                      builder: >-
                        0x0000000000000000000000000000000000000000000000000000000000000000
                      signature: 0x5678efgh...
                      salt: 1234567891
                      signatureType: 0
                    owner: f4f247b7-4ac7-ff29-a152-04fda0a8755a
                    orderType: GTC
                    deferExec: false
                    postOnly: false
      responses:
        '200':
          description: >-
            Orders successfully processed. Returns an array of order responses,
            one for each order in the request.
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/SendOrderResponse'
              examples:
                mixed_results:
                  summary: Mixed order results
                  value:
                    - success: true
                      orderID: '0xabcdef1234567890abcdef1234567890abcdef12'
                      status: live
                      makingAmount: '100000000'
                      takingAmount: '200000000'
                      errorMsg: ''
                    - success: true
                      orderID: '0xfedcba0987654321fedcba0987654321fedcba09'
                      status: matched
                      makingAmount: '200000000'
                      takingAmount: '100000000'
                      transactionsHashes:
                        - '0x1234567890abcdef1234567890abcdef12345678'
                      tradeIDs:
                        - trade-123
                      errorMsg: ''
                    - success: false
                      orderID: ''
                      status: delayed
                      errorMsg: 'Rate limit exceeded for tokenId: 0xdef456abc789...'
                post_only_mode:
                  summary: Post-only mode results
                  value:
                    - errorMsg: >-
                        post-only mode: only post-only orders and cancels are
                        allowed
                      orderID: ''
                      takingAmount: ''
                      makingAmount: ''
                      status: ''
                      success: true
                    - errorMsg: >-
                        post-only mode: only post-only orders and cancels are
                        allowed
                      orderID: ''
                      takingAmount: ''
                      makingAmount: ''
                      status: ''
                      success: true
        '400':
          description: Bad request - Invalid order payload or validation error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_payload:
                  summary: Invalid order payload
                  value:
                    error: Invalid order payload
                empty_payload:
                  summary: Empty orders array
                  value:
                    error: Invalid order payload
                too_many_orders:
                  summary: Too many orders
                  value:
                    error: 'Too many orders in payload: 20, max allowed: 15'
                owner_mismatch:
                  summary: Owner mismatch
                  value:
                    error: the order owner has to be the owner of the API KEY
                signer_mismatch:
                  summary: Signer mismatch
                  value:
                    error: >-
                      the order signer address has to be the address of the API
                      KEY
                banned_address:
                  summary: Banned address
                  value:
                    error: '''0x1234...'' address banned'
                closed_only_mode:
                  summary: Closed only mode violation
                  value:
                    error: '''0x1234...'' address in closed only mode'
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
                error: could not insert order
        '503':
          description: Service unavailable - Trading disabled or cancel-only mode
          headers:
            Retry-After:
              description: Seconds to wait before retrying when provided by post-only mode.
              schema:
                type: integer
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                trading_disabled:
                  summary: Trading disabled
                  value:
                    error: >-
                      Trading is currently disabled. Check polymarket.com for
                      updates
                cancel_only:
                  summary: Cancel-only mode
                  value:
                    error: >-
                      Trading is currently cancel-only. New orders are not
                      accepted, but cancels are allowed.
                post_only_mode:
                  summary: Post-only mode
                  value:
                    error: >-
                      post-only mode: only post-only orders and cancels are
                      allowed
                    code: post_only_mode
                    retry_after_seconds: 79
      security:
        - polyApiKey: []
          polyAddress: []
          polySignature: []
          polyPassphrase: []
          polyTimestamp: []
components:
  schemas:
    SendOrder:
      type: object
      required:
        - order
        - owner
      properties:
        order:
          $ref: '#/components/schemas/Order'
        owner:
          type: string
          description: UUID of the API key owner
          example: f4f247b7-4ac7-ff29-a152-04fda0a8755a
        orderType:
          type: string
          description: Time in force
          enum:
            - GTC
            - FOK
            - GTD
            - FAK
          default: GTC
        deferExec:
          type: boolean
          description: Whether to defer execution
          default: false
        postOnly:
          type: boolean
          description: >-
            Whether the order must rest on the book and not match immediately.
            Only supported for GTC and GTD orders.
          default: false
    SendOrderResponse:
      type: object
      required:
        - success
        - orderID
        - status
      properties:
        success:
          type: boolean
          description: Whether the order was successfully processed
          example: true
        orderID:
          type: string
          description: Unique identifier for the order (order hash)
          example: '0xabcdef1234567890abcdef1234567890abcdef12'
        status:
          type: string
          description: Status of the order after processing
          enum:
            - live
            - matched
            - delayed
        makingAmount:
          type: string
          description: Amount the maker is providing in fixed-math with 6 decimals
          example: '100000000'
        takingAmount:
          type: string
          description: Amount the taker is providing in fixed-math with 6 decimals
          example: '200000000'
        transactionsHashes:
          type: array
          description: Array of transaction hashes (present when status is 'matched')
          items:
            type: string
          example:
            - '0x1234567890abcdef1234567890abcdef12345678'
        tradeIDs:
          type: array
          description: Array of trade IDs (present when status is 'matched')
          items:
            type: string
        errorMsg:
          type: string
          description: Error message (empty on success)
          example: ''
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
    Order:
      type: object
      description: >
        Order payload submitted to the CLOB API. In CLOB V2, `expiration`
        remains in

        the POST /order wire body for GTD/order-expiry handling, but it is not
        part

        of the EIP-712 signed order struct.
      required:
        - maker
        - signer
        - tokenId
        - makerAmount
        - takerAmount
        - side
        - expiration
        - timestamp
        - builder
        - signature
        - salt
        - signatureType
      properties:
        maker:
          type: string
          description: >-
            Ethereum address of the maker (In the default case, this is your
            proxy address)
          example: '0x1234567890123456789012345678901234567890'
        signer:
          type: string
          description: Ethereum address of the signer
          example: '0x1234567890123456789012345678901234567890'
        tokenId:
          type: string
          description: Token ID (asset ID) for the order
          example: 0xabc123def456...
        makerAmount:
          type: string
          description: Amount the maker is providing in fixed-math with 6 decimals
          example: '100000000'
        takerAmount:
          type: string
          description: Amount the taker is providing in fixed-math with 6 decimals
          example: '200000000'
        side:
          type: string
          description: Order side
          enum:
            - BUY
            - SELL
          example: BUY
        expiration:
          type: string
          description: >-
            Unix timestamp when the order expires. Present in the API wire body;
            not part of the CLOB V2 EIP-712 signed order struct.
          example: '1735689600'
        timestamp:
          type: string
          description: >-
            Unix timestamp in milliseconds when the order was created (used for
            order uniqueness)
          example: '1735689600000'
        metadata:
          type: string
          description: Reserved for future use
          example: ''
        builder:
          type: string
          description: >-
            Builder code (bytes32) for integrator attribution. `0x` + 64 hex
            chars or empty.
          example: '0x0000000000000000000000000000000000000000000000000000000000000000'
        signature:
          type: string
          description: Cryptographic signature of the order
          example: 0x1234abcd...
        salt:
          type: integer
          description: Random salt for order uniqueness
          example: 1234567890
        signatureType:
          type: integer
          description: Type of signature (0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE)
          enum:
            - 0
            - 1
            - 2
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