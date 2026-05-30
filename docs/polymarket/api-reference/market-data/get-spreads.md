> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get spreads

> Retrieves spreads for multiple token IDs.
The spread is the difference between the best ask and best bid prices.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml post /spreads
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
  /spreads:
    post:
      tags:
        - Market Data
      summary: Get spreads
      description: |
        Retrieves spreads for multiple token IDs.
        The spread is the difference between the best ask and best bid prices.
      operationId: getSpreads
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
          description: Successfully retrieved spreads
          content:
            application/json:
              schema:
                type: object
                additionalProperties:
                  type: string
                description: Map of token ID to spread
              example:
                0xabc123def456...: '0.02'
                0xdef456abc123...: '0.015'
        '400':
          description: Bad request - Invalid payload
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid payload
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: error getting the spread
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