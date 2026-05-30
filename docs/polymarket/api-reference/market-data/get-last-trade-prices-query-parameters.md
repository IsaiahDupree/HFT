> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get last trade prices (query parameters)

> Retrieves last trade prices for multiple token IDs using query parameters.
Maximum 500 token IDs can be requested per call.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /last-trades-prices
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
  /last-trades-prices:
    get:
      tags:
        - Market Data
      summary: Get last trade prices (query parameters)
      description: >
        Retrieves last trade prices for multiple token IDs using query
        parameters.

        Maximum 500 token IDs can be requested per call.
      operationId: getLastTradesPricesGet
      parameters:
        - name: token_ids
          in: query
          description: Comma-separated list of token IDs (max 500)
          required: true
          schema:
            type: string
          example: 0xabc123...,0xdef456...
      responses:
        '200':
          description: Successfully retrieved last trade prices
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  required:
                    - token_id
                    - price
                    - side
                  properties:
                    token_id:
                      type: string
                      description: Token ID (asset ID)
                      example: 0xabc123def456...
                    price:
                      type: string
                      description: Last trade price
                      example: '0.45'
                    side:
                      type: string
                      description: Last trade side (BUY or SELL)
                      enum:
                        - BUY
                        - SELL
                      example: BUY
              example:
                - token_id: 0xabc123def456...
                  price: '0.45'
                  side: BUY
                - token_id: 0xdef456abc123...
                  price: '0.52'
                  side: SELL
        '400':
          description: Bad request - Invalid payload or exceeds limit
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_payload:
                  summary: Invalid payload
                  value:
                    error: Invalid payload
                exceeds_limit:
                  summary: Payload exceeds limit
                  value:
                    error: Payload exceeds the limit
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