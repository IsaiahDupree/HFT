> ## Documentation Index
> Fetch the complete documentation index at: https://docs.polymarket.com/llms.txt
> Use this file to discover all available pages before exploring further.

# Fetching Markets

> Three strategies for discovering and querying markets

<Tip>
  Both the events and markets endpoints are paginated. See
  [pagination](#pagination) for details.
</Tip>

There are three main strategies for retrieving market data, each optimized for different use cases:

1. **By Slug** — Best for fetching specific individual markets or events
2. **By Tags** — Ideal for filtering markets by category or sport
3. **Via Events Endpoint** — Most efficient for retrieving all active markets

***

## Fetch by Slug

**Use case:** When you need to retrieve a specific market or event that you already know about.

Individual markets and events are best fetched using their unique slug identifier. The slug can be found directly in the Polymarket frontend URL.

### How to Extract the Slug

From any Polymarket URL, the slug is the path segment after `/event/`:

```
https://polymarket.com/event/fed-decision-in-october
                                ↑
                      Slug: fed-decision-in-october
```

### Examples

```bash theme={null}
# Fetch an event by slug (query parameter)
curl "https://gamma-api.polymarket.com/events?slug=fed-decision-in-october"

# Or use the path endpoint
curl "https://gamma-api.polymarket.com/events/slug/fed-decision-in-october"
```

```bash theme={null}
# Fetch a market by slug (query parameter)
curl "https://gamma-api.polymarket.com/markets?slug=fed-decision-in-october"

# Or use the path endpoint
curl "https://gamma-api.polymarket.com/markets/slug/fed-decision-in-october"
```

***

## Fetch by Tags

**Use case:** When you want to filter markets by category, sport, or topic.

Tags provide a way to categorize and filter markets. You can discover available tags and then use them to filter your requests.

### Discover Available Tags

**General tags:** `GET /tags` (Gamma API)

**Sports tags and metadata:** `GET /sports` (Gamma API)

The `/sports` endpoint returns metadata for sports including tag IDs, images, resolution sources, and series information.

### Filter by Tag

Once you have tag IDs, use the `tag_id` parameter in both events and markets endpoints:

```bash theme={null}
# Fetch events for a specific tag
curl "https://gamma-api.polymarket.com/events?tag_id=100381&limit=10&active=true&closed=false"
```

### Additional Tag Filtering

You can also:

* Use `related_tags=true` to include related tag markets
* Exclude specific tags with `exclude_tag_id`

```bash theme={null}
# Include related tags
curl "https://gamma-api.polymarket.com/events?tag_id=100381&related_tags=true&active=true&closed=false"
```

***

## Fetch All Active Markets

**Use case:** When you need to retrieve all available active markets, typically for broader analysis or market discovery.

The most efficient approach is to use the events endpoint with `active=true&closed=false`, as events contain their associated markets.

```bash theme={null}
curl "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100"
```

### Key Parameters

| Parameter   | Description                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `order`     | Field to order by (`volume_24hr`, `volume`, `liquidity`, `start_date`, `end_date`, `competitive`, `closed_time`) |
| `ascending` | Sort direction (`true` for ascending, `false` for descending). Default: `false`                                  |
| `active`    | Filter by active status (`true` for live tradable events)                                                        |
| `closed`    | Filter by closed status. Default: `false`                                                                        |
| `limit`     | Results per page                                                                                                 |
| `offset`    | Number of results to skip for pagination                                                                         |

```bash theme={null}
# Get the highest volume active events
curl "https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume_24hr&ascending=false&limit=100"
```

***

## Pagination

All list endpoints return paginated responses with `limit` and `offset` parameters:

```bash theme={null}
# Page 1: First 50 results
curl "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&offset=0"

# Page 2: Next 50 results
curl "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&offset=50"

# Page 3: Next 50 results
curl "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=50&offset=100"
```

***

## Best Practices

1. **For individual markets:** Use the slug method for direct lookups
2. **For category browsing:** Use tag filtering to reduce API calls
3. **For complete market discovery:** Use the events endpoint with pagination
4. **Always include `active=true`** when fetching live markets. The `closed` parameter now defaults to `false`, so closed markets are excluded automatically — pass `closed=true` only if you need historical data
5. **Use the events endpoint** and work backwards — events contain their associated markets, reducing the number of API calls needed

***

## Next Steps

<CardGroup cols={2}>
  <Card title="API Reference" icon="code" href="/api-reference/introduction">
    Full endpoint documentation with parameters and response schemas.
  </Card>
</CardGroup>
