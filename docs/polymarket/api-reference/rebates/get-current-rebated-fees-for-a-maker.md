> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get current rebated fees for a maker

> Returns the current rebated fees for a maker address on a given date.

Each entry includes the condition ID, asset address, and the USDC amount rebated.

This endpoint does not require authentication.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /rebates/current
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
  /rebates/current:
    get:
      tags:
        - Rebates
      summary: Get current rebated fees for a maker
      description: >
        Returns the current rebated fees for a maker address on a given date.


        Each entry includes the condition ID, asset address, and the USDC amount
        rebated.


        This endpoint does not require authentication.
      operationId: getCurrentRebatedFees
      parameters:
        - name: date
          in: query
          description: Date in YYYY-MM-DD format
          required: true
          schema:
            type: string
            format: date
          example: '2026-02-27'
        - name: maker_address
          in: query
          description: Ethereum address of the maker
          required: true
          schema:
            type: string
          example: '0xFeA4cB3dD4ca7CefD3368653B7D6FF9BcDFca604'
      responses:
        '200':
          description: Successfully retrieved rebated fees
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/RebatedFees'
              example:
                - date: '2026-02-27'
                  condition_id: >-
                    0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af
                  asset_address: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
                  maker_address: '0xFeA4cB3dD4ca7CefD3368653B7D6FF9BcDFca604'
                  rebated_fees_usdc: '0.237519'
        '400':
          description: Bad request - Invalid parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_date:
                  summary: Invalid date
                  value:
                    error: Invalid date
                invalid_maker_address:
                  summary: Invalid maker address
                  value:
                    error: Invalid maker_address
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Internal server error
components:
  schemas:
    RebatedFees:
      type: object
      description: Rebated fees for a maker on a specific market and date
      required:
        - date
        - condition_id
        - asset_address
        - maker_address
        - rebated_fees_usdc
      properties:
        date:
          type: string
          description: Date of the rebate (YYYY-MM-DD)
          example: '2026-02-27'
        condition_id:
          type: string
          description: Condition ID of the market
          example: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af'
        asset_address:
          type: string
          description: Asset address (e.g. USDC contract)
          example: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
        maker_address:
          type: string
          description: Maker's Ethereum address
          example: '0xFeA4cB3dD4ca7CefD3368653B7D6FF9BcDFca604'
        rebated_fees_usdc:
          type: string
          description: Rebated fee amount in USDC
          example: '0.237519'
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