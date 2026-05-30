> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get positions for a market



## OpenAPI

````yaml /api-spec/data-openapi.yaml get /v1/market-positions
openapi: 3.0.3
info:
  title: Polymarket Data API
  version: 1.0.0
  description: >
    HTTP API for Polymarket data. This specification documents all public
    routes.
servers:
  - url: https://data-api.polymarket.com
    description: Relative server (same host)
security: []
tags:
  - name: Data API Status
    description: Data API health check
  - name: Core
  - name: Builders
  - name: Misc
paths:
  /v1/market-positions:
    get:
      tags:
        - Core
      summary: Get positions for a market
      parameters:
        - in: query
          name: market
          required: true
          schema:
            $ref: '#/components/schemas/Hash64'
          description: The condition ID of the market to query positions for
        - in: query
          name: user
          schema:
            $ref: '#/components/schemas/Address'
          description: Filter to a single user by proxy wallet address
        - in: query
          name: status
          schema:
            type: string
            enum:
              - OPEN
              - CLOSED
              - ALL
            default: ALL
          description: |
            Filter positions by status.
            - `OPEN` — Only positions with size > 0.01
            - `CLOSED` — Only positions with size <= 0.01
            - `ALL` — All positions regardless of size
        - in: query
          name: sortBy
          schema:
            type: string
            enum:
              - TOKENS
              - CASH_PNL
              - REALIZED_PNL
              - TOTAL_PNL
            default: TOTAL_PNL
          description: |
            Sort positions by:
            - `TOKENS` — Position size (number of tokens)
            - `CASH_PNL` — Unrealized cash PnL
            - `REALIZED_PNL` — Realized PnL
            - `TOTAL_PNL` — Total PnL (cash_pnl + realized_pnl)
        - in: query
          name: sortDirection
          schema:
            type: string
            enum:
              - ASC
              - DESC
            default: DESC
        - in: query
          name: limit
          schema:
            type: integer
            default: 50
            minimum: 0
            maximum: 500
          description: Max number of positions to return per outcome token
        - in: query
          name: offset
          schema:
            type: integer
            default: 0
            minimum: 0
            maximum: 10000
          description: Pagination offset per outcome token
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/MetaMarketPositionV1'
        '400':
          description: Bad Request
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '401':
          description: Unauthorized
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '500':
          description: Server Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
components:
  schemas:
    Hash64:
      type: string
      description: 0x-prefixed 64-hex string
      pattern: ^0x[a-fA-F0-9]{64}$
      example: '0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917'
    Address:
      type: string
      description: User Profile Address (0x-prefixed, 40 hex chars)
      pattern: ^0x[a-fA-F0-9]{40}$
      example: '0x56687bf447db6ffa42ffe2204a05edaa20f55839'
    MetaMarketPositionV1:
      type: object
      properties:
        token:
          type: string
          description: The outcome token asset ID
        positions:
          type: array
          items:
            $ref: '#/components/schemas/MarketPositionV1'
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error
    MarketPositionV1:
      type: object
      properties:
        proxyWallet:
          $ref: '#/components/schemas/Address'
        name:
          type: string
        profileImage:
          type: string
        verified:
          type: boolean
        asset:
          type: string
        conditionId:
          $ref: '#/components/schemas/Hash64'
        avgPrice:
          type: number
        size:
          type: number
        currPrice:
          type: number
        currentValue:
          type: number
        cashPnl:
          type: number
        totalBought:
          type: number
        realizedPnl:
          type: number
        totalPnl:
          type: number
        outcome:
          type: string
        outcomeIndex:
          type: integer

````