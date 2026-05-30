> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Get user earnings and markets configuration

> Returns an array of current rewards including user earnings and live percentages
per market for a provided day.

Results are paginated (100 items per page by default, max 500). Use next_cursor to fetch subsequent pages.
A next_cursor value of "LTE=" indicates the last page.

Requires CLOB L2 Auth headers.

Optional features:
- Search by question/description using the `q` parameter
- Filter by tag slugs using `tag_slug` parameter (multiple values are OR'ed)
- Filter by favorite markets using `favorite_markets=true`
- Sort by various fields using `order_by` and `position` parameters




## OpenAPI

````yaml /api-spec/clob-openapi.yaml get /rewards/user/markets
openapi: 3.1.0
info:
  title: Polymarket CLOB API
  description: Polymarket CLOB API Reference
  license:
    name: MIT
    identifier: MIT
  version: 1.0.0
servers:
  - url: https://clob.polymarket.com
    description: Production CLOB API
  - url: https://clob-staging.polymarket.com
    description: Staging CLOB API
security: []
tags:
  - name: Trade
    description: Trade endpoints
  - name: Markets
    description: Market data endpoints
  - name: Account
    description: Account and authentication endpoints
  - name: Notifications
    description: User notification endpoints
  - name: Rewards
    description: Rewards and earnings endpoints
  - name: Rebates
    description: Maker rebate endpoints
paths:
  /rewards/user/markets:
    get:
      tags:
        - Rewards
      summary: Get user earnings and markets configuration
      description: >
        Returns an array of current rewards including user earnings and live
        percentages

        per market for a provided day.


        Results are paginated (100 items per page by default, max 500). Use
        next_cursor to fetch subsequent pages.

        A next_cursor value of "LTE=" indicates the last page.


        Requires CLOB L2 Auth headers.


        Optional features:

        - Search by question/description using the `q` parameter

        - Filter by tag slugs using `tag_slug` parameter (multiple values are
        OR'ed)

        - Filter by favorite markets using `favorite_markets=true`

        - Sort by various fields using `order_by` and `position` parameters
      operationId: getUserEarningsAndMarketsConfig
      parameters:
        - name: date
          in: query
          description: Date in YYYY-MM-DD format. Defaults to current date if not provided.
          required: false
          schema:
            type: string
            format: date
          example: '2024-03-26'
        - name: signature_type
          in: query
          description: |
            Signature type for address derivation (required for API KEY auth):
            - 0: EOA
            - 1: POLY_PROXY
            - 2: POLY_GNOSIS_SAFE
          required: false
          schema:
            type: integer
            enum:
              - 0
              - 1
              - 2
        - name: maker_address
          in: query
          description: Maker address to query data for
          required: false
          schema:
            type: string
          example: '0xFeA4cB3dD4ca7CefD3368653B7D6FF9BcDFca604'
        - name: sponsored
          in: query
          description: If true, returns sponsored reward earnings
          required: false
          schema:
            type: boolean
            default: false
        - name: next_cursor
          in: query
          description: Pagination cursor from previous response
          required: false
          schema:
            type: string
        - name: page_size
          in: query
          description: Number of items per page (max 500, values above are capped)
          required: false
          schema:
            type: integer
            default: 100
            maximum: 500
        - name: q
          in: query
          description: Search query to filter markets by question/description
          required: false
          schema:
            type: string
        - name: tag_slug
          in: query
          description: Filter by tag slug (can be repeated for OR logic)
          required: false
          schema:
            type: string
        - name: favorite_markets
          in: query
          description: If true, only show markets favorited by the user (requires auth)
          required: false
          schema:
            type: boolean
            default: false
        - name: no_competition
          in: query
          description: Filter for markets with no competition
          required: false
          schema:
            type: boolean
            default: false
        - name: only_mergeable
          in: query
          description: Filter for only mergeable markets
          required: false
          schema:
            type: boolean
            default: false
        - name: only_open_orders
          in: query
          description: Filter for markets where user has open orders
          required: false
          schema:
            type: boolean
            default: false
        - name: only_open_positions
          in: query
          description: Filter for markets where user has open positions
          required: false
          schema:
            type: boolean
            default: false
        - name: order_by
          in: query
          description: Field to sort by
          required: false
          schema:
            type: string
            enum:
              - max_spread
              - min_size
              - end_date
              - earning_percentage
              - rate_per_day
              - earnings
              - spread
              - competitiveness
              - question
              - price
              - market
              - volume_24hr
        - name: position
          in: query
          description: Sort direction
          required: false
          schema:
            type: string
            enum:
              - ASC
              - DESC
      responses:
        '200':
          description: Successfully retrieved user earnings and market configurations
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaginatedUserRewardsMarkets'
              example:
                limit: 100
                count: 1
                total_count: 42
                next_cursor: LTE=
                data:
                  - condition_id: >-
                      0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af
                    market_id: '248849'
                    event_id: '12345'
                    question: Will Trump win the 2024 Iowa Caucus?
                    market_slug: will-trump-win-the-2024-iowa-caucus
                    event_slug: will-trump-win-the-2024-iowa-caucus
                    image: >-
                      https://polymarket-upload.s3.us-east-2.amazonaws.com/trump1+copy.png
                    rewards_max_spread: 99
                    rewards_min_size: 10
                    volume_24hr: 12345.67
                    spread: 0.12
                    market_competitiveness: 0.42
                    tokens:
                      - token_id: >-
                          1343197538147866997676250008839231694243646439454152539053893078719042421992
                        outcome: 'YES'
                        price: 0.8
                      - token_id: >-
                          16678291189211314787145083999015737376658799626183230671758641503291735614088
                        outcome: 'NO'
                        price: 0.2
                    rewards_config:
                      - id: 0
                        asset_address: '0x9c4E1703476E875070EE25b56A58B008CFb8FA78'
                        start_date: '2024-03-01'
                        end_date: '2500-12-31'
                        rate_per_day: 2
                        total_rewards: 92
                    maker_address: '0xD527CCdBEB6478488c848465F9947bDA3C2e6994'
                    earning_percentage: 30
                    earnings:
                      - asset_address: '0x9c4E1703476E875070EE25b56A58B008CFb8FA78'
                        earnings: 0.585051
                        asset_rate: 1.001
        '400':
          description: Bad request - Invalid parameters
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              examples:
                invalid_date:
                  summary: Invalid date format
                  value:
                    error: 'Invalid date (format: YYYY-MM-DD)'
                invalid_signature_type:
                  summary: Invalid signature type
                  value:
                    error: Invalid signature_type
                favorite_requires_auth:
                  summary: Favorite markets requires auth
                  value:
                    error: favorite_markets query argument requires authentication
        '401':
          description: Unauthorized - Invalid API key or authentication failed
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Invalid API key
        '500':
          description: Internal server error
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
              example:
                error: Internal server error
      security:
        - polyApiKey: []
          polyAddress: []
          polySignature: []
          polyPassphrase: []
          polyTimestamp: []
components:
  schemas:
    PaginatedUserRewardsMarkets:
      type: object
      description: Paginated list of user rewards markets
      properties:
        limit:
          type: integer
          description: Maximum number of items per page
        count:
          type: integer
          description: Number of items in the current response
        total_count:
          type: integer
          description: Total number of items across all pages
        next_cursor:
          type: string
          description: Cursor for the next page. "LTE=" indicates the last page.
        data:
          type: array
          items:
            $ref: '#/components/schemas/UserRewardsMarket'
      required:
        - limit
        - count
        - next_cursor
        - data
    ErrorResponse:
      type: object
      required:
        - error
      properties:
        error:
          type: string
          description: Error message
        code:
          type: string
          description: Machine-readable error code, when provided
        retry_after_seconds:
          type: integer
          description: Number of seconds to wait before retrying, when provided
    UserRewardsMarket:
      type: object
      description: Market with user rewards earnings and configuration
      properties:
        condition_id:
          type: string
          description: Condition ID of the market
        market_id:
          type: string
          description: Market ID
        event_id:
          type: string
          description: Event ID
        question:
          type: string
          description: Market question
        market_slug:
          type: string
          description: URL slug for the market
        event_slug:
          type: string
          description: URL slug for the event
        image:
          type: string
          description: URL to market image
        rewards_max_spread:
          type: number
          description: Maximum spread for rewards eligibility
        rewards_min_size:
          type: number
          description: Minimum order size for rewards eligibility
        volume_24hr:
          type: number
          format: double
          description: 24-hour trading volume
        spread:
          type: number
          format: double
          description: Current spread
        market_competitiveness:
          type: number
          format: double
          description: Competitiveness score of the market
        tokens:
          type: array
          items:
            $ref: '#/components/schemas/RewardsToken'
        rewards_config:
          type: array
          items:
            $ref: '#/components/schemas/CurrentRewardConfig'
        maker_address:
          type: string
          description: Maker address
        earning_percentage:
          type: number
          format: double
          description: Percentage of total rewards the user is earning
        earnings:
          type: array
          items:
            $ref: '#/components/schemas/AssetEarning'
      required:
        - condition_id
        - market_id
        - question
        - tokens
    RewardsToken:
      type: object
      description: Token information for rewards markets
      properties:
        token_id:
          type: string
          description: Token ID
        outcome:
          type: string
          description: Outcome name (e.g., "YES", "NO")
        price:
          type: number
          format: double
          description: Current price of the token
      required:
        - token_id
        - outcome
    CurrentRewardConfig:
      type: object
      description: Reward configuration entry for a current rewards market
      properties:
        id:
          type: integer
          description: Rewards config ID (always 0 on /rewards/markets/current)
        asset_address:
          type: string
          description: Address of the reward asset
        start_date:
          type: string
          format: date
          description: Start date of the rewards period
        end_date:
          type: string
          format: date
          description: End date of the rewards period
        rate_per_day:
          type: number
          format: double
          description: Daily reward rate
        total_rewards:
          type: number
          format: double
          description: Total rewards amount
      required:
        - asset_address
        - start_date
        - rate_per_day
    AssetEarning:
      type: object
      description: Earnings for a specific asset
      properties:
        asset_address:
          type: string
          description: Address of the reward asset
        earnings:
          type: number
          format: double
          description: Amount of earnings
        asset_rate:
          type: number
          format: double
          description: Exchange rate of the asset
      required:
        - asset_address
        - earnings
  securitySchemes:
    polyApiKey:
      type: apiKey
      in: header
      name: POLY_API_KEY
      description: Your API key
    polyAddress:
      type: apiKey
      in: header
      name: POLY_ADDRESS
      description: Ethereum address associated with the API key
    polySignature:
      type: apiKey
      in: header
      name: POLY_SIGNATURE
      description: HMAC signature of the request
    polyPassphrase:
      type: apiKey
      in: header
      name: POLY_PASSPHRASE
      description: API key passphrase
    polyTimestamp:
      type: apiKey
      in: header
      name: POLY_TIMESTAMP
      description: Unix timestamp of the request

````