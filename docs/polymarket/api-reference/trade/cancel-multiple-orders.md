> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Cancel multiple orders

> Cancels multiple orders by their IDs. Maximum 3000 orders per request.
Duplicate order IDs in the request are automatically ignored.
Works even in cancel-only mode.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml delete /orders
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
    delete:
      tags:
        - Trade
      summary: Cancel multiple orders
      description: |
        Cancels multiple orders by their IDs. Maximum 3000 orders per request.
        Duplicate order IDs in the request are automatically ignored.
        Works even in cancel-only mode.
      operationId: cancelOrders
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: array
              items:
                type: string
              maxItems: 3000
            example:
              - '0xabcdef1234567890abcdef1234567890abcdef12'
              - '0xfedcba0987654321fedcba0987654321fedcba09'
              - '0x1234567890abcdef1234567890abcdef12345678'
      responses:
        '200':
          description: Cancellation results for all orders
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/CancelOrdersResponse'
              examples:
                all_canceled:
                  summary: All orders canceled
                  value:
                    canceled:
                      - '0xabcdef1234567890abcdef1234567890abcdef12'
                      - '0xfedcba0987654321fedcba0987654321fedcba09'
                      - '0x1234567890abcdef1234567890abcdef12345678'
                    not_canceled: {}
                mixed:
                  summary: Some orders canceled, some not
                  value:
                    canceled:
                      - '0xabcdef1234567890abcdef1234567890abcdef12'
                      - '0xfedcba0987654321fedcba0987654321fedcba09'
                    not_canceled:
                      '0x1234567890abcdef1234567890abcdef12345678': Order already matched
                partial:
                  summary: Partial cancellation
                  value:
                    canceled:
                      - '0xabcdef1234567890abcdef1234567890abcdef12'
                    not_canceled:
                      '0xfedcba0987654321fedcba0987654321fedcba09': Order not found
                      '0x1234567890abcdef1234567890abcdef12345678': Order already canceled
        '400':
          description: Bad request - Invalid order IDs or payload
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_order_id:
                  summary: Invalid order ID
                  value:
                    error: Invalid orderID
                invalid_payload:
                  summary: Invalid payload
                  value:
                    error: Invalid order payload
                too_many_orders:
                  summary: Too many orders
                  value:
                    error: 'Too many orders in payload, max allowed: 3000'
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