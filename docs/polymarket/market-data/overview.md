> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Overview

> Fetch market data with no authentication required

All market data is available through public REST endpoints. No API key, no authentication, no wallet required.

```bash theme={null}
curl "https://gamma-api.polymarket.com/events?limit=5"
```

***

## Data Model

Polymarket structures data using two organizational models. The most fundamental element is always markets—events simply provide additional organization.

<Steps>
  <Step title="Event">
    A top-level object representing a question (e.g., "Who will win the 2024
    Presidential Election?"). Contains one or more markets.
  </Step>

  <Step title="Market">
    A specific tradable binary outcome within an event. Maps to a pair of CLOB
    token IDs, a market address, a question ID, and a condition ID.
  </Step>
</Steps>

### Single-Market Events vs Multi-Market Events

| Type                | Example                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Single-market event | "Will Bitcoin reach \$100k?" → 1 market (Yes/No)                                               |
| Multi-market event  | "Where will Barron Trump attend College?" → Markets for Georgetown, NYU, UPenn, Harvard, Other |

### Outcomes and Prices

Each market has `outcomes` and `outcomePrices` arrays that map 1:1. Prices represent implied probabilities:

```json theme={null}
{
  "outcomes": "[\"Yes\", \"No\"]",
  "outcomePrices": "[\"0.20\", \"0.80\"]"
}
// Index 0: "Yes" → 0.20 (20% probability)
// Index 1: "No" → 0.80 (80% probability)
```

<Info>Markets can be traded via the CLOB if `enableOrderBook` is `true`.</Info>

***

## Available Data

Endpoints are split across three APIs. See the [API Reference](/api-reference/introduction) for full endpoint documentation with parameters and response schemas.

### Gamma API - Events Markets and Discovery

| Endpoint             | Description                                 |
| -------------------- | ------------------------------------------- |
| `GET /events`        | List events with filtering and pagination   |
| `GET /events/{id}`   | Get a single event by ID                    |
| `GET /markets`       | List markets with filtering and pagination  |
| `GET /markets/{id}`  | Get a single market by ID                   |
| `GET /public-search` | Search across events, markets, and profiles |
| `GET /tags`          | Ranked tags/categories                      |
| `GET /series`        | Series (grouped events)                     |
| `GET /sports`        | Sports metadata                             |
| `GET /teams`         | Teams                                       |

### CLOB API - Prices and Orderbooks

| Endpoint              | Description                       |
| --------------------- | --------------------------------- |
| `GET /price`          | Price for a single token          |
| `GET /prices`         | Prices for multiple tokens        |
| `GET /book`           | Order book for a token            |
| `POST /books`         | Order books for multiple tokens   |
| `GET /prices-history` | Historical price data for a token |
| `GET /midpoint`       | Midpoint price for a token        |
| `GET /spread`         | Spread for a token                |

### Data API - Positions Trades and Analytics

| Endpoint                               | Description                  |
| -------------------------------------- | ---------------------------- |
| `GET /positions?user={address}`        | Current positions for a user |
| `GET /closed-positions?user={address}` | Closed positions for a user  |
| `GET /activity?user={address}`         | Onchain activity for a user  |
| `GET /value?user={address}`            | Total position value         |
| `GET /oi`                              | Open interest for a market   |
| `GET /holders`                         | Top holders of a market      |
| `GET /trades`                          | Trade history                |

***

## Next Steps

<CardGroup cols={2}>
  <Card title="Fetching Markets" icon="magnifying-glass" href="/market-data/fetching-markets">
    Three strategies for discovering and querying markets.
  </Card>

  <Card title="API Reference" icon="code" href="/api-reference/introduction">
    Full endpoint documentation with parameters and response schemas.
  </Card>
</CardGroup>
