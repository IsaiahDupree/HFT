> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get current nonce for a user

> Gets the current Proxy or Safe nonce for a user. Takes in the user's signer address and the type of nonce to retrieve.




## OpenAPI

````yaml /api-spec/relayer-openapi.yaml get /nonce
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
  /nonce:
    get:
      tags:
        - Relayer
      summary: Get current nonce for a user
      description: >
        Gets the current Proxy or Safe nonce for a user. Takes in the user's
        signer address and the type of nonce to retrieve.
      parameters:
        - name: address
          in: query
          required: true
          description: User's signer address
          schema:
            $ref: '#/components/schemas/Address'
          example: '0x77837466dd64fb52ECD00C737F060d0ff5CCB575'
        - name: type
          in: query
          required: true
          description: Type of nonce to retrieve
          schema:
            type: string
            enum:
              - PROXY
              - SAFE
          example: PROXY
      responses:
        '200':
          description: Nonce retrieved successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/NonceResponse'
              example:
                nonce: '31'
        '400':
          description: Bad Request - Missing or invalid query parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalidAddress:
                  value:
                    error: invalid address
                invalidType:
                  value:
                    error: invalid type
        '500':
          description: Server Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
components:
  schemas:
    Address:
      type: string
      description: Ethereum address (0x-prefixed, 40 hex chars)
      pattern: ^0x[a-fA-F0-9]{40}$
      example: '0x6e0c80c90ea6c15917308F820Eac91Ce2724B5b5'
    NonceResponse:
      type: object
      properties:
        nonce:
          type: string
          description: Current nonce value
          example: '31'
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error

````