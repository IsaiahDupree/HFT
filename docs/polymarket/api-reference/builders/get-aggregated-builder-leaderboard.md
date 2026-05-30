> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get aggregated builder leaderboard



## OpenAPI

````yaml /api-spec/data-openapi.yaml get /v1/builders/leaderboard
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
  /v1/builders/leaderboard:
    get:
      tags:
        - Builders
      summary: Get aggregated builder leaderboard
      parameters:
        - in: query
          name: timePeriod
          schema:
            type: string
            enum:
              - DAY
              - WEEK
              - MONTH
              - ALL
            default: DAY
          description: |
            The time period to aggregate results over.
        - in: query
          name: limit
          schema:
            type: integer
            default: 25
            minimum: 0
            maximum: 50
          description: Maximum number of builders to return
        - in: query
          name: offset
          schema:
            type: integer
            default: 0
            minimum: 0
            maximum: 1000
          description: Starting index for pagination
      responses:
        '200':
          description: Success
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/LeaderboardEntry'
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
    LeaderboardEntry:
      type: object
      properties:
        rank:
          type: string
          description: The rank position of the builder
        builder:
          type: string
          description: The builder name or identifier
        builderCode:
          type: string
          description: >-
            The builder's onchain attribution code as attached to orders via
            `builderCode` (see CLOB V2). Empty string for legacy builders
            without a registered code.
        volume:
          type: number
          description: Total trading volume attributed to this builder
        activeUsers:
          type: integer
          description: Number of active users for this builder
        verified:
          type: boolean
          description: Whether the builder is verified
        builderLogo:
          type: string
          description: URL to the builder's logo image
    ErrorResponse:
      type: object
      properties:
        error:
          type: string
      required:
        - error

````