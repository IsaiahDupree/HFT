> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# User Channel

> Authenticated WebSocket for real-time order and trade updates.



## AsyncAPI

````yaml asyncapi-user.json user
id: user
title: User Channel
description: >-
  Authenticated channel for real-time order and trade updates. Send API
  credentials in the initial subscription message. Optionally filter by market
  condition IDs.
servers:
  - id: production
    protocol: wss
    host: ws-subscriptions-clob.polymarket.com
    bindings: []
    variables: []
address: /ws/user
parameters: []
bindings: []
operations:
  - &ref_1
    id: subscribe
    title: Subscribe
    description: Send authenticated subscription request
    type: receive
    messages:
      - &ref_7
        id: userSubscriptionRequest
        contentType: application/json
        payload:
          - name: Subscription Request
            description: Authenticated subscription message sent after connecting
            type: object
            properties:
              - name: auth
                type: object
                description: CLOB API credentials for authentication
                required: true
                properties:
                  - name: apiKey
                    type: string
                    description: CLOB API key (UUID format)
                    required: true
                  - name: secret
                    type: string
                    description: CLOB API secret
                    required: true
                  - name: passphrase
                    type: string
                    description: CLOB API passphrase
                    required: true
              - name: type
                type: string
                description: Must be 'user'
                required: true
              - name: markets
                type: array
                description: >-
                  Optional condition IDs to filter events. If omitted, receives
                  events for all markets.
                required: false
                properties:
                  - name: item
                    type: string
                    required: false
        headers: []
        jsonPayloadSchema:
          type: object
          description: Authenticated subscription request for the user channel
          required:
            - auth
            - type
          properties:
            auth:
              type: object
              description: CLOB API credentials for authentication
              required:
                - apiKey
                - secret
                - passphrase
              properties:
                apiKey:
                  type: string
                  description: CLOB API key (UUID format)
                  x-parser-schema-id: <anonymous-schema-1>
                secret:
                  type: string
                  description: CLOB API secret
                  x-parser-schema-id: <anonymous-schema-2>
                passphrase:
                  type: string
                  description: CLOB API passphrase
                  x-parser-schema-id: <anonymous-schema-3>
              x-parser-schema-id: WebSocketAuth
            type:
              type: string
              const: user
              description: Must be 'user'
              x-parser-schema-id: <anonymous-schema-4>
            markets:
              type: array
              description: >-
                Optional condition IDs to filter events. If omitted, receives
                events for all markets.
              items:
                type: string
                x-parser-schema-id: <anonymous-schema-6>
              x-parser-schema-id: <anonymous-schema-5>
          x-parser-schema-id: UserSubscriptionRequest
        title: Subscription Request
        description: Authenticated subscription message sent after connecting
        example: |-
          {
            "auth": {
              "apiKey": "your-api-key-uuid",
              "secret": "your-api-secret",
              "passphrase": "your-passphrase"
            },
            "type": "user"
          }
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: userSubscriptionRequest
    bindings: []
    extensions: &ref_0
      - id: x-parser-unique-object-id
        value: user
  - &ref_2
    id: updateSubscription
    title: Update Subscription
    description: Dynamically subscribe or unsubscribe from markets without reconnecting
    type: receive
    messages:
      - &ref_8
        id: userSubscriptionRequestUpdate
        contentType: application/json
        payload:
          - name: Subscription Update
            description: Subscribe or unsubscribe from markets without reconnecting
            type: object
            properties:
              - name: operation
                type: string
                enumValues:
                  - subscribe
                  - unsubscribe
                required: true
              - name: markets
                type: array
                description: Condition IDs to subscribe to or unsubscribe from
                required: true
                properties:
                  - name: item
                    type: string
                    required: false
        headers: []
        jsonPayloadSchema:
          type: object
          description: Dynamically update market subscriptions
          required:
            - operation
            - markets
          properties:
            operation:
              type: string
              enum:
                - subscribe
                - unsubscribe
              x-parser-schema-id: <anonymous-schema-7>
            markets:
              type: array
              description: Condition IDs to subscribe to or unsubscribe from
              items:
                type: string
                x-parser-schema-id: <anonymous-schema-9>
              x-parser-schema-id: <anonymous-schema-8>
          x-parser-schema-id: UserSubscriptionRequestUpdate
        title: Subscription Update
        description: Subscribe or unsubscribe from markets without reconnecting
        example: |-
          {
            "operation": "subscribe",
            "markets": [
              "0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1"
            ]
          }
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: userSubscriptionRequestUpdate
    bindings: []
    extensions: *ref_0
  - &ref_3
    id: ping
    title: Ping
    description: Send PING every 10 seconds to keep the connection alive
    type: receive
    messages:
      - &ref_9
        id: ping
        contentType: text/plain
        payload:
          - type: string
            const: PING
            x-parser-schema-id: <anonymous-schema-10>
            name: Ping
            description: Client heartbeat — send every 10 seconds
        headers: []
        jsonPayloadSchema:
          type: string
          const: PING
          x-parser-schema-id: <anonymous-schema-10>
        title: Ping
        description: Client heartbeat — send every 10 seconds
        example: '{}'
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: ping
    bindings: []
    extensions: *ref_0
  - &ref_4
    id: pong
    title: Pong
    description: Server responds to PING with PONG
    type: send
    messages:
      - &ref_10
        id: pong
        contentType: text/plain
        payload:
          - type: string
            const: PONG
            x-parser-schema-id: <anonymous-schema-11>
            name: Pong
            description: Server heartbeat response
        headers: []
        jsonPayloadSchema:
          type: string
          const: PONG
          x-parser-schema-id: <anonymous-schema-11>
        title: Pong
        description: Server heartbeat response
        example: '{}'
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: pong
    bindings: []
    extensions: *ref_0
  - &ref_5
    id: receiveOrder
    title: Order Event
    description: Order placement, update, or cancellation event for the authenticated user
    type: send
    messages:
      - &ref_11
        id: order
        contentType: application/json
        payload:
          - name: Order Event
            description: Order placement, update, or cancellation
            type: object
            properties:
              - name: event_type
                type: string
                description: order
                required: true
              - name: id
                type: string
                description: Order ID (hash)
                required: true
              - name: owner
                type: string
                description: API key of the order owner
                required: true
              - name: market
                type: string
                description: Condition ID of the market
                required: true
              - name: asset_id
                type: string
                description: Asset ID (token ID)
                required: true
              - name: side
                type: string
                enumValues:
                  - BUY
                  - SELL
                required: true
              - name: order_owner
                type: string
                required: false
              - name: original_size
                type: string
                description: Original order size
                required: true
              - name: size_matched
                type: string
                description: Amount matched so far
                required: true
              - name: price
                type: string
                required: true
              - name: associate_trades
                type: array
                description: Trade IDs this order has been matched in
                required: false
                properties:
                  - name: item
                    type: string
                    required: false
              - name: outcome
                type: string
                description: e.g. 'YES', 'NO'
                required: false
              - name: type
                type: string
                enumValues:
                  - PLACEMENT
                  - UPDATE
                  - CANCELLATION
                required: true
              - name: created_at
                type: string
                required: false
              - name: expiration
                type: string
                description: For GTD orders
                required: false
              - name: order_type
                type: string
                enumValues:
                  - GTC
                  - GTD
                  - FOK
                required: false
              - name: status
                type: string
                description: e.g. 'LIVE', 'MATCHED', 'CANCELED'
                required: false
              - name: maker_address
                type: string
                required: false
              - name: timestamp
                type: string
                description: Event timestamp in milliseconds
                required: true
        headers: []
        jsonPayloadSchema:
          type: object
          description: Order placement, update, or cancellation event
          required:
            - event_type
            - id
            - owner
            - market
            - asset_id
            - side
            - original_size
            - size_matched
            - price
            - type
            - timestamp
          properties:
            event_type:
              type: string
              const: order
              x-parser-schema-id: <anonymous-schema-12>
            id:
              type: string
              description: Order ID (hash)
              x-parser-schema-id: <anonymous-schema-13>
            owner:
              type: string
              description: API key of the order owner
              x-parser-schema-id: <anonymous-schema-14>
            market:
              type: string
              description: Condition ID of the market
              x-parser-schema-id: <anonymous-schema-15>
            asset_id:
              type: string
              description: Asset ID (token ID)
              x-parser-schema-id: <anonymous-schema-16>
            side:
              type: string
              enum:
                - BUY
                - SELL
              x-parser-schema-id: <anonymous-schema-17>
            order_owner:
              type: string
              x-parser-schema-id: <anonymous-schema-18>
            original_size:
              type: string
              description: Original order size
              x-parser-schema-id: <anonymous-schema-19>
            size_matched:
              type: string
              description: Amount matched so far
              x-parser-schema-id: <anonymous-schema-20>
            price:
              type: string
              x-parser-schema-id: <anonymous-schema-21>
            associate_trades:
              type: array
              items:
                type: string
                x-parser-schema-id: <anonymous-schema-23>
              nullable: true
              description: Trade IDs this order has been matched in
              x-parser-schema-id: <anonymous-schema-22>
            outcome:
              type: string
              description: e.g. 'YES', 'NO'
              x-parser-schema-id: <anonymous-schema-24>
            type:
              type: string
              enum:
                - PLACEMENT
                - UPDATE
                - CANCELLATION
              x-parser-schema-id: <anonymous-schema-25>
            created_at:
              type: string
              x-parser-schema-id: <anonymous-schema-26>
            expiration:
              type: string
              description: For GTD orders
              x-parser-schema-id: <anonymous-schema-27>
            order_type:
              type: string
              enum:
                - GTC
                - GTD
                - FOK
              x-parser-schema-id: <anonymous-schema-28>
            status:
              type: string
              description: e.g. 'LIVE', 'MATCHED', 'CANCELED'
              x-parser-schema-id: <anonymous-schema-29>
            maker_address:
              type: string
              x-parser-schema-id: <anonymous-schema-30>
            timestamp:
              type: string
              description: Event timestamp in milliseconds
              x-parser-schema-id: <anonymous-schema-31>
          x-parser-schema-id: OrderEvent
        title: Order Event
        description: Order placement, update, or cancellation
        example: |-
          {
            "event_type": "order",
            "id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
            "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
            "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
            "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
            "side": "SELL",
            "order_owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
            "original_size": "10",
            "size_matched": "0",
            "price": "0.57",
            "associate_trades": null,
            "outcome": "YES",
            "type": "PLACEMENT",
            "created_at": "1672290687",
            "expiration": "1234567",
            "order_type": "GTD",
            "status": "LIVE",
            "maker_address": "0x1234...",
            "timestamp": "1672290687"
          }
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: order
    bindings: []
    extensions: *ref_0
  - &ref_6
    id: receiveTrade
    title: Trade Event
    description: Trade match or status change event for the authenticated user
    type: send
    messages:
      - &ref_12
        id: trade
        contentType: application/json
        payload:
          - name: Trade Event
            description: Trade match, confirmation, or status change
            type: object
            properties:
              - name: event_type
                type: string
                description: trade
                required: true
              - name: type
                type: string
                description: TRADE
                required: true
              - name: id
                type: string
                description: Trade ID
                required: true
              - name: taker_order_id
                type: string
                required: true
              - name: market
                type: string
                description: Condition ID
                required: true
              - name: asset_id
                type: string
                required: true
              - name: side
                type: string
                description: From taker's perspective
                enumValues:
                  - BUY
                  - SELL
                required: true
              - name: size
                type: string
                required: true
              - name: price
                type: string
                required: true
              - name: fee_rate_bps
                type: string
                required: false
              - name: status
                type: string
                enumValues:
                  - MATCHED
                  - MINED
                  - CONFIRMED
                  - RETRYING
                  - FAILED
                required: true
              - name: matchtime
                type: string
                required: false
              - name: last_update
                type: string
                required: false
              - name: outcome
                type: string
                required: false
              - name: owner
                type: string
                description: API key of the taker
                required: true
              - name: trade_owner
                type: string
                required: false
              - name: maker_address
                type: string
                required: false
              - name: transaction_hash
                type: string
                required: false
              - name: bucket_index
                type: integer
                required: false
              - name: maker_orders
                type: array
                required: false
                properties:
                  - name: order_id
                    type: string
                    required: true
                  - name: owner
                    type: string
                    required: true
                  - name: maker_address
                    type: string
                    required: false
                  - name: matched_amount
                    type: string
                    required: true
                  - name: price
                    type: string
                    required: true
                  - name: fee_rate_bps
                    type: string
                    required: false
                  - name: asset_id
                    type: string
                    required: true
                  - name: outcome
                    type: string
                    required: false
                  - name: side
                    type: string
                    enumValues:
                      - BUY
                      - SELL
                    required: false
              - name: trader_side
                type: string
                description: Whether the receiving user was TAKER or MAKER
                enumValues:
                  - TAKER
                  - MAKER
                required: false
              - name: timestamp
                type: string
                description: Event timestamp in milliseconds
                required: true
        headers: []
        jsonPayloadSchema:
          type: object
          description: Trade match, confirmation, or status change event
          required:
            - event_type
            - type
            - id
            - taker_order_id
            - market
            - asset_id
            - side
            - size
            - price
            - status
            - owner
            - timestamp
          properties:
            event_type:
              type: string
              const: trade
              x-parser-schema-id: <anonymous-schema-32>
            type:
              type: string
              const: TRADE
              x-parser-schema-id: <anonymous-schema-33>
            id:
              type: string
              description: Trade ID
              x-parser-schema-id: <anonymous-schema-34>
            taker_order_id:
              type: string
              x-parser-schema-id: <anonymous-schema-35>
            market:
              type: string
              description: Condition ID
              x-parser-schema-id: <anonymous-schema-36>
            asset_id:
              type: string
              x-parser-schema-id: <anonymous-schema-37>
            side:
              type: string
              enum:
                - BUY
                - SELL
              description: From taker's perspective
              x-parser-schema-id: <anonymous-schema-38>
            size:
              type: string
              x-parser-schema-id: <anonymous-schema-39>
            price:
              type: string
              x-parser-schema-id: <anonymous-schema-40>
            fee_rate_bps:
              type: string
              x-parser-schema-id: <anonymous-schema-41>
            status:
              type: string
              enum:
                - MATCHED
                - MINED
                - CONFIRMED
                - RETRYING
                - FAILED
              x-parser-schema-id: <anonymous-schema-42>
            matchtime:
              type: string
              x-parser-schema-id: <anonymous-schema-43>
            last_update:
              type: string
              x-parser-schema-id: <anonymous-schema-44>
            outcome:
              type: string
              x-parser-schema-id: <anonymous-schema-45>
            owner:
              type: string
              description: API key of the taker
              x-parser-schema-id: <anonymous-schema-46>
            trade_owner:
              type: string
              x-parser-schema-id: <anonymous-schema-47>
            maker_address:
              type: string
              x-parser-schema-id: <anonymous-schema-48>
            transaction_hash:
              type: string
              x-parser-schema-id: <anonymous-schema-49>
            bucket_index:
              type: integer
              x-parser-schema-id: <anonymous-schema-50>
            maker_orders:
              type: array
              items:
                type: object
                description: Maker order details within a trade
                required:
                  - order_id
                  - owner
                  - matched_amount
                  - price
                  - asset_id
                properties:
                  order_id:
                    type: string
                    x-parser-schema-id: <anonymous-schema-52>
                  owner:
                    type: string
                    x-parser-schema-id: <anonymous-schema-53>
                  maker_address:
                    type: string
                    x-parser-schema-id: <anonymous-schema-54>
                  matched_amount:
                    type: string
                    x-parser-schema-id: <anonymous-schema-55>
                  price:
                    type: string
                    x-parser-schema-id: <anonymous-schema-56>
                  fee_rate_bps:
                    type: string
                    x-parser-schema-id: <anonymous-schema-57>
                  asset_id:
                    type: string
                    x-parser-schema-id: <anonymous-schema-58>
                  outcome:
                    type: string
                    x-parser-schema-id: <anonymous-schema-59>
                  side:
                    type: string
                    enum:
                      - BUY
                      - SELL
                    x-parser-schema-id: <anonymous-schema-60>
                x-parser-schema-id: TradeMakerOrder
              x-parser-schema-id: <anonymous-schema-51>
            trader_side:
              type: string
              enum:
                - TAKER
                - MAKER
              description: Whether the receiving user was TAKER or MAKER
              x-parser-schema-id: <anonymous-schema-61>
            timestamp:
              type: string
              description: Event timestamp in milliseconds
              x-parser-schema-id: <anonymous-schema-62>
          x-parser-schema-id: TradeEvent
        title: Trade Event
        description: Trade match, confirmation, or status change
        example: |-
          {
            "event_type": "trade",
            "type": "TRADE",
            "id": "28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e",
            "taker_order_id": "0x06bc63e346ed4ceddce9efd6b3af37c8f8f440c92fe7da6b2d0f9e4ccbc50c42",
            "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
            "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
            "side": "BUY",
            "size": "10",
            "price": "0.57",
            "fee_rate_bps": "0",
            "status": "MATCHED",
            "matchtime": "1672290701",
            "last_update": "1672290701",
            "outcome": "YES",
            "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
            "trade_owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
            "maker_address": "0x1234...",
            "transaction_hash": "",
            "bucket_index": 0,
            "maker_orders": [
              {
                "order_id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
                "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
                "maker_address": "0x5678...",
                "matched_amount": "10",
                "price": "0.57",
                "fee_rate_bps": "0",
                "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
                "outcome": "YES",
                "side": "SELL"
              }
            ],
            "trader_side": "TAKER",
            "timestamp": "1672290701"
          }
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: trade
    bindings: []
    extensions: *ref_0
sendOperations:
  - *ref_1
  - *ref_2
  - *ref_3
receiveOperations:
  - *ref_4
  - *ref_5
  - *ref_6
sendMessages:
  - *ref_7
  - *ref_8
  - *ref_9
receiveMessages:
  - *ref_10
  - *ref_11
  - *ref_12
extensions:
  - id: x-parser-unique-object-id
    value: user
securitySchemes: []

````