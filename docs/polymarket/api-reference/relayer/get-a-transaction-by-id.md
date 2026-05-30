> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get a transaction by ID

> Gets a transaction submitted to the Relayer. Takes in a required transaction ID as a query parameter.

Poll this endpoint with the `transactionID` returned from `POST /submit` to retrieve the onchain `transactionHash` once the transaction has been broadcast.




## OpenAPI

````yaml /api-spec/relayer-openapi.yaml get /transaction
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
  /transaction:
    get:
      tags:
        - Relayer
      summary: Get a transaction by ID
      description: >
        Gets a transaction submitted to the Relayer. Takes in a required
        transaction ID as a query parameter.


        Poll this endpoint with the `transactionID` returned from `POST /submit`
        to retrieve the onchain `transactionHash` once the transaction has been
        broadcast.
      parameters:
        - name: id
          in: query
          required: true
          description: Transaction ID
          schema:
            type: string
          example: 0190b317-a1d3-7bec-9b91-eeb6dcd3a620
      responses:
        '200':
          description: Transaction retrieved successfully
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
        '400':
          description: Bad Request - Missing or invalid transaction ID
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: invalid id
        '404':
          description: Transaction not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: transaction not found
        '500':
          description: Server Error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
components:
  schemas:
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
    Address:
      type: string
      description: Ethereum address (0x-prefixed, 40 hex chars)
      pattern: ^0x[a-fA-F0-9]{40}$
      example: '0x6e0c80c90ea6c15917308F820Eac91Ce2724B5b5'

````