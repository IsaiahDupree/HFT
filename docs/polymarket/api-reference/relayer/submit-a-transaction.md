> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Submit a transaction

> Submit a transaction request to the Relayer. Authenticated using Builder API Keys or Relayer API Keys.

Returns immediately with the `transactionID` and a `state` of `STATE_NEW`. The onchain transaction hash is **not** included in this response — poll `GET /transaction` with the returned `transactionID` to retrieve the `transactionHash` once the transaction has been broadcast.

**Builder API Key auth headers:**
- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_TIMESTAMP`
- `POLY_BUILDER_PASSPHRASE`
- `POLY_BUILDER_SIGNATURE`

**Relayer API Key auth headers:**
- `RELAYER_API_KEY`
- `RELAYER_API_KEY_ADDRESS`




## OpenAPI

````yaml /api-spec/relayer-openapi.yaml post /submit
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
  /submit:
    post:
      tags:
        - Relayer
      summary: Submit a transaction
      description: >
        Submit a transaction request to the Relayer. Authenticated using Builder
        API Keys or Relayer API Keys.


        Returns immediately with the `transactionID` and a `state` of
        `STATE_NEW`. The onchain transaction hash is **not** included in this
        response — poll `GET /transaction` with the returned `transactionID` to
        retrieve the `transactionHash` once the transaction has been broadcast.


        **Builder API Key auth headers:**

        - `POLY_BUILDER_API_KEY`

        - `POLY_BUILDER_TIMESTAMP`

        - `POLY_BUILDER_PASSPHRASE`

        - `POLY_BUILDER_SIGNATURE`


        **Relayer API Key auth headers:**

        - `RELAYER_API_KEY`

        - `RELAYER_API_KEY_ADDRESS`
      parameters:
        - name: POLY_BUILDER_API_KEY
          in: header
          required: false
          description: Builder API key (when using Builder API Key auth)
          schema:
            type: string
        - name: POLY_BUILDER_TIMESTAMP
          in: header
          required: false
          description: Unix timestamp (when using Builder API Key auth)
          schema:
            type: string
        - name: POLY_BUILDER_PASSPHRASE
          in: header
          required: false
          description: Builder passphrase (when using Builder API Key auth)
          schema:
            type: string
        - name: POLY_BUILDER_SIGNATURE
          in: header
          required: false
          description: HMAC-SHA256 signature (when using Builder API Key auth)
          schema:
            type: string
        - name: RELAYER_API_KEY
          in: header
          required: false
          description: Relayer API key (when using Relayer API Key auth)
          schema:
            type: string
        - name: RELAYER_API_KEY_ADDRESS
          in: header
          required: false
          description: Address that owns the key (when using Relayer API Key auth)
          schema:
            $ref: '#/components/schemas/Address'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/SubmitRequest'
            example:
              from: '0x6e0c80c90ea6c15917308F820Eac91Ce2724B5b5'
              to: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
              proxyWallet: '0x6d8c4e9aDF5748Af82Dabe2C6225207770d6B4fa'
              data: 0x...
              nonce: '60'
              signature: >-
                0x01a060c734d7bdf4adde50c4a7e574036b1f8b12890911bdd1c1cfdcd77502381b89fa8a47c36f62a0b9f1cdfee7b260fd8108536db9f6b2089c02637e7de9fc20
              signatureParams:
                gasPrice: '0'
                operation: '0'
                safeTxnGas: '0'
                baseGas: '0'
                gasToken: '0x0000000000000000000000000000000000000000'
                refundReceiver: '0x0000000000000000000000000000000000000000'
              type: SAFE
      responses:
        '200':
          description: Transaction submitted successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SubmitResponse'
              example:
                transactionID: 0190b317-a1d3-7bec-9b91-eeb6dcd3a620
                state: STATE_NEW
        '400':
          description: Bad Request - Invalid transaction payload, fields, or signature
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalidPayload:
                  value:
                    error: invalid transaction request payload
                validationError:
                  value:
                    error: bad request
        '401':
          description: Unauthorized - Invalid authentication
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: invalid authorization
        '429':
          description: Too Many Requests - Quota exceeded
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: quota exceeded
        '500':
          description: Server Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                internalError:
                  value:
                    error: internal error
                serverError:
                  value:
                    error: internal server error
components:
  schemas:
    Address:
      type: string
      description: Ethereum address (0x-prefixed, 40 hex chars)
      pattern: ^0x[a-fA-F0-9]{40}$
      example: '0x6e0c80c90ea6c15917308F820Eac91Ce2724B5b5'
    SubmitRequest:
      type: object
      required:
        - from
        - to
        - proxyWallet
        - data
        - nonce
        - signature
        - signatureParams
        - type
      properties:
        from:
          $ref: '#/components/schemas/Address'
          description: Signer address
        to:
          $ref: '#/components/schemas/Address'
          description: Target contract address
        proxyWallet:
          $ref: '#/components/schemas/Address'
          description: User's Polymarket proxy wallet address
        data:
          type: string
          description: Encoded transaction data (0x-prefixed hex string)
          example: 0x...
        nonce:
          type: string
          description: Transaction nonce
          example: '60'
        signature:
          type: string
          description: Transaction signature (0x-prefixed hex string)
          example: >-
            0x01a060c734d7bdf4adde50c4a7e574036b1f8b12890911bdd1c1cfdcd77502381b89fa8a47c36f62a0b9f1cdfee7b260fd8108536db9f6b2089c02637e7de9fc20
        signatureParams:
          $ref: '#/components/schemas/SignatureParams'
        type:
          type: string
          description: Transaction type
          enum:
            - SAFE
            - PROXY
          example: SAFE
    SubmitResponse:
      type: object
      properties:
        transactionID:
          type: string
          description: Unique identifier for the submitted transaction
          example: 0190b317-a1d3-7bec-9b91-eeb6dcd3a620
        state:
          type: string
          description: Current state of the transaction
          example: STATE_NEW
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error
    SignatureParams:
      type: object
      properties:
        gasPrice:
          type: string
          description: Gas price
          example: '0'
        operation:
          type: string
          description: Operation type
          example: '0'
        safeTxnGas:
          type: string
          description: Safe transaction gas
          example: '0'
        baseGas:
          type: string
          description: Base gas
          example: '0'
        gasToken:
          $ref: '#/components/schemas/Address'
          description: Gas token address
          example: '0x0000000000000000000000000000000000000000'
        refundReceiver:
          $ref: '#/components/schemas/Address'
          description: Refund receiver address
          example: '0x0000000000000000000000000000000000000000'

````