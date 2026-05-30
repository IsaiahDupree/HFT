> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get transaction status



## OpenAPI

````yaml /api-spec/bridge-openapi.yaml get /status/{address}
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
  /status/{address}:
    get:
      tags:
        - Bridge
      summary: Get transaction status
      parameters:
        - name: address
          in: path
          required: true
          description: >-
            The address to query for transaction status (EVM, SVM, or BTC
            address from the `/deposit` or `/withdraw` response)
          schema:
            type: string
          example: EXoZue2avJae1d45B3fVw2unhkrtToSYQqHtHgfZ2cbE
      responses:
        '200':
          description: Successfully retrieved transaction status
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TransactionStatusResponse'
              example:
                transactions:
                  - fromChainId: '1151111081099710'
                    fromTokenAddress: '11111111111111111111111111111111'
                    fromAmountBaseUnit: '13566635'
                    toChainId: '137'
                    toTokenAddress: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
                    status: DEPOSIT_DETECTED
                  - fromChainId: '1151111081099710'
                    fromTokenAddress: '11111111111111111111111111111111'
                    fromAmountBaseUnit: '13400000'
                    toChainId: '137'
                    toTokenAddress: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
                    createdTimeMs: 1757646914535
                    status: PROCESSING
                  - fromChainId: '1151111081099710'
                    fromTokenAddress: '11111111111111111111111111111111'
                    fromAmountBaseUnit: '13500152'
                    toChainId: '137'
                    toTokenAddress: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
                    txHash: >-
                      3atr19NAiNCYt24RHM1WnzZp47RXskpTDzspJoCBBaMFwUB8fk37hFkxz35P5UEnnmWz21rb2t5wJ8pq3EE2XnxU
                    createdTimeMs: 1757531217339
                    status: COMPLETED
        '400':
          description: Bad Request - Missing address parameter
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: address is required
        '500':
          description: Server Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: cannot get transaction status
components:
  schemas:
    TransactionStatusResponse:
      type: object
      properties:
        transactions:
          type: array
          items:
            $ref: '#/components/schemas/Transaction'
          description: List of transactions for the given address
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error
    Transaction:
      type: object
      properties:
        fromChainId:
          type: string
          description: Source chain ID
          example: '1151111081099710'
        fromTokenAddress:
          type: string
          description: Source token contract address
          example: '11111111111111111111111111111111'
        fromAmountBaseUnit:
          type: string
          description: Amount in base units (without decimals)
          example: '13566635'
        toChainId:
          type: string
          description: Destination chain ID
          example: '137'
        toTokenAddress:
          type: string
          description: Destination token contract address
          example: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
        status:
          type: string
          description: >
            Current status of the transaction. If a transaction fails, remains
            stuck, or funds are held due to a compliance check, direct users to
            our Bridge API provider's support
            (https://intercom.help/funxyz/en/articles/10732578-contact-us).
          enum:
            - DEPOSIT_DETECTED
            - PROCESSING
            - ORIGIN_TX_CONFIRMED
            - SUBMITTED
            - COMPLETED
            - FAILED
          example: COMPLETED
        txHash:
          type: string
          description: Transaction hash (only available when status is COMPLETED)
          example: >-
            3atr19NAiNCYt24RHM1WnzZp47RXskpTDzspJoCBBaMFwUB8fk37hFkxz35P5UEnnmWz21rb2t5wJ8pq3EE2XnxU
        createdTimeMs:
          type: number
          description: >-
            Unix timestamp in milliseconds when transaction was created (missing
            when status is DEPOSIT_DETECTED)
          example: 1757531217339

````