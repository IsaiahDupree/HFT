/**
 * Keyword-based Polymarket market classifier.
 *
 * Maps a market's question/slug to one of: geopolitics, elections, crypto,
 * sports, macro, weather, other. First-pass implementation — expected to
 * misclassify ~5–10% (e.g. "Will SpaceX launch Starship?" → "other" instead
 * of "tech"). Iteration plan: collect misclassifications from production,
 * extend the keyword tables.
 *
 * Pure function — no DB, no HTTP. Used by:
 *   - snapshot-worker, to populate `market_snapshots.category` on insert
 *   - scripts/categorize-markets, the one-shot backfill
 *   - category_specialist genome, to filter its candidate list per tick
 *
 * Spec: `docs/prds/lunar-inspired-arena-strategies.md` §6.2.R2 + Phase 3 of
 * `IMPLEMENTATION-PLAN.md`.
 */
export type MarketCategory =
  | "geopolitics"
  | "elections"
  | "crypto"
  | "sports"
  | "macro"
  | "weather"
  | "tech"
  | "other";

export const CATEGORY_VALUES: readonly MarketCategory[] = [
  "geopolitics", "elections", "crypto", "sports", "macro", "weather", "tech", "other",
] as const;

/** Keyword sets per category. Order matters — first match wins, so put the
 *  most specific categories above the more general ones (elections before
 *  geopolitics; crypto before macro). */
const KEYWORDS: Array<{ category: MarketCategory; words: string[] }> = [
  // Elections — specific candidate/party names + election-process terms
  {
    category: "elections",
    words: [
      "election", "primary", "caucus", "ballot", "vote", "senate", "house race",
      "governor", "presidential", "incumbent", "biden", "trump", "harris",
      "republican", "democrat", "gop", "dnc", "nominee", "midterm", "polling",
    ],
  },
  // Crypto — coins, exchanges, on-chain events
  {
    category: "crypto",
    words: [
      "btc", "bitcoin", "eth", "ethereum", "sol", "solana", "doge", "xrp",
      "binance", "coinbase", "kraken", "tether", "stablecoin", "halving",
      "altcoin", "memecoin", "satoshi", "vitalik", "etf", "spot price",
      "all-time high", "ath", "bull market", "bear market",
    ],
  },
  // Sports — team names, leagues, athletes
  {
    category: "sports",
    words: [
      "nfl", "nba", "mlb", "nhl", "fifa", "uefa", "champions league",
      "super bowl", "world cup", "world series", "premier league",
      "soccer", "football", "basketball", "baseball", "hockey", "tennis",
      "us open", "wimbledon", "olympic", "olympics", "lakers", "celtics",
      "tottenham", "sunderland", "real madrid", "barcelona", "manchester",
      "messi", "ronaldo", "lebron", "djokovic", "match", "game", "playoff",
    ],
  },
  // Macro — Fed, GDP, inflation, rates
  {
    category: "macro",
    words: [
      "fed", "federal reserve", "fomc", "rate cut", "rate hike", "interest rate",
      "inflation", "cpi", "ppi", "gdp", "unemployment", "jobs report", "nfp",
      "recession", "yield curve", "treasury", "powell", "yellen", "consumer price",
    ],
  },
  // Weather — natural events
  {
    category: "weather",
    words: [
      "hurricane", "storm", "tropical", "tornado", "earthquake", "wildfire",
      "snow", "snowfall", "heatwave", "temperature", "rainfall", "drought",
      "el niño", "el nino", "la niña", "la nina",
    ],
  },
  // Tech — companies, AI, launches
  {
    category: "tech",
    words: [
      "openai", "anthropic", "chatgpt", "gpt-5", "claude", "gemini", "llama",
      "spacex", "starship", "tesla", "apple", "google", "microsoft", "nvidia",
      "ai model", "agi", "iphone", "vision pro",
    ],
  },
  // Geopolitics — war, leaders, countries (last because some sports/election
  // markets mention countries)
  {
    category: "geopolitics",
    words: [
      "ukraine", "russia", "putin", "zelensky", "war", "ceasefire", "invade",
      "china", "taiwan", "xi jinping", "iran", "israel", "gaza", "hamas",
      "north korea", "kim jong-un", "nato", "treaty", "sanctions", "embargo",
      "venezuela", "syria", "afghanistan",
    ],
  },
];

/**
 * Classify a market by its question + slug. Tokens are lower-cased and
 * matched as substrings (so "Will Ukraine cede territory by 2027?" matches
 * "ukraine" → geopolitics).
 */
export function classifyMarket(question: string, slug?: string): MarketCategory {
  const haystack = `${question ?? ""} ${slug ?? ""}`.toLowerCase();
  for (const { category, words } of KEYWORDS) {
    for (const w of words) {
      if (haystack.includes(w)) return category;
    }
  }
  return "other";
}

/** Batched classification — convenience for backfills. */
export function classifyMany(rows: Array<{ id: number; question: string; slug?: string }>): Array<{ id: number; category: MarketCategory }> {
  return rows.map((r) => ({ id: r.id, category: classifyMarket(r.question, r.slug) }));
}
