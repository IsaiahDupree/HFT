> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Create deposit addresses



## OpenAPI

````yaml /api-spec/bridge-openapi.yaml post /deposit
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
  /deposit:
    post:
      tags:
        - Bridge
      summary: Create deposit addresses
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/DepositRequest'
            example:
              address: '0x56687bf447db6ffa42ffe2204a05edaa20f55839'
      responses:
        '201':
          description: Deposit addresses created successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/DepositResponse'
        '400':
          description: Bad Request - Invalid address or request body
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
    DepositRequest:
      type: object
      required:
        - address
      properties:
        address:
          $ref: '#/components/schemas/Address'
          description: >-
            Your Polymarket wallet address where deposited funds will be
            credited as pUSD
    DepositResponse:
      type: object
      properties:
        address:
          type: object
          description: Deposit addresses for different blockchain networks
          properties:
            evm:
              type: string
              description: >-
                EVM-compatible deposit address (Ethereum, Polygon, Arbitrum,
                Base, etc.)
              example: '0x23566f8b2E82aDfCf01846E54899d110e97AC053'
            svm:
              type: string
              description: Solana Virtual Machine deposit address
              example: CrvTBvzryYxBHbWu2TiQpcqD5M7Le7iBKzVmEj3f36Jb
            btc:
              type: string
              description: Bitcoin deposit address
              example: bc1q8eau83qffxcj8ht4hsjdza3lha9r3egfqysj3g
        note:
          type: string
          description: Additional information about the deposit addresses
          example: >-
            Only certain chains and tokens are supported. See /supported-assets
            for details.
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error
    Address:
      type: string
      description: Ethereum address (0x-prefixed, 40 hex chars)
      pattern: ^0x[a-fA-F0-9]{40}$
      example: '0x56687bf447db6ffa42ffe2204a05edaa20f55839'

````