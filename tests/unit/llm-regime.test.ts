import { describe, it, expect } from "vitest";
import { featureProxySize, parseLlmSizes, type SleeveFeature } from "@/lib/backtest/llm-regime";

const f = (name: string, riskZ: number, stability = 1): SleeveFeature => ({ name, kind: "funding", expectedDailyBp: 10, riskZ, stability });

describe("featureProxySize — deterministic fallback", () => {
  it("full-ish size in a calm regime (low riskZ, steady)", () => {
    const s = featureProxySize(f("a", 0, 1));
    expect(s).toBeGreaterThan(1.0); // calm + steady → ≥ full
    expect(s).toBeLessThanOrEqual(1.5);
  });
  it("cuts size into danger (high riskZ)", () => {
    expect(featureProxySize(f("a", 3, 1))).toBeLessThan(featureProxySize(f("a", 0, 1)));
  });
  it("an unstable signal gets less than a steady one at the same risk", () => {
    expect(featureProxySize(f("a", 0, 0.2))).toBeLessThan(featureProxySize(f("a", 0, 1)));
  });
  it("is clamped to [0, 1.5]", () => {
    const hi = featureProxySize(f("a", -5, 1)), lo = featureProxySize(f("a", 10, 0));
    expect(hi).toBeLessThanOrEqual(1.5);
    expect(lo).toBeGreaterThanOrEqual(0);
  });
});

describe("parseLlmSizes", () => {
  const feats = [f("cal-BTC", 0), f("fund-LAB", 2)];
  it("parses LLM sizes, clamps to [0,1.5], keeps the rationale", () => {
    const out = parseLlmSizes(JSON.stringify({ sizes: [{ name: "cal-BTC", size: 1.2, rationale: "calm contango" }, { name: "fund-LAB", size: 5, rationale: "fat but spiking" }] }), feats);
    expect(out[0]).toMatchObject({ name: "cal-BTC", size: 1.2, source: "llm" });
    expect(out[1].size).toBe(1.5); // clamped from 5
  });
  it("falls back to the proxy for a sleeve the LLM omitted", () => {
    const out = parseLlmSizes(JSON.stringify({ sizes: [{ name: "cal-BTC", size: 1.0, rationale: "ok" }] }), feats);
    expect(out[1].source).toBe("proxy");
    expect(out[1].size).toBeCloseTo(featureProxySize(feats[1]), 9);
  });
  it("garbled JSON → all proxy (never throws)", () => {
    const out = parseLlmSizes("not json at all", feats);
    expect(out.every((x) => x.source === "proxy")).toBe(true);
    expect(out).toHaveLength(2);
  });
  it("a non-finite LLM size → proxy for that sleeve", () => {
    const out = parseLlmSizes(JSON.stringify({ sizes: [{ name: "cal-BTC", size: null, rationale: "x" }] }), feats);
    expect(out[0].source).toBe("proxy");
  });
});
