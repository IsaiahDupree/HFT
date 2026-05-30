> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get CLOB market info

> Returns all CLOB-level parameters for a market in a single call —
tokens, tick size, base fees, rewards, RFQ status, and fee details.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /clob-markets/{condition_id}
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
  /clob-markets/{condition_id}:
    get:
      tags:
        - Markets
      summary: Get CLOB market info
      description: |
        Returns all CLOB-level parameters for a market in a single call —
        tokens, tick size, base fees, rewards, RFQ status, and fee details.
      operationId: getClobMarketInfo
      parameters:
        - name: condition_id
          in: path
          required: true
          description: The condition ID of the market
          schema:
            type: string
          example: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af'
      responses:
        '200':
          description: Successfully retrieved CLOB market info
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ClobMarketDetails'
        '400':
          description: Bad request - Invalid condition ID
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
components:
  schemas:
    ClobMarketDetails:
      type: object
      description: >-
        CLOB-level parameters for a market — tokens, tick size, base fees,
        rewards, RFQ status, and fee details.
      properties:
        gst:
          type: string
          format: date-time
          nullable: true
          description: >-
            Game start time (used for sports markets), ISO 8601 timestamp or
            null
        r:
          $ref: '#/components/schemas/ClobRewards'
        t:
          type: array
          description: Tokens for this market
          items:
            $ref: '#/components/schemas/ClobToken'
        mos:
          type: number
          format: float
          description: Minimum order size
          example: 5
        mts:
          type: number
          format: float
          description: Minimum tick size (price increment)
          example: 0.01
        mbf:
          type: integer
          format: int64
          description: Maker base fee in basis points
          example: 0
        tbf:
          type: integer
          format: int64
          description: Taker base fee in basis points
          example: 0
        rfqe:
          type: boolean
          description: Whether RFQ (Request for Quote) is enabled for this market
        itode:
          type: boolean
          description: Whether taker order delay is enabled
        ibce:
          type: boolean
          description: Whether Blockaid check is enabled
        fd:
          $ref: '#/components/schemas/FeeDetails'
        oas:
          type: integer
          description: Minimum order age in seconds
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
    ClobRewards:
      type: object
      description: Rewards configuration for a market.
      additionalProperties: true
    ClobToken:
      type: object
      description: A token in a CLOB market with its ID and outcome label.
      properties:
        t:
          type: string
          description: The token ID
          example: >-
            71321045679252212594626385532706912750332728571942532289631379312455583992563
        o:
          type: string
          description: Outcome label for the token (e.g. "Yes", "No")
          example: 'Yes'
    FeeDetails:
      type: object
      description: Fee curve parameters for a market.
      properties:
        r:
          type: number
          format: float
          nullable: true
          description: Fee rate
          example: 0.02
        e:
          type: number
          format: float
          nullable: true
          description: Fee curve exponent
          example: 2
        to:
          type: boolean
          nullable: true
          description: Whether fees apply to takers only
          example: true

````