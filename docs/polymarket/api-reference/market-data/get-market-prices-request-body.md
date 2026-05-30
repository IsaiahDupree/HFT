> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get market prices (request body)

> Retrieves market prices for multiple token IDs and sides using a request body.
Each request must include both token_id and side.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml post /prices
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
  /prices:
    post:
      tags:
        - Market Data
      summary: Get market prices (request body)
      description: >
        Retrieves market prices for multiple token IDs and sides using a request
        body.

        Each request must include both token_id and side.
      operationId: getPricesPost
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
                side: BUY
              - token_id: 0xdef456abc123...
                side: SELL
      responses:
        '200':
          description: Successfully retrieved market prices
          content:
            application/json:
              schema:
                type: object
                additionalProperties:
                  type: object
                  additionalProperties:
                    type: number
                    format: double
                description: Map of token ID to map of side to price
              example:
                0xabc123def456...:
                  BUY: 0.45
                0xdef456abc123...:
                  SELL: 0.52
        '400':
          description: Bad request - Invalid payload or side
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_payload:
                  summary: Invalid payload
                  value:
                    error: Invalid payload
                invalid_side:
                  summary: Invalid side
                  value:
                    error: Invalid side
        '404':
          description: Not found - No orderbook exists for the requested token id
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: No orderbook exists for the requested token id
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Internal server error
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

````