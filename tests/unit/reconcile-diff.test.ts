import { describe, expect, it } from "vitest";
import { diffOrders } from "@/lib/reconcile/diff";

describe("reconcile diff", () => {
  it("returns no drift when local and remote agree", () => {
    const r = diffOrders(
      [{ brokerOrderId: "o1", status: "OPEN" }],
      [{ brokerOrderId: "o1", status: "OPEN" }],
    );
    expect(r).toEqual([]);
  });

  it("flags status_changed when local says OPEN but remote says FILLED", () => {
    const r = diffOrders(
      [{ brokerOrderId: "o1", status: "OPEN" }],
      [{ brokerOrderId: "o1", status: "FILLED" }],
    );
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("status_changed");
  });

  it("flags missing_remotely when we still think it's OPEN but venue lost it", () => {
    const r = diffOrders([{ brokerOrderId: "o1", status: "OPEN" }], []);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("missing_remotely");
  });

  it("does not flag missing_remotely when local is already terminal", () => {
    const r = diffOrders([{ brokerOrderId: "o1", status: "FILLED" }], []);
    expect(r).toEqual([]);
  });

  it("flags missing_locally for unknown remote orders", () => {
    const r = diffOrders([], [{ brokerOrderId: "o2", status: "OPEN" }]);
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("missing_locally");
  });

  it("flags fill_size_changed when statuses match but filled_size diverged", () => {
    const r = diffOrders(
      [{ brokerOrderId: "o1", status: "PARTIALLY_FILLED", filledSize: 1.0 }],
      [{ brokerOrderId: "o1", status: "PARTIALLY_FILLED", filledSize: 1.5 }],
    );
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("fill_size_changed");
  });

  it("flags price_changed when avg price diverged within same status + qty", () => {
    const r = diffOrders(
      [{ brokerOrderId: "o1", status: "FILLED", filledSize: 1.0, averagePrice: 100 }],
      [{ brokerOrderId: "o1", status: "FILLED", filledSize: 1.0, averagePrice: 101.5 }],
    );
    expect(r).toHaveLength(1);
    expect(r[0].kind).toBe("price_changed");
  });

  it("handles mixed drift across many orders", () => {
    const local = [
      { brokerOrderId: "a", status: "OPEN" },
      { brokerOrderId: "b", status: "OPEN" },
      { brokerOrderId: "c", status: "FILLED" },
    ];
    const remote = [
      { brokerOrderId: "a", status: "OPEN" },                // ok
      { brokerOrderId: "b", status: "CANCELLED" },           // status_changed
      { brokerOrderId: "d", status: "OPEN" },                // missing_locally
    ];
    const drifts = diffOrders(local, remote);
    const kinds = drifts.map((d) => `${d.brokerOrderId}:${d.kind}`).sort();
    expect(kinds).toEqual(["b:status_changed", "d:missing_locally"]);
  });
});
