> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get order scoring status

> Checks if a specific order is currently scoring for rewards.

An order is considered "scoring" if it meets all the criteria for earning maker rewards:
- The order is live on a rewards-eligible market
- The order meets the minimum size requirements
- The order is within the valid spread range
- The order has been live for the required duration




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /order-scoring
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
  /order-scoring:
    get:
      tags:
        - Trade
      summary: Get order scoring status
      description: >
        Checks if a specific order is currently scoring for rewards.


        An order is considered "scoring" if it meets all the criteria for
        earning maker rewards:

        - The order is live on a rewards-eligible market

        - The order meets the minimum size requirements

        - The order is within the valid spread range

        - The order has been live for the required duration
      operationId: getOrderScoring
      parameters:
        - name: order_id
          in: query
          description: The order ID (order hash) to check scoring status for
          required: true
          schema:
            type: string
          example: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
      responses:
        '200':
          description: Successfully retrieved order scoring status
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderScoringResponse'
              examples:
                scoring:
                  summary: Order is scoring
                  value:
                    scoring: true
                not_scoring:
                  summary: Order is not scoring
                  value:
                    scoring: false
        '400':
          description: Bad request - Invalid order ID
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid order_id
        '401':
          description: Unauthorized - Invalid API key or order doesn't belong to user
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid API key
        '404':
          description: Market not found for the order
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
        '503':
          description: Service unavailable - Trading disabled
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: >-
                  Trading is currently disabled. Check polymarket.com for
                  updates
      security:
        - polyApiKey: []
          polyAddress: []
          polySignature: []
          polyPassphrase: []
          polyTimestamp: []
components:
  schemas:
    OrderScoringResponse:
      type: object
      description: Response indicating whether an order is currently scoring for rewards
      required:
        - scoring
      properties:
        scoring:
          type: boolean
          description: Whether the order is currently scoring for maker rewards
          example: true
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