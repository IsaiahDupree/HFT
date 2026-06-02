import { describe, it, expect } from "vitest";
import { detectEdgeDecay } from "@/lib/decision/edge-decay";

describe("detectEdgeDecay — Page-Hinkley + CUSUM change-point", () => {
  it("detects a downward shift near the change-point", () => {
    const x = [...Array(15).fill(0.02), ...Array(15).fill(-0.02)]; // edge breaks at index 15
    const r = detectEdgeDecay(x, { lambda: 0.05 });
    expect(r.decaying).toBe(true);
    expect(r.changePointIndex).toBeGreaterThanOrEqual(15);
    expect(r.changePointIndex).toBeLessThan(25);
    expect(r.cusumDown).toBeGreaterThan(0);
  });

  it("a steady positive edge is NOT flagged (detects change, not level)", () => {
    const r = detectEdgeDecay(Array.from({ length: 30 }, (_, i) => 0.01 + (i % 2 ? 0.002 : -0.002)), { lambda: 0.05 });
    expect(r.decaying).toBe(false);
  });

  it("a gradual decay (winners shrinking) is caught", () => {
    const x = Array.from({ length: 40 }, (_, i) => 0.03 - i * 0.0015); // drifts from +0.03 to −0.03
    const r = detectEdgeDecay(x, { lambda: 0.05 });
    expect(r.decaying).toBe(true);
  });

  it("below minN → not decaying (insufficient data)", () => {
    expect(detectEdgeDecay([0.02, -0.02, 0.01], {}).decaying).toBe(false);
  });
});
