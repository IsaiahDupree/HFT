/**
 * llm-regime — the LIVE "Loop B" judgment for the carry book. Given each sleeve's current regime
 * features (expected carry, recent risk-z, funding/basis stability), an LLM outputs a size
 * multiplier [0,1.5] + a one-line rationale per sleeve — the discriminating "cut this one despite
 * low vol because X" call a fixed rule can't make. It is NOT magic: it falls back to the
 * deterministic feature-proxy when auth is unavailable, and every AI size is logged ALONGSIDE the
 * proxy so the §7.6 falsification ("does the AI-sized book beat proxy / fixed / shuffled?") runs on
 * the accumulating paper track — asserted by nobody, measured forward. The pure parts (proxy +
 * parse/clamp) are tested; the live call is best-effort.
 */
import { regimeGateSize } from "./regime-size";
import { authIsAvailable, getOAuthClient } from "@/lib/anthropic/auth";

const MODEL = "claude-haiku-4-5";

export type SleeveFeature = {
  name: string;
  kind: "calendar" | "funding";
  expectedDailyBp: number;   // the structural carry on offer
  riskZ: number;             // how far the current signal is from its recent norm (spike = stress/squeeze)
  stability: number;         // 0..1, sign-consistency of the recent signal (1 = rock steady)
  note?: string;
};

export type RegimeSize = { name: string; size: number; rationale: string; source: "llm" | "proxy" };

/** Deterministic baseline — cut into danger (high riskZ), reuse the gate. The fallback + §7.6 control. */
export function featureProxySize(f: SleeveFeature): number {
  const base = regimeGateSize([f.riskZ], { cutZ: 1, band: 1.5, floor: 0.3, full: 1 })[0];
  // a steadier signal earns a touch more; clamp to [0, 1.5]
  return Math.max(0, Math.min(1.5, base * (0.8 + 0.4 * Math.max(0, Math.min(1, f.stability)))));
}

const clamp = (x: number) => Math.max(0, Math.min(1.5, Number.isFinite(x) ? x : 0));

/** Parse the LLM JSON; clamp sizes to [0,1.5]; fall back to the proxy for any missing/garbled sleeve. */
export function parseLlmSizes(text: string, features: readonly SleeveFeature[]): RegimeSize[] {
  let obj: { sizes?: Array<{ name?: string; size?: number; rationale?: string }> } = {};
  try { obj = JSON.parse(text); } catch { /* fall through → all proxy */ }
  const byName = new Map((obj.sizes ?? []).map((s) => [String(s.name), s]));
  return features.map((f) => {
    const s = byName.get(f.name);
    if (s && Number.isFinite(s.size)) return { name: f.name, size: clamp(s.size as number), rationale: String(s.rationale ?? "").slice(0, 200), source: "llm" as const };
    return { name: f.name, size: featureProxySize(f), rationale: "proxy fallback", source: "proxy" as const };
  });
}

const SYSTEM = `You are the regime/risk layer ("Loop B") of a delta-neutral CARRY book. Loop A already found the edge (funding carry on alts, calendar basis on BTC/ETH). Your ONLY job: output a size multiplier in [0,1.5] per sleeve and one terse rationale. Cut size (toward 0.3 or below) when a sleeve looks dangerous — a funding/basis SPIKE vs its norm (high riskZ), unstable sign, squeeze/blowout risk — even if the expected carry is fat. Keep ~1.0 when calm and the carry is real; only go above 1.0 when the carry is fat AND the regime is unusually clean (steady sign, low riskZ). You do NOT predict price direction. Be skeptical: a fat carry in a stressed regime is a trap, not a gift. Output strictly the JSON schema.`;

const SCHEMA = {
  type: "object", additionalProperties: false,
  properties: { sizes: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, size: { type: "number" }, rationale: { type: "string" } }, required: ["name", "size", "rationale"] } } },
  required: ["sizes"],
};

/** Is the live LLM path usable right now? */
export function llmRegimeAvailable(): boolean { return authIsAvailable(); }

/** Live regime sizing. Tries the LLM; on any failure returns the deterministic proxy for every sleeve. */
export async function llmRegimeSizes(features: readonly SleeveFeature[]): Promise<{ sizes: RegimeSize[]; usedLlm: boolean }> {
  const proxy = () => ({ sizes: features.map((f) => ({ name: f.name, size: featureProxySize(f), rationale: "proxy (no LLM)", source: "proxy" as const })), usedLlm: false });
  if (!authIsAvailable()) return proxy();
  try {
    const c = await getOAuthClient();
    const resp = await c.messages.create({
      model: MODEL, max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM }],
      messages: [{ role: "user", content: `Size each sleeve. Features:\n${JSON.stringify(features, null, 1)}` }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } as any },
    } as any);
    const block = (resp.content as Array<{ type: string; text?: string }>).find((b) => b.type === "text");
    if (!block?.text) return proxy();
    return { sizes: parseLlmSizes(block.text, features), usedLlm: true };
  } catch (e) {
    console.warn(`[llm-regime] LLM unavailable, using proxy: ${(e as Error).message.slice(0, 80)}`);
    return proxy();
  }
}
