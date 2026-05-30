> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Send heartbeat

> Sends a heartbeat signal to maintain active session status.
If heartbeats are not sent regularly, all open orders for the user will be automatically canceled.
This is useful for automated trading systems that need to ensure orders are canceled
if the system becomes unresponsive.




## OpenAPI

````yaml /api-spec/clob-openapi.yaml post /heartbeats
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
  /heartbeats:
    post:
      tags:
        - Trade
      summary: Send heartbeat
      description: >
        Sends a heartbeat signal to maintain active session status.

        If heartbeats are not sent regularly, all open orders for the user will
        be automatically canceled.

        This is useful for automated trading systems that need to ensure orders
        are canceled

        if the system becomes unresponsive.
      operationId: sendHeartbeat
      responses:
        '200':
          description: Heartbeat acknowledged
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/HeartbeatResponse'
              example:
                status: ok
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
    HeartbeatResponse:
      type: object
      description: Response for heartbeat request
      required:
        - status
      properties:
        status:
          type: string
          description: Status of the heartbeat acknowledgment
          example: ok
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