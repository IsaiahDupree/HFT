> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Cancel all orders

> Cancels all open orders for the authenticated user. Works even in cancel-only mode.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml delete /cancel-all
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
  /cancel-all:
    delete:
      tags:
        - Trade
      summary: Cancel all orders
      description: >
        Cancels all open orders for the authenticated user. Works even in
        cancel-only mode.
      operationId: cancelAllOrders
      responses:
        '200':
          description: Cancellation results for all orders
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CancelOrdersResponse'
              examples:
                canceled:
                  summary: All orders canceled
                  value:
                    canceled:
                      - '0xabcdef1234567890abcdef1234567890abcdef12'
                      - '0xfedcba0987654321fedcba0987654321fedcba09'
                    not_canceled: {}
                mixed:
                  summary: Some orders canceled, some not
                  value:
                    canceled:
                      - '0xabcdef1234567890abcdef1234567890abcdef12'
                    not_canceled:
                      '0xfedcba0987654321fedcba0987654321fedcba09': Order already matched
                no_orders:
                  summary: No orders to cancel
                  value:
                    canceled: []
                    not_canceled: {}
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
                error: Internal server error
        '503':
          description: >-
            Service unavailable - Trading disabled (cancels still work in
            cancel-only mode)
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
    CancelOrdersResponse:
      type: object
      required:
        - canceled
        - not_canceled
      properties:
        canceled:
          type: array
          description: Array of order IDs that were successfully canceled
          items:
            type: string
          example:
            - '0xabcdef1234567890abcdef1234567890abcdef12'
        not_canceled:
          type: object
          description: Map of order IDs that could not be canceled with error messages
          additionalProperties:
            type: string
          example:
            '0xabcdef1234567890abcdef1234567890abcdef12': Order not found or already canceled
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