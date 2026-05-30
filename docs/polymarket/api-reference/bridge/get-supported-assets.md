> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get supported assets



## OpenAPI

````yaml /api-spec/bridge-openapi.yaml get /supported-assets
openapi: 3.0.3
info:
  title: Polymarket Bridge API
  version: 1.0.0
  description: HTTP API for Polymarket bridge and swap operations.
servers:
  - url: https://bridge.polymarket.com
    description: Polymarket Bridge API
security: []
tags:
  - name: Bridge
    description: Bridge and swap operations for Polymarket
paths:
  /supported-assets:
    get:
      tags:
        - Bridge
      summary: Get supported assets
      responses:
        '200':
          description: Successfully retrieved supported assets
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SupportedAssetsResponse'
        '500':
          description: Server Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
components:
  schemas:
    SupportedAssetsResponse:
      type: object
      properties:
        supportedAssets:
          type: array
          items:
            $ref: '#/components/schemas/SupportedAsset'
          description: >-
            List of supported assets with minimum amounts for deposits and
            withdrawals
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error
    SupportedAsset:
      type: object
      properties:
        chainId:
          type: string
          description: Chain ID
          example: '1'
        chainName:
          type: string
          description: Human-readable chain name
          example: Ethereum
        token:
          $ref: '#/components/schemas/Token'
        minCheckoutUsd:
          type: number
          description: Minimum amount in USD for deposits and withdrawals
          example: 45
    Token:
      type: object
      properties:
        name:
          type: string
          description: Full token name
          example: USD Coin
        symbol:
          type: string
          description: Token symbol
          example: USDC
        address:
          type: string
          description: Token contract address
          example: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
        decimals:
          type: integer
          description: Token decimals
          example: 6

````