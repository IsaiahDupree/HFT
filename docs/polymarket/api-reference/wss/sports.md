> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Sports Channel

> Public WebSocket for real-time sports match results.



## AsyncAPI

````yaml asyncapi-sports.json sports
id: sports
title: Sports Channel
description: >-
  Public channel broadcasting live sports results. No subscription message
  required — connect and immediately start receiving updates for all active
  events. The server sends a ping every 5 seconds; respond with pong within 10
  seconds to stay connected.
servers:
  - id: production
    protocol: wss
    host: sports-api.polymarket.com
    bindings: []
    variables: []
address: /ws
parameters: []
bindings: []
operations:
  - &ref_2
    id: ping
    title: Ping
    description: Server sends ping every 5 seconds — respond with pong within 10 seconds
    type: send
    messages:
      - &ref_5
        id: ping
        contentType: text/plain
        payload:
          - type: string
            const: ping
            x-parser-schema-id: <anonymous-schema-1>
            name: Ping
            description: Server heartbeat sent every 5 seconds
        headers: []
        jsonPayloadSchema:
          type: string
          const: ping
          x-parser-schema-id: <anonymous-schema-1>
        title: Ping
        description: Server heartbeat sent every 5 seconds
        example: '{}'
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: ping
    bindings: []
    extensions: &ref_0
      - id: x-parser-unique-object-id
        value: sports
  - &ref_1
    id: pong
    title: Pong
    description: Client responds to server ping
    type: receive
    messages:
      - &ref_4
        id: pong
        contentType: text/plain
        payload:
          - type: string
            const: pong
            x-parser-schema-id: <anonymous-schema-2>
            name: Pong
            description: Client heartbeat response — must be sent within 10 seconds
        headers: []
        jsonPayloadSchema:
          type: string
          const: pong
          x-parser-schema-id: <anonymous-schema-2>
        title: Pong
        description: Client heartbeat response — must be sent within 10 seconds
        example: '{}'
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: pong
    bindings: []
    extensions: *ref_0
  - &ref_3
    id: receiveSportsUpdate
    title: Sports Update
    description: Live match update broadcast to all connected clients
    type: send
    messages:
      - &ref_6
        id: sportsUpdate
        contentType: application/json
        payload:
          - name: Sports Result Update
            description: Real-time sports match update
            type: object
            properties:
              - name: slug
                type: string
                description: Unique match identifier (e.g., 'mci-liv-2025-02-03')
                required: true
              - name: live
                type: boolean
                description: Whether the match is currently in progress
                required: false
              - name: ended
                type: boolean
                description: Whether the match has ended
                required: false
              - name: score
                type: string
                description: Current score (e.g., '2-1' for soccer, '14-7' for football)
                required: false
              - name: period
                type: string
                description: >-
                  Current period. Soccer: '1H', '2H', 'HT', 'FT', 'PEN'. NFL:
                  'Q1'–'Q4', 'HT', 'OT', 'FT'. NBA/CBB: 'Q1'–'Q4', 'HT', 'OT',
                  'FT'. MLB: 'Top 1st', 'Bot 1st', ... Ice Hockey: 'P1', 'P2',
                  'P3', 'OT', 'PEN', 'FT'. Cricket: '1H', '1A', '2H', '2A',
                  'SO', 'FT'. Other: 'CAN', 'POST', 'INT', 'AB'.
                required: false
              - name: elapsed
                type: string
                description: >-
                  Elapsed time in the current period in 'MM:SS' format. Empty
                  string if not applicable.
                required: false
              - name: last_update
                type: string
                description: ISO 8601 timestamp of the last update
                required: false
              - name: finished_timestamp
                type: string
                description: >-
                  ISO 8601 timestamp when the match ended. Only present for
                  ended matches.
                required: false
              - name: turn
                type: string
                description: Team abbreviation with ball possession. NFL only.
                required: false
        headers: []
        jsonPayloadSchema:
          type: object
          description: >-
            Real-time sports match update. Only slug is required; all other
            fields may be omitted if not applicable.
          required:
            - slug
          properties:
            slug:
              type: string
              description: Unique match identifier (e.g., 'mci-liv-2025-02-03')
              x-parser-schema-id: <anonymous-schema-3>
            live:
              type: boolean
              description: Whether the match is currently in progress
              x-parser-schema-id: <anonymous-schema-4>
            ended:
              type: boolean
              description: Whether the match has ended
              x-parser-schema-id: <anonymous-schema-5>
            score:
              type: string
              description: Current score (e.g., '2-1' for soccer, '14-7' for football)
              x-parser-schema-id: <anonymous-schema-6>
            period:
              type: string
              description: >-
                Current period. Soccer: '1H', '2H', 'HT', 'FT', 'PEN'. NFL:
                'Q1'–'Q4', 'HT', 'OT', 'FT'. NBA/CBB: 'Q1'–'Q4', 'HT', 'OT',
                'FT'. MLB: 'Top 1st', 'Bot 1st', ... Ice Hockey: 'P1', 'P2',
                'P3', 'OT', 'PEN', 'FT'. Cricket: '1H', '1A', '2H', '2A', 'SO',
                'FT'. Other: 'CAN', 'POST', 'INT', 'AB'.
              x-parser-schema-id: <anonymous-schema-7>
            elapsed:
              type: string
              description: >-
                Elapsed time in the current period in 'MM:SS' format. Empty
                string if not applicable.
              x-parser-schema-id: <anonymous-schema-8>
            last_update:
              type: string
              format: date-time
              description: ISO 8601 timestamp of the last update
              x-parser-schema-id: <anonymous-schema-9>
            finished_timestamp:
              type: string
              format: date-time
              description: >-
                ISO 8601 timestamp when the match ended. Only present for ended
                matches.
              x-parser-schema-id: <anonymous-schema-10>
            turn:
              type: string
              description: Team abbreviation with ball possession. NFL only.
              x-parser-schema-id: <anonymous-schema-11>
          x-parser-schema-id: SportResult
        title: Sports Result Update
        description: Real-time sports match update
        example: |-
          {
            "slug": "mci-liv-2025-02-03",
            "live": true,
            "ended": false,
            "score": "1-0",
            "period": "1H",
            "elapsed": "32:15",
            "last_update": "2025-02-03T19:50:16.939Z"
          }
        bindings: []
        extensions:
          - id: x-parser-unique-object-id
            value: sportsUpdate
    bindings: []
    extensions: *ref_0
sendOperations:
  - *ref_1
receiveOperations:
  - *ref_2
  - *ref_3
sendMessages:
  - *ref_4
receiveMessages:
  - *ref_5
  - *ref_6
extensions:
  - id: x-parser-unique-object-id
    value: sports
securitySchemes: []

````