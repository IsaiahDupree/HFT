> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get reward percentages for user

> Returns the real-time percentages of rewards that a user is earning per market.

The response is a map of condition_id to the percentage of total rewards
the user is currently earning in that market.

Requires CLOB L2 Auth headers.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /rewards/user/percentages
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
  /rewards/user/percentages:
    get:
      tags:
        - Rewards
      summary: Get reward percentages for user
      description: >
        Returns the real-time percentages of rewards that a user is earning per
        market.


        The response is a map of condition_id to the percentage of total rewards

        the user is currently earning in that market.


        Requires CLOB L2 Auth headers.
      operationId: getRewardPercentagesForUser
      parameters:
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
          description: Maker address to query percentages for
          required: false
          schema:
            type: string
          example: '0xFeA4cB3dD4ca7CefD3368653B7D6FF9BcDFca604'
      responses:
        '200':
          description: Successfully retrieved reward percentages
          content:
            application/json:
              schema:
                type: object
                additionalProperties:
                  type: number
                  format: double
                description: Map of condition_id to reward percentage
              example:
                '0x296ea2f3ad438ce7ead77f40d0159bf3e5d8be146f6f615fa253b00e02243f5c': 20
                '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af': 20
        '400':
          description: Bad request - Invalid parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
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