> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get a quote



## OpenAPI

````yaml /api-spec/bridge-openapi.yaml post /quote
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
  /quote:
    post:
      tags:
        - Bridge
      summary: Get a quote
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/QuoteRequest'
            example:
              fromAmountBaseUnit: '10000000'
              fromChainId: '137'
              fromTokenAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
              recipientAddress: '0x17eC161f126e82A8ba337f4022d574DBEaFef575'
              toChainId: '137'
              toTokenAddress: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
      responses:
        '200':
          description: Quote retrieved successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/QuoteResponse'
              example:
                estCheckoutTimeMs: 25000
                estFeeBreakdown:
                  appFeeLabel: Fun.xyz fee
                  appFeePercent: 0
                  appFeeUsd: 0
                  fillCostPercent: 0
                  fillCostUsd: 0
                  gasUsd: 0.003854
                  maxSlippage: 0
                  minReceived: 14.488305
                  swapImpact: 0
                  swapImpactUsd: 0
                  totalImpact: 0
                  totalImpactUsd: 0
                estInputUsd: 14.488305
                estOutputUsd: 14.488305
                estToTokenBaseUnit: '14491203'
                quoteId: >-
                  0x00c34ba467184b0146406d62b0e60aaa24ed52460bd456222b6155a0d9de0ad5
        '400':
          description: Bad Request - Missing required field
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                missingFromAmount:
                  value:
                    error: fromAmountBaseUnit is required
                missingFromChainId:
                  value:
                    error: fromChainId is required
                missingFromTokenAddress:
                  value:
                    error: fromTokenAddress is required
                missingRecipientAddress:
                  value:
                    error: recipientAddress is required
                missingToChainId:
                  value:
                    error: toChainId is required
                missingToTokenAddress:
                  value:
                    error: toTokenAddress is required
        '500':
          description: Server Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: cannot get quote
components:
  schemas:
    QuoteRequest:
      type: object
      required:
        - fromAmountBaseUnit
        - fromChainId
        - fromTokenAddress
        - recipientAddress
        - toChainId
        - toTokenAddress
      properties:
        fromAmountBaseUnit:
          type: string
          description: Amount of tokens to send
          example: '10000000'
        fromChainId:
          type: string
          description: Source Chain ID
          example: '137'
        fromTokenAddress:
          type: string
          description: Source token address
          example: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
        recipientAddress:
          type: string
          description: Address of the recipient
          example: '0x17eC161f126e82A8ba337f4022d574DBEaFef575'
        toChainId:
          type: string
          description: Destination Chain ID
          example: '137'
        toTokenAddress:
          type: string
          description: Destination token address
          example: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
    QuoteResponse:
      type: object
      properties:
        estCheckoutTimeMs:
          type: integer
          description: Estimated time to complete the checkout in milliseconds
          example: 25000
        estFeeBreakdown:
          $ref: '#/components/schemas/FeeBreakdown'
        estInputUsd:
          type: number
          description: Estimated token amount received in USD
          example: 14.488305
        estOutputUsd:
          type: number
          description: Estimated token amount sent in USD
          example: 14.488305
        estToTokenBaseUnit:
          type: string
          description: Estimated token amount received
          example: '14491203'
        quoteId:
          type: string
          description: Unique quote id of the request
          example: '0x00c34ba467184b0146406d62b0e60aaa24ed52460bd456222b6155a0d9de0ad5'
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error
    FeeBreakdown:
      type: object
      description: Breakdown of the estimated fees
      properties:
        appFeeLabel:
          type: string
          description: Label of the app fee
          example: Fun.xyz fee
        appFeePercent:
          type: number
          description: App fees as a percentage of the total amount sent
          example: 0
        appFeeUsd:
          type: number
          description: App fees in USD
          example: 0
        fillCostPercent:
          type: number
          description: Fill cost percentage of the total amount sent
          example: 0
        fillCostUsd:
          type: number
          description: Fill cost in USD
          example: 0
        gasUsd:
          type: number
          description: Gas fee in USD
          example: 0.003854
        maxSlippage:
          type: number
          description: Maximum potential slippage as a percentage
          example: 0
        minReceived:
          type: number
          description: Amount after factoring slippage
          example: 14.488305
        swapImpact:
          type: number
          description: Swap impact as a percentage of the total amount sent
          example: 0
        swapImpactUsd:
          type: number
          description: Swap impact of the transaction in USD
          example: 0
        totalImpact:
          type: number
          description: Total impact as a percentage of the total amount sent
          example: 0
        totalImpactUsd:
          type: number
          description: Impact cost of the transaction
          example: 0

````