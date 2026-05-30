> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Download an accounting snapshot (ZIP of CSVs)



## OpenAPI

````yaml /api-spec/data-openapi.yaml get /v1/accounting/snapshot
openapi: 3.0.3
info:
  title: Polymarket Data API
  version: 1.0.0
  description: >
    HTTP API for Polymarket data. This specification documents all public
    routes.
servers:
  - url: https://data-api.polymarket.com
    description: Relative server (same host)
security: []
tags:
  - name: Data API Status
    description: Data API health check
  - name: Core
  - name: Builders
  - name: Misc
paths:
  /v1/accounting/snapshot:
    get:
      tags:
        - Misc
      summary: Download an accounting snapshot (ZIP of CSVs)
      parameters:
        - in: query
          name: user
          required: true
          schema:
            $ref: '#/components/schemas/Address'
          description: User address (0x-prefixed)
      responses:
        '200':
          description: ZIP file containing `positions.csv` and `equity.csv`.
          content:
            application/zip:
              schema:
                type: string
                format: binary
        '400':
          description: Bad Request
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
    Address:
      type: string
      description: User Profile Address (0x-prefixed, 40 hex chars)
      pattern: ^0x[a-fA-F0-9]{40}$
      example: '0x56687bf447db6ffa42ffe2204a05edaa20f55839'
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error

````