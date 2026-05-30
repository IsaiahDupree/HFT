import "./_env";
import { callOracle } from "../src/lib/arena/llm-oracle";

(async () => {
  const r = await callOracle({
    marketId: "test-" + Date.now(),
    question: "Will BTC close above $100,000 by 2026-12-31?",
    marketImpliedProb: 0.55,
    category: "crypto",
    model: "claude-haiku-4-5-20251001",
    promptVersion: "v1",
    cacheTtlMin: 60,
  });
  console.log("oracle result:", JSON.stringify(r, null, 2));
})();
