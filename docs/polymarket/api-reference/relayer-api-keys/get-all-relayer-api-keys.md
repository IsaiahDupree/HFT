> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get all relayer API keys

> Returns all relayer API keys for the authenticated address. Auth allowed: Gamma auth or Relayer API key auth (`RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS`).




## OpenAPI

````yaml /api-spec/relayer-openapi.yaml get /relayer/api/keys
openapi: 3.0.3
info:
  title: Polymarket Relayer API
  version: 1.0.0
  description: HTTP API for the Polymarket Relayer. Submit and track gasless transactions.
servers:
  - url: https://relayer-v2.polymarket.com
    description: Polymarket Relayer API
security: []
tags:
  - name: Relayer
    description: Relayer transaction operations
  - name: Relayer API Keys
    description: >
      Relayer API keys let a user authenticate requests to relayer endpoints
      without Gamma auth.

      However, Relayer API keys can only be created using Gamma auth. Every
      address can create a maximum of 100 keys.


      The API key auth headers are:

      - `RELAYER_API_KEY`

      - `RELAYER_API_KEY_ADDRESS`


      `RELAYER_API_KEY_ADDRESS` must match the address that owns the key.
paths:
  /relayer/api/keys:
    get:
      tags:
        - Relayer API Keys
      summary: Get all relayer API keys
      description: >
        Returns all relayer API keys for the authenticated address. Auth
        allowed: Gamma auth or Relayer API key auth (`RELAYER_API_KEY` +
        `RELAYER_API_KEY_ADDRESS`).
      parameters:
        - name: RELAYER_API_KEY
          in: header
          required: false
          description: Relayer API key (when using relayer API key auth)
          schema:
            type: string
          example: 01967c03-b8c8-7000-8f68-8b8eaec6fd3d
        - name: RELAYER_API_KEY_ADDRESS
          in: header
          required: false
          description: >-
            Address that owns the key (when using relayer API key auth). Must
            match the address that owns the key.
          schema:
            $ref: '#/components/schemas/Address'
          example: 0xabc...
      responses:
        '200':
          description: >-
            API keys retrieved successfully. Returns an empty array if no keys
            exist for the authenticated address.
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/RelayerApiKey'
              example:
                - apiKey: 01967c03-b8c8-7000-8f68-8b8eaec6fd3d
                  address: 0xabc...
                  createdAt: '2026-02-24T18:20:11.237485Z'
                  updatedAt: '2026-02-24T18:20:11.237485Z'
        '401':
          description: Unauthorized - Missing or invalid auth
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: invalid authorization
        '403':
          description: Forbidden - Unsupported auth mechanism
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: not allowed
components:
  schemas:
    Address:
      type: string
      description: Ethereum address (0x-prefixed, 40 hex chars)
      pattern: ^0x[a-fA-F0-9]{40}$
      example: '0x6e0c80c90ea6c15917308F820Eac91Ce2724B5b5'
    RelayerApiKey:
      type: object
      properties:
        apiKey:
          type: string
          description: The relayer API key
          example: 01967c03-b8c8-7000-8f68-8b8eaec6fd3d
        address:
          $ref: '#/components/schemas/Address'
          description: The address that owns the key
          example: 0xabc...
        createdAt:
          type: string
          format: date-time
          description: Timestamp when the key was created
          example: '2026-02-24T18:20:11.237485Z'
        updatedAt:
          type: string
          format: date-time
          description: Timestamp when the key was last updated
          example: '2026-02-24T18:20:11.237485Z'
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error

````