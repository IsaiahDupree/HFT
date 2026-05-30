> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Check if a wallet is deployed

> Returns whether the wallet at the given address is deployed onchain.

Use the `type` query parameter to choose which wallet type to check:

- Pass user's Polymarket `SAFE` address (default): Gnosis Safe (SignatureType `2`).
- Pass user's Polymarket `WALLET` Deposit Wallet address: Deposit Wallet (signatureType `3`). See the [Deposit Wallet Guide](/trading/deposit-wallets) for setup.

Omitting `type` is equivalent to `type=SAFE`.




## OpenAPI

````yaml /api-spec/relayer-openapi.yaml get /deployed
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
  /deployed:
    get:
      tags:
        - Relayer
      summary: Check if a wallet is deployed
      description: >
        Returns whether the wallet at the given address is deployed onchain.


        Use the `type` query parameter to choose which wallet type to check:


        - Pass user's Polymarket `SAFE` address (default): Gnosis Safe
        (SignatureType `2`).

        - Pass user's Polymarket `WALLET` Deposit Wallet address: Deposit Wallet
        (signatureType `3`). See the [Deposit Wallet
        Guide](/trading/deposit-wallets) for setup.


        Omitting `type` is equivalent to `type=SAFE`.
      parameters:
        - name: address
          in: query
          required: true
          description: Address of the wallet to check
          schema:
            $ref: '#/components/schemas/Address'
          example: '0x6d8c4e9aDF5748Af82Dabe2C6225207770d6B4fa'
        - name: type
          in: query
          required: false
          description: Wallet type to check. Defaults to `SAFE` when omitted.
          schema:
            type: string
            enum:
              - SAFE
              - WALLET
            default: SAFE
          example: WALLET
      responses:
        '200':
          description: Deployment status retrieved successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DeployedResponse'
              example:
                deployed: true
        '400':
          description: Bad Request - Missing or invalid address
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: invalid address
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
    DeployedResponse:
      type: object
      properties:
        deployed:
          type: boolean
          description: Whether the wallet is deployed
          example: true
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error

````