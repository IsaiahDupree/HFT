> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Sports WebSocket

> Live sports scores and game state

The Sports WebSocket provides real-time sports results updates, including scores, periods, and game status. No authentication required.

<Warning>
  This feed is provided for informational purposes only. It may be delayed,
  contain errors, or omit recent events. Polymarket does not provide trading or
  investment advice, and this content should not be used as the basis for any
  trading decision.
</Warning>

## Endpoint

```
wss://sports-api.polymarket.com/ws
```

No subscription message required — connect and start receiving data for all active sports events.

## Heartbeat

The server sends `ping` every 5 seconds. Respond with `pong` within 10 seconds or the connection will close.

```javascript theme={null}
ws.onmessage = (event) => {
  if (event.data === "ping") {
    ws.send("pong");
    return;
  }

  // Handle JSON messages...
};
```

## Message Type

Each message is a JSON object with game state fields.

### sport\_result

Emitted when:

* A match goes live
* The score changes
* The period changes (e.g., halftime, overtime)
* A match ends
* Possession changes (NFL and CFB only)

**NFL (in progress):**

```json theme={null}
{
  "gameId": 19439,
  "leagueAbbreviation": "nfl",
  "slug": "nfl-lac-buf-2025-01-26",
  "homeTeam": "LAC",
  "awayTeam": "BUF",
  "status": "InProgress",
  "score": "3-16",
  "period": "Q4",
  "elapsed": "5:18",
  "live": true,
  "ended": false,
  "turn": "lac"
}
```

**Esports — CS2 (finished):**

```json theme={null}
{
  "gameId": 1317359,
  "leagueAbbreviation": "cs2",
  "slug": "cs2-arcred-the-glecs-2025-07-20",
  "homeTeam": "ARCRED",
  "awayTeam": "The glecs",
  "status": "finished",
  "score": "000-000|2-0|Bo3",
  "period": "2/3",
  "live": false,
  "ended": true,
  "finished_timestamp": "2025-07-20T18:30:00.000Z"
}
```

The `finished_timestamp` field is an ISO 8601 timestamp only present when `ended: true`.

The `slug` field follows the format `{league}-{team1}-{team2}-{date}` (e.g., `nfl-buf-kc-2025-01-26`).

## Period Values

| Period                 | Description                             |
| ---------------------- | --------------------------------------- |
| `1H`                   | First half                              |
| `2H`                   | Second half                             |
| `1Q`, `2Q`, `3Q`, `4Q` | Quarters (NFL, NBA)                     |
| `HT`                   | Halftime                                |
| `FT`                   | Full time (match ended in regulation)   |
| `FT OT`                | Full time with overtime                 |
| `FT NR`                | Full time, no result (draw or canceled) |
| `End 1`, `End 2`, ...  | End of inning (MLB)                     |
| `1/3`, `2/3`, `3/3`    | Map number in Bo3 series (Esports)      |
| `1/5`, `2/5`, ...      | Map number in Bo5 series (Esports)      |

## Game Status Values

Game status values vary by sport:

### NFL

| Status         | Description                  |
| -------------- | ---------------------------- |
| `Scheduled`    | Game not yet started         |
| `InProgress`   | Game currently playing       |
| `Final`        | Game completed in regulation |
| `F/OT`         | Final after overtime         |
| `Suspended`    | Game suspended               |
| `Postponed`    | Game postponed               |
| `Delayed`      | Game delayed                 |
| `Canceled`     | Game canceled                |
| `Forfeit`      | Game forfeited               |
| `NotNecessary` | Scheduled, but not needed    |

### NHL

| Status         | Description                  |
| -------------- | ---------------------------- |
| `Scheduled`    | Game not yet started         |
| `InProgress`   | Game currently playing       |
| `Final`        | Game completed in regulation |
| `F/OT`         | Final after overtime         |
| `F/SO`         | Final after shootout         |
| `Suspended`    | Game suspended               |
| `Postponed`    | Game postponed               |
| `Delayed`      | Game delayed                 |
| `Canceled`     | Game canceled                |
| `Forfeit`      | Game forfeited               |
| `NotNecessary` | Scheduled, but not needed    |

### MLB

| Status         | Description               |
| -------------- | ------------------------- |
| `Scheduled`    | Game not yet started      |
| `InProgress`   | Game currently playing    |
| `Final`        | Game completed            |
| `Suspended`    | Game suspended            |
| `Delayed`      | Game delayed              |
| `Postponed`    | Game postponed            |
| `Canceled`     | Game canceled             |
| `Forfeit`      | Game forfeited            |
| `NotNecessary` | Scheduled, but not needed |

### NBA and CBB

| Status         | Description               |
| -------------- | ------------------------- |
| `Scheduled`    | Game not yet started      |
| `InProgress`   | Game currently playing    |
| `Final`        | Game completed            |
| `F/OT`         | Final after overtime      |
| `Suspended`    | Game suspended            |
| `Postponed`    | Game postponed            |
| `Delayed`      | Game delayed              |
| `Canceled`     | Game canceled             |
| `Forfeit`      | Game forfeited            |
| `NotNecessary` | Scheduled, but not needed |

### CFB

| Status       | Description            |
| ------------ | ---------------------- |
| `Scheduled`  | Game not yet started   |
| `InProgress` | Game currently playing |
| `Final`      | Game completed         |
| `F/OT`       | Final after overtime   |
| `Suspended`  | Game suspended         |
| `Postponed`  | Game postponed         |
| `Delayed`    | Game delayed           |
| `Canceled`   | Game canceled          |
| `Forfeit`    | Game forfeited         |

### Soccer

| Status            | Description                          |
| ----------------- | ------------------------------------ |
| `Scheduled`       | Game not yet started                 |
| `InProgress`      | Game currently playing               |
| `Break`           | Halftime or other break              |
| `Suspended`       | Game suspended                       |
| `PenaltyShootout` | Penalty shootout in progress         |
| `Final`           | Game completed                       |
| `Awarded`         | Result awarded due to ruling/forfeit |
| `Postponed`       | Game postponed                       |
| `Canceled`        | Game canceled                        |

### Esports

| Status        | Description             |
| ------------- | ----------------------- |
| `not_started` | Match not yet started   |
| `running`     | Match currently playing |
| `finished`    | Match completed         |
| `postponed`   | Match postponed         |
| `canceled`    | Match canceled          |

### Tennis

| Status       | Description             |
| ------------ | ----------------------- |
| `scheduled`  | Match not yet started   |
| `inprogress` | Match currently playing |
| `suspended`  | Match suspended         |
| `finished`   | Match completed         |
| `postponed`  | Match postponed         |
| `cancelled`  | Match canceled          |
