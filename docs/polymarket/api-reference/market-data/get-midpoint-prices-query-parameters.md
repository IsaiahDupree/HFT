> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get midpoint prices (query parameters)

> Retrieves midpoint prices for multiple token IDs using query parameters.
The midpoint is calculated as the average of the best bid and best ask prices.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /midpoints
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
  /midpoints:
    get:
      tags:
        - Market Data
      summary: Get midpoint prices (query parameters)
      description: >
        Retrieves midpoint prices for multiple token IDs using query parameters.

        The midpoint is calculated as the average of the best bid and best ask
        prices.
      operationId: getMidpointsGet
      parameters:
        - name: token_ids
          in: query
          description: Comma-separated list of token IDs
          required: true
          schema:
            type: string
          example: 0xabc123...,0xdef456...
      responses:
        '200':
          description: Successfully retrieved midpoint prices
          content:
            application/json:
              schema:
                type: object
                additionalProperties:
                  type: string
                description: Map of token ID to midpoint price
              example:
                0xabc123def456...: '0.45'
                0xdef456abc123...: '0.52'
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
                error: error getting the mid price
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