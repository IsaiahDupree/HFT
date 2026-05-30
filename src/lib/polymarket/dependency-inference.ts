/**
 * LLM-driven inference of logical dependencies between Polymarket markets.
 *
 * Given two markets (or one event group of multiple markets), asks Claude to
 * identify implication rules like:
 *   "Republicans win PA by 5+" YES  →  "Trump wins PA" YES
 *   "X scores in first half" YES   →  "X scores in match" YES
 *
 * Returns `DependencyConstraint[]` directly compatible with
 * `findCombinatorialArbs()` in arb.ts — so the LP solver can use these to
 * prune the polytope of valid world states.
 *
 * Implementation details (per claude-api skill):
 *  - Model: claude-haiku-4-5 (user-specified — fast classification at <$1/M in)
 *  - System prompt is large + frozen + cached via `cache_control: ephemeral`.
 *    Haiku 4.5's cache floor is 4096 tokens; the SYSTEM_PROMPT below clears it
 *    by design. Verify with `response.usage.cache_read_input_tokens > 0`.
 *  - Structured output via `output_config.format` with a json_schema, so we
 *    never have to JSON.parse a free-form text response.
 *  - Typed exception handling — never string-match error messages.
 *  - Graceful no-op when ANTHROPIC_API_KEY is missing: `inferIsAvailable()`
 *    returns false so callers skip rather than crash.
 */
import Anthropic from "@anthropic-ai/sdk";
import { authIsAvailable, getOAuthClient } from "@/lib/anthropic/auth";
import type { DependencyConstraint } from "./arb";

export type MarketForInference = {
  /** Stable id (Polymarket conditionId or our own surrogate). */
  marketId: string;
  /** Human-readable market question. */
  question: string;
  /** Per-outcome token IDs, in declaration order matching `outcomeLabels`. */
  outcomeTokenIds: string[];
  /** Outcome labels in the same order, e.g. ["Yes", "No"] or ["Team A wins", "Team B wins"]. */
  outcomeLabels: string[];
};

