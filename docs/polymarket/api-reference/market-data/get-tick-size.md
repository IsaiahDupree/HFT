> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get tick size

> Retrieves the minimum tick size (price increment) for a specific token ID.
The tick size can be provided either as a query parameter or as a path parameter.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /tick-size
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
  /tick-size:
    get:
      tags:
        - Market Data
      summary: Get tick size
      description: >
        Retrieves the minimum tick size (price increment) for a specific token
        ID.

        The tick size can be provided either as a query parameter or as a path
        parameter.
      operationId: getTickSize
      parameters:
        - name: token_id
          in: query
          description: Token ID (asset ID)
          required: false
          schema:
            type: string
          example: 0xabc123def456...
      responses:
        '200':
          description: Successfully retrieved tick size
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TickSize'
              example:
                minimum_tick_size: 0.01
        '400':
          description: Bad request - Invalid token id
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid token id
        '404':
          description: Not found - Market not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: market not found
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
    TickSize:
      type: object
      required:
        - minimum_tick_size
      properties:
        minimum_tick_size:
          type: number
          format: double
          description: Minimum tick size (price increment)
          example: 0.01
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