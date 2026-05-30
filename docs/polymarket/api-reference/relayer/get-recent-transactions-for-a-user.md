> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get recent transactions for a user

> Gets the most recent transactions submitted to the Relayer, owned by a specific user. Authenticated using Builder API Keys or Relayer API Keys.

**Builder API Key auth headers:**
- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_TIMESTAMP`
- `POLY_BUILDER_PASSPHRASE`
- `POLY_BUILDER_SIGNATURE`

**Relayer API Key auth headers:**
- `RELAYER_API_KEY`
- `RELAYER_API_KEY_ADDRESS`




## OpenAPI

````yaml /api-spec/relayer-openapi.yaml get /transactions
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
  /transactions:
    get:
      tags:
        - Relayer
      summary: Get recent transactions for a user
      description: >
        Gets the most recent transactions submitted to the Relayer, owned by a
        specific user. Authenticated using Builder API Keys or Relayer API Keys.


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
      responses:
        '200':
          description: Transactions retrieved successfully
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/RelayerTransaction'
              example:
                - transactionID: 0190b317-a1d3-7bec-9b91-eeb6dcd3a620
                  transactionHash: >-
                    0x38cbfbeae8fffa4e2b187ee5978d3ee9cafc53af0363ed90a35b7ea9016535d8
                  from: '0x6e0c80c90ea6c15917308f820eac91ce2724b5b5'
                  to: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
                  proxyAddress: '0x6d8c4e9adf5748af82dabe2c6225207770d6b4fa'
                  data: 0x...
                  nonce: '60'
                  value: ''
                  signature: >-
                    0x01a060c734d7bdf4adde50c4a7e574036b1f8b12890911bdd1c1cfdcd77502381b89fa8a47c36f62a0b9f1cdfee7b260fd8108536db9f6b2089c02637e7de9fc20
                  state: STATE_CONFIRMED
                  type: SAFE
                  owner: '0x6e0c80c90ea6c15917308f820eac91ce2724b5b5'
                  metadata: ''
                  createdAt: '2024-07-14T21:13:08.819782Z'
                  updatedAt: '2024-07-14T21:13:46.576639Z'
                - transactionID: 0190a792-b5be-7cad-9eae-9941f2b47ebf
                  transactionHash: >-
                    0x0b2ff276b65382fc5593cdd965168c878006684a7fc8d2d011eddeddccd87335
                  from: '0x6e0c80c90ea6c15917308f820eac91ce2724b5b5'
                  to: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
                  proxyAddress: '0x6d8c4e9adf5748af82dabe2c6225207770d6b4fa'
                  data: 0x...
                  nonce: '58'
                  value: ''
                  signature: >-
                    0x9d99a48b6552183dc44018dbbab0e196fa59511e5661b961416e93138870814f3c474367362524ccc6865a8558f2543cc8e1b2e7336e39e6cdb4ad6f09d0db6a20
                  state: STATE_CONFIRMED
                  type: SAFE
                  owner: '0x6e0c80c90ea6c15917308f820eac91ce2724b5b5'
                  metadata: ''
                  createdAt: '2024-07-12T15:32:08.254831Z'
                  updatedAt: '2024-07-12T15:32:45.265257Z'
        '401':
          description: Unauthorized - Invalid authentication
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: invalid authorization
        '500':
          description: Server Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: internal server error
components:
  schemas:
    Address:
      type: string
      description: Ethereum address (0x-prefixed, 40 hex chars)
      pattern: ^0x[a-fA-F0-9]{40}$
      example: '0x6e0c80c90ea6c15917308F820Eac91Ce2724B5b5'
    RelayerTransaction:
      type: object
      properties:
        transactionID:
          type: string
          description: Unique identifier for the transaction
          example: 0190b317-a1d3-7bec-9b91-eeb6dcd3a620
        transactionHash:
          type: string
          description: Onchain transaction hash (available once confirmed)
          example: '0x38cbfbeae8fffa4e2b187ee5978d3ee9cafc53af0363ed90a35b7ea9016535d8'
        from:
          $ref: '#/components/schemas/Address'
          description: Signer address
          example: '0x6e0c80c90ea6c15917308f820eac91ce2724b5b5'
        to:
          $ref: '#/components/schemas/Address'
          description: Target contract address
          example: '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
        proxyAddress:
          $ref: '#/components/schemas/Address'
          description: User's Polymarket proxy wallet address
          example: '0x6d8c4e9adf5748af82dabe2c6225207770d6b4fa'
        data:
          type: string
          description: Encoded transaction data (0x-prefixed hex string)
          example: 0x...
        nonce:
          type: string
          description: Transaction nonce
          example: '60'
        value:
          type: string
          description: Transaction value
          example: ''
        signature:
          type: string
          description: Transaction signature (0x-prefixed hex string)
          example: >-
            0x01a060c734d7bdf4adde50c4a7e574036b1f8b12890911bdd1c1cfdcd77502381b89fa8a47c36f62a0b9f1cdfee7b260fd8108536db9f6b2089c02637e7de9fc20
        state:
          type: string
          description: Current state of the transaction
          enum:
            - STATE_NEW
            - STATE_EXECUTED
            - STATE_MINED
            - STATE_CONFIRMED
            - STATE_INVALID
            - STATE_FAILED
          example: STATE_CONFIRMED
        type:
          type: string
          description: Transaction type
          enum:
            - SAFE
            - PROXY
          example: SAFE
        owner:
          $ref: '#/components/schemas/Address'
          description: Owner address
          example: '0x6e0c80c90ea6c15917308f820eac91ce2724b5b5'
        metadata:
          type: string
          description: Transaction metadata
          example: ''
        createdAt:
          type: string
          format: date-time
          description: Timestamp when the transaction was created
          example: '2024-07-14T21:13:08.819782Z'
        updatedAt:
          type: string
          format: date-time
          description: Timestamp when the transaction was last updated
          example: '2024-07-14T21:13:46.576639Z'
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error

````