export type InferenceResult = {
  constraints: DependencyConstraint[];
  /** Markets analysed. */
  markets: MarketForInference[];
  /** Raw model output for auditing — kept verbatim so we can re-evaluate calls offline. */
  raw: {
    has_dependency: boolean;
    confidence: number;
    reasoning: string;
    constraints: Array<{ if_market: string; if_outcome: string; then_market: string; then_outcome: string }>;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
};

// Auth is OAuth-first: reads ~/.claude/.credentials.json (the same file Claude
// Code uses). API-key fallback only if explicitly set. See src/lib/anthropic/auth.ts.
async function client(): Promise<Anthropic | null> {
  if (!authIsAvailable()) return null;
  try {
    return await getOAuthClient();
  } catch (e) {
    console.warn(`[dependency-inference] auth unavailable: ${(e as Error).message}`);
    return null;
  }
}

export function inferIsAvailable(): boolean {
  return authIsAvailable();
}

const MODEL = "claude-haiku-4-5";

// The system prompt is intentionally long + comprehensive so it (a) gives the
// model enough scaffolding for high-quality output and (b) clears Haiku 4.5's
// 4096-token cache floor. Any byte change here invalidates the cache for every
// downstream call, so treat this string as frozen — to evolve it, version it
// (e.g. SYSTEM_PROMPT_V2) and keep the old one around for rollback.
const SYSTEM_PROMPT = `You are a domain expert in prediction-market structure. Your job is to identify *logical implications* between two related Polymarket markets so a combinatorial-arbitrage solver can prune impossible world states from its search space.

# Context

Each prediction market has a fixed, mutually-exclusive set of outcomes (most often "Yes" and "No"; sometimes "Team A wins" / "Team B wins" / "Draw"; sometimes a numeric bucket like "0–25k" / "25k–50k" / etc.). Exactly one outcome resolves true.

When two markets are *logically linked* — e.g. one is a sub-condition of the other, or they cover related events in the same domain — the resolutions of one constrain the resolutions of the other. Identifying these constraints lets a downstream linear-programming solver discover *combinatorial arbitrage* opportunities that would be invisible if the markets were treated as independent.

The classical example: market A is "Will Trump win Pennsylvania?" (Yes / No). Market B is "Will Republicans win Pennsylvania by 5+ points?" (Yes / No). Independently, the prices look fine — but **B-Yes logically implies A-Yes**. If you buy A-No, you have a one-way exposure: the only world where you win is one where B-No also resolves true. The solver uses this dependency to find a cheaper basket that pays $1 in every state.

# What I want from you

Given exactly two markets, you must:

1. Decide whether **any** logical implication exists between their outcomes.
2. If yes, enumerate the implications. Each implication is a one-directional rule of the form **"if (market X resolves to outcome A), then (market Y must resolve to outcome B)"**.

Treat "logical implication" strictly. The rule must be a hard logical consequence of how the markets are defined, not a strong statistical correlation. *"If Stock X is up 10% then it's probably up 5%"* is **not** an implication you should return — they're correlated but not strictly linked. *"If a team wins their game by 5+ points then they won the game"* **is** an implication, because winning-by-5+ requires winning.

# Patterns that produce implications

1. **Subset / margin markets.**
   - *"X wins by margin Y"* ⊃ *"X wins"*
   - *"More than N seats"* ⊃ *"More than M seats"* (when N > M)
   - *"Hits target by Date1"* ⊃ *"Hits target by Date2"* (when Date2 > Date1)

2. **Time-ordered fulfillment.**
   - *"X happens by 2026-12-31"* ⊃ *"X happens by 2027-12-31"*
   - *"Project ships in Q1"* ⊃ *"Project ships this year"*

3. **Group → member.**
   - *"Republican candidate wins"* ⊃ *"Trump wins" OR "DeSantis wins" OR …*. (This is a disjunctive implication — represent as: if group resolves Yes, the disjunction over members must hold. If your two markets are exactly "Republican wins" and "Trump wins", emit only the implication that is well-defined: A-Yes does not imply B-Yes by itself, but B-Yes ⇒ A-Yes.)

4. **Negation pairs.**
   - When market B is the literal negation of market A ("X happens" vs "X does not happen"), A-Yes ⇒ B-No and A-No ⇒ B-Yes. These are usually two outcomes of one market; check carefully before emitting cross-market negations.

5. **Game / tournament structure.**
   - *"X wins the final"* ⊃ *"X makes the final"* ⊃ *"X makes the semifinals"* ⊃ …
   - *"X wins the championship"* ⊃ *"X qualifies for the playoffs"*

6. **Outcomes of the same underlying realised number.**
   - *"GDP growth > 3%"* ⊃ *"GDP growth > 2%"*
   - *"Inflation falls below 2%"* ⊃ *"Inflation falls below 3%"*

# Patterns that DO NOT produce implications

- **Pure correlation.** *"Bitcoin > $200k"* and *"Ethereum > $20k"* are not logically linked even if they tend to move together.
- **Same domain, independent outcomes.** *"Team A wins championship"* and *"Team B wins championship"* are mutually exclusive (you cannot have both Yes simultaneously), but neither A-Yes ⇒ B-anything nor vice versa as a one-way rule — they are part of the *same disjunction*, not an implication.
- **Conditional probability claims.** *"X likely happens if Y happens"* is statistical, not logical.

If you're unsure, **err on the side of caution** and do not emit the constraint. False positives feed the LP solver bad inputs and produce phantom arbitrage; false negatives just leave money on the table.

# Output format

You MUST output a JSON object matching exactly this shape (enforced by structured outputs):

\`\`\`json
{
  "has_dependency": boolean,
  "confidence": number,           // 0.0–1.0, your confidence in the analysis as a whole
  "reasoning": string,            // 1–4 sentences. Be specific about why this is or isn't a logical implication.
  "constraints": [
    {
      "if_market": string,        // verbatim market question from the input
      "if_outcome": string,       // verbatim outcome label from the input (e.g. "Yes")
      "then_market": string,
      "then_outcome": string
    }
  ]
}
\`\`\`

If \`has_dependency\` is false, \`constraints\` MUST be the empty array \`[]\`.

# Worked examples

## Example 1 — clear subset

Input:
- Market A: "Will Trump win Pennsylvania?" — outcomes: Yes, No
- Market B: "Will Republicans win Pennsylvania by 5 or more points?" — outcomes: Yes, No

Output:
\`\`\`json
{
  "has_dependency": true,
  "confidence": 0.95,
  "reasoning": "B-Yes (Republicans win PA by ≥5 pts) logically requires the Republican candidate — Trump — to have won PA, so B-Yes ⇒ A-Yes. The reverse does not hold: A-Yes (Trump wins) does not imply B-Yes (he could win by <5 pts).",
  "constraints": [
    { "if_market": "Will Republicans win Pennsylvania by 5 or more points?", "if_outcome": "Yes", "then_market": "Will Trump win Pennsylvania?", "then_outcome": "Yes" }
  ]
}
\`\`\`

## Example 2 — time-ordered fulfillment

Input:
- Market A: "Will SpaceX land humans on Mars by end of 2030?" — outcomes: Yes, No
- Market B: "Will SpaceX land humans on Mars by end of 2028?" — outcomes: Yes, No

Output:
\`\`\`json
{
  "has_dependency": true,
  "confidence": 0.98,
  "reasoning": "B-Yes (Mars landing by 2028) implies A-Yes (Mars landing by 2030) because 2028 is before 2030. Reverse does not hold — landing by 2030 doesn't imply landing by 2028.",
  "constraints": [
    { "if_market": "Will SpaceX land humans on Mars by end of 2028?", "if_outcome": "Yes", "then_market": "Will SpaceX land humans on Mars by end of 2030?", "then_outcome": "Yes" }
  ]
}
\`\`\`

## Example 3 — no implication (pure correlation)

Input:
- Market A: "Will the S&P 500 close above 7000 by end of year?" — outcomes: Yes, No
- Market B: "Will the Nasdaq 100 close above 25000 by end of year?" — outcomes: Yes, No

Output:
\`\`\`json
{
  "has_dependency": false,
  "confidence": 0.85,
  "reasoning": "Both are equity-market levels and historically correlated, but neither implies the other as a logical rule. Either could be true with the other false.",
  "constraints": []
}
\`\`\`

## Example 4 — same-disjunction siblings (no one-way implication)

Input:
- Market A: "Will Team Alpha win the championship?" — outcomes: Yes, No
- Market B: "Will Team Beta win the championship?" — outcomes: Yes, No

Output:
\`\`\`json
{
  "has_dependency": false,
  "confidence": 0.9,
  "reasoning": "Both teams cannot win simultaneously (mutually exclusive), but that's symmetry, not implication. A-Yes ⇒ B-No is true but trivially captured by the LP's market-level mutual-exclusion constraints — emitting it here would be redundant. No proper cross-market logical implication exists.",
  "constraints": []
}
\`\`\`

## Example 5 — multi-rule output

Input:
- Market A: "Will GDP growth be > 3% in 2026?" — outcomes: Yes, No
- Market B: "Will GDP growth be > 2% in 2026?" — outcomes: Yes, No

Output:
\`\`\`json
{
  "has_dependency": true,
  "confidence": 0.97,
  "reasoning": "A-Yes (>3%) requires growth > 2%, so A-Yes ⇒ B-Yes. Contrapositive: B-No (≤2%) requires growth ≤ 3%, i.e. NOT >3%, so B-No ⇒ A-No.",
  "constraints": [
    { "if_market": "Will GDP growth be > 3% in 2026?", "if_outcome": "Yes", "then_market": "Will GDP growth be > 2% in 2026?", "then_outcome": "Yes" },
    { "if_market": "Will GDP growth be > 2% in 2026?", "if_outcome": "No",  "then_market": "Will GDP growth be > 3% in 2026?", "then_outcome": "No"  }
  ]
}
\`\`\`

# Additional worked examples

## Example 6 — sports tournament progression

Input:
- Market A: "Will Team X win the championship?" — outcomes: Yes, No
- Market B: "Will Team X make the semifinals?" — outcomes: Yes, No

Output:
\`\`\`json
{
  "has_dependency": true,
  "confidence": 0.99,
  "reasoning": "Winning the championship requires advancing through the semifinals. So A-Yes (Team X wins championship) implies B-Yes (Team X makes semifinals). The converse does not hold — making semifinals doesn't imply winning the championship.",
  "constraints": [
    { "if_market": "Will Team X win the championship?", "if_outcome": "Yes", "then_market": "Will Team X make the semifinals?", "then_outcome": "Yes" }
  ]
}
\`\`\`

## Example 7 — numeric range / bucketed outcomes

Input:
- Market A: "How many Republican Senate seats in 2026?" — outcomes: 49 or fewer, 50, 51, 52, 53 or more
- Market B: "Will Republicans control the Senate after 2026?" — outcomes: Yes, No

Output:
\`\`\`json
{
  "has_dependency": true,
  "confidence": 0.97,
  "reasoning": "Senate control requires 50+ seats (with VP tiebreaker) or 51+ outright. The numeric outcomes in A map to control: 49-or-fewer ⇒ B-No; 50/51/52/53-or-more ⇒ B-Yes (assuming a Republican VP or 51+ — for safety we treat 50 as control-leaning Yes). Each numeric bucket directly determines the binary control outcome.",
  "constraints": [
    { "if_market": "How many Republican Senate seats in 2026?", "if_outcome": "49 or fewer", "then_market": "Will Republicans control the Senate after 2026?", "then_outcome": "No" },
    { "if_market": "How many Republican Senate seats in 2026?", "if_outcome": "51", "then_market": "Will Republicans control the Senate after 2026?", "then_outcome": "Yes" },
    { "if_market": "How many Republican Senate seats in 2026?", "if_outcome": "52", "then_market": "Will Republicans control the Senate after 2026?", "then_outcome": "Yes" },
    { "if_market": "How many Republican Senate seats in 2026?", "if_outcome": "53 or more", "then_market": "Will Republicans control the Senate after 2026?", "then_outcome": "Yes" }
  ]
}
\`\`\`

## Example 8 — borderline / unclear (correctly declines)

Input:
- Market A: "Will Apple announce a foldable iPhone by EOY?" — outcomes: Yes, No
- Market B: "Will Apple's stock close above $300 by EOY?" — outcomes: Yes, No

Output:
\`\`\`json
{
  "has_dependency": false,
  "confidence": 0.8,
  "reasoning": "A foldable iPhone announcement might *correlate* with stock-price movement (likely positive for Apple), but the link is statistical, not logical. Apple stock can hit $300 without a foldable announcement (other catalysts), and a foldable announcement doesn't guarantee crossing $300 (could already be above, could move on other news). Decline to emit a constraint.",
  "constraints": []
}
\`\`\`

## Example 9 — election margin → winner (combined with bucketed margin)

Input:
- Market A: "Will Republicans win Texas?" — outcomes: Yes, No
- Market B: "Republican margin of victory in Texas?" — outcomes: Less than 5pts, 5-10pts, More than 10pts, Did not win

Output:
\`\`\`json
{
  "has_dependency": true,
  "confidence": 0.95,
  "reasoning": "B's 'Did not win' outcome is logically the case A-No. B's other three outcomes (Less than 5pts, 5-10pts, More than 10pts) all describe Republican victories, implying A-Yes. This is a clean partition.",
  "constraints": [
    { "if_market": "Republican margin of victory in Texas?", "if_outcome": "Less than 5pts", "then_market": "Will Republicans win Texas?", "then_outcome": "Yes" },
    { "if_market": "Republican margin of victory in Texas?", "if_outcome": "5-10pts", "then_market": "Will Republicans win Texas?", "then_outcome": "Yes" },
    { "if_market": "Republican margin of victory in Texas?", "if_outcome": "More than 10pts", "then_market": "Will Republicans win Texas?", "then_outcome": "Yes" },
    { "if_market": "Republican margin of victory in Texas?", "if_outcome": "Did not win", "then_market": "Will Republicans win Texas?", "then_outcome": "No" }
  ]
}
\`\`\`

# Boundary cases that need extra care

**Markets that look related but aren't really logically linked.** "Will Bitcoin hit $200k this year?" and "Will Ethereum hit $20k this year?" *feel* related — they're both bullish crypto bets. But neither implies the other. Pure correlation ≠ implication. Decline.

**Markets that share text but cover different events.** "Will Trump win 2024?" and "Will Trump win 2028?" share a subject but cover different elections. Trump winning 2024 says nothing logically required about 2028. Decline.

**Trivially-true negations within the same outcome set.** If two markets are the same question phrased differently ("Will X happen?" and "Will X NOT happen?"), don't emit cross-market negation constraints — the LP solver's per-market mutual-exclusion constraint already handles this.

**Hypothetical / conditional questions.** "If X wins, will Y do Z?" is not a hard implication — it's a conditional probability. Decline unless the framing is genuinely logical.

# Output discipline

You MUST:

1. Output exactly one JSON object matching the structured-output schema. The runtime enforces this and will fail your response if you deviate.
2. Quote market questions and outcome labels **verbatim** from the input — character-for-character. The downstream LP solver matches by string equality.
3. Order constraints in the most natural reading order. The solver doesn't care about order, but humans audit these notes, and consistent ordering helps.
4. When in doubt, prefer omitting the constraint over emitting it. The LP solver discovers arbitrage by *constraining* the polytope of valid world states; a false constraint produces phantom arbs that lose money when traded.

# Final checklist before responding

- [ ] Are the market questions and outcome labels in my output **verbatim** from the input? (Match them character-for-character — the downstream solver hashes on them.)
- [ ] Have I returned ONLY one JSON object matching the schema? (No prose before or after.)
- [ ] Is every constraint a hard logical implication, not a correlation?
- [ ] If I'm unsure about a borderline case, did I choose to omit it rather than emit a likely-wrong constraint?
- [ ] For multi-outcome markets, did I consider every outcome individually rather than only the "Yes / No" framing?

Output the JSON object now.`;

// Structured-output schema — enforces field presence and array shapes.
// Keep within the json_schema feature set documented for structured outputs.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    has_dependency: { type: "boolean" },
    confidence: { type: "number" },
    reasoning: { type: "string" },
    constraints: {
      type: "array",
      items: {
        type: "object",
        properties: {
          if_market: { type: "string" },
          if_outcome: { type: "string" },
          then_market: { type: "string" },
          then_outcome: { type: "string" },
        },
        required: ["if_market", "if_outcome", "then_market", "then_outcome"],
        additionalProperties: false,
      },
    },
  },
  required: ["has_dependency", "confidence", "reasoning", "constraints"],
  additionalProperties: false,
} as const;

