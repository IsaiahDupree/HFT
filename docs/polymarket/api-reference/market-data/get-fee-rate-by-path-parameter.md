> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get fee rate by path parameter

> Retrieves the base fee rate for a specific token ID using the token ID as a path parameter.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /fee-rate/{token_id}
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
  /fee-rate/{token_id}:
    get:
      tags:
        - Market Data
      summary: Get fee rate by path parameter
      description: >
        Retrieves the base fee rate for a specific token ID using the token ID
        as a path parameter.
      operationId: getFeeRateByPath
      parameters:
        - name: token_id
          in: path
          description: Token ID (asset ID)
          required: true
          schema:
            type: string
          example: 0xabc123def456...
      responses:
        '200':
          description: Successfully retrieved fee rate
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/FeeRate'
              example:
                base_fee: 30
        '400':
          description: Bad request - Invalid token id
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid token id
        '404':
          description: Not found - Fee rate not found for market
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: fee rate not found for market
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
    FeeRate:
      type: object
      required:
        - base_fee
      properties:
        base_fee:
          type: integer
          format: int64
          description: Base fee in basis points
          example: 30
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