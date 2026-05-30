> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get earnings for user by date

> Returns an array of user earnings per market for a provided day.

Requires CLOB L2 Auth headers.

Results are paginated (100 items per page). Use next_cursor to fetch subsequent pages.
A next_cursor value of "LTE=" indicates the last page.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /rewards/user
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
  /rewards/user:
    get:
      tags:
        - Rewards
      summary: Get earnings for user by date
      description: >
        Returns an array of user earnings per market for a provided day.


        Requires CLOB L2 Auth headers.


        Results are paginated (100 items per page). Use next_cursor to fetch
        subsequent pages.

        A next_cursor value of "LTE=" indicates the last page.
      operationId: getEarningsForUserForDay
      parameters:
        - name: date
          in: query
          description: Date in YYYY-MM-DD format
          required: true
          schema:
            type: string
            format: date
          example: '2024-03-26'
        - name: signature_type
          in: query
          description: |
            Signature type for address derivation (required for API KEY auth):
            - 0: EOA
            - 1: POLY_PROXY
            - 2: POLY_GNOSIS_SAFE
          required: false
          schema:
            type: integer
            enum:
              - 0
              - 1
              - 2
        - name: maker_address
          in: query
          description: Maker address to query earnings for
          required: false
          schema:
            type: string
          example: '0xFeA4cB3dD4ca7CefD3368653B7D6FF9BcDFca604'
        - name: sponsored
          in: query
          description: If true, returns sponsored-only earnings
          required: false
          schema:
            type: boolean
            default: false
        - name: next_cursor
          in: query
          description: Pagination cursor from previous response
          required: false
          schema:
            type: string
      responses:
        '200':
          description: Successfully retrieved user earnings
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaginatedUserEarnings'
              example:
                limit: 100
                count: 1
                next_cursor: LTE=
                data:
                  - date: '2024-03-26T00:00:00Z'
                    condition_id: >-
                      0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af
                    asset_address: '0x9c4E1703476E875070EE25b56A58B008CFb8FA78'
                    maker_address: '0xFeA4cB3dD4ca7CefD3368653B7D6FF9BcDFca604'
                    earnings: 0.237519
                    asset_rate: 1
        '400':
          description: Bad request - Invalid parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_date:
                  summary: Invalid date format
                  value:
                    error: 'Invalid date (format: YYYY-MM-DD)'
                invalid_signature_type:
                  summary: Invalid signature type
                  value:
                    error: Invalid signature_type
                invalid_maker_address:
                  summary: Invalid maker address
                  value:
                    error: Invalid maker_address
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
      security:
        - polyApiKey: []
          polyAddress: []
          polySignature: []
          polyPassphrase: []
          polyTimestamp: []
components:
  schemas:
    PaginatedUserEarnings:
      type: object
      description: Paginated list of user earnings
      properties:
        limit:
          type: integer
          description: Maximum number of items per page
        count:
          type: integer
          description: Number of items in the current response
        next_cursor:
          type: string
          description: Cursor for the next page. "LTE=" indicates the last page.
        data:
          type: array
          items:
            $ref: '#/components/schemas/UserEarning'
      required:
        - limit
        - count
        - next_cursor
        - data
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
    UserEarning:
      type: object
      description: User earnings for a specific market on a given day
      properties:
        date:
          type: string
          format: date-time
          description: Date of the earnings
        condition_id:
          type: string
          description: Condition ID of the market
        asset_address:
          type: string
          description: Address of the reward asset
        maker_address:
          type: string
          description: Address of the maker
        earnings:
          type: number
          format: double
          description: Amount of earnings in the asset
        asset_rate:
          type: number
          format: double
          description: Exchange rate of the asset
      required:
        - date
        - condition_id
        - asset_address
        - maker_address
        - earnings
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