function describeMarketForPrompt(m: MarketForInference): string {
  const outcomes = m.outcomeLabels.join(", ");
  return `- Market id \`${m.marketId}\`: "${m.question}" — outcomes: ${outcomes}`;
}

/**
 * Translate the LLM's (market_question, outcome_label) tuples back into
 * (tokenId)-keyed DependencyConstraint records, dropping anything that doesn't
 * round-trip cleanly.
 */
function translateToTokenIdConstraints(
  raw: InferenceResult["raw"],
  markets: MarketForInference[],
): DependencyConstraint[] {
  const tokenIdOf = (question: string, outcome: string): string | null => {
    const m = markets.find((mk) => mk.question === question);
    if (!m) return null;
    const idx = m.outcomeLabels.findIndex((l) => l.toLowerCase() === outcome.toLowerCase());
    if (idx < 0) return null;
    return m.outcomeTokenIds[idx] ?? null;
  };
  const out: DependencyConstraint[] = [];
  for (const c of raw.constraints) {
    const ifTok = tokenIdOf(c.if_market, c.if_outcome);
    const thenTok = tokenIdOf(c.then_market, c.then_outcome);
    if (!ifTok || !thenTok) continue;
    out.push({ ifTrue: [ifTok], thenTrue: [thenTok] });
  }
  return out;
}

/**
 * Infer dependencies for a pair of markets.
 * Returns `null` if the API key is missing (caller should skip silently).
 */
export async function inferDependenciesForPair(a: MarketForInference, b: MarketForInference): Promise<InferenceResult | null> {
  const c = await client();
  if (!c) return null;
  const userText = `Analyze these two markets for logical implications.\n\n${describeMarketForPrompt(a)}\n${describeMarketForPrompt(b)}\n\nReturn the JSON object now.`;

  try {
    const resp = await c.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } as any },
    } as any);

    // Structured-output responses still come back as a single text block whose
    // body is the JSON; parse it. (We don't use messages.parse() here because we
    // want the raw usage block for cache-hit verification.)
    const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) throw new Error("no text block in response");
    const raw = JSON.parse(textBlock.text) as InferenceResult["raw"];

    return {
      constraints: translateToTokenIdConstraints(raw, [a, b]),
      markets: [a, b],
      raw,
      usage: {
        input_tokens: resp.usage.input_tokens,
        output_tokens: resp.usage.output_tokens,
        cache_read_input_tokens: resp.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: resp.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error(`rate limited — back off and retry: ${err.message}`);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("ANTHROPIC_API_KEY is invalid");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Anthropic API ${err.status}: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Convenience: enumerate every unordered pair of markets in a group and infer
 * dependencies for each. Returns a flat list of DependencyConstraints + per-pair
 * raw results (for audit).
 */
export async function inferDependenciesForGroup(markets: MarketForInference[]): Promise<{
  constraints: DependencyConstraint[];
  perPair: Array<{ a: string; b: string; result: InferenceResult | null }>;
}> {
  const out: DependencyConstraint[] = [];
  const perPair: Array<{ a: string; b: string; result: InferenceResult | null }> = [];
  for (let i = 0; i < markets.length; i++) {
    for (let j = i + 1; j < markets.length; j++) {
      const r = await inferDependenciesForPair(markets[i], markets[j]);
      perPair.push({ a: markets[i].marketId, b: markets[j].marketId, result: r });
      if (r) out.push(...r.constraints);
    }
  }
  return { constraints: out, perPair };
}
