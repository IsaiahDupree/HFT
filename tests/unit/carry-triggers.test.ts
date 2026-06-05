import { describe, it, expect } from "vitest";
import { triggerState, isEscalation, FUNDING_TRIGGER, CALENDAR_TRIGGER } from "@/lib/exec/carry-triggers";

describe("triggerState", () => {
  it("ARMED only when gross ≥ arm AND executable", () => {
    expect(triggerState(20, true, FUNDING_TRIGGER).state).toBe("armed");
    expect(triggerState(16, true, FUNDING_TRIGGER).state).toBe("armed"); // inclusive at the arm bar
  });

  it("fat but NOT executable → watch, never armed (a real hedge is required to deploy)", () => {
    const t = triggerState(41, false, FUNDING_TRIGGER);
    expect(t.state).toBe("watch");
    expect(t.reason).toMatch(/not executable/i);
  });

  it("THE FLOOR BUG: Hyperliquid's +11% funding floor must stay OFF (watch bar sits above it at 13%)", () => {
    expect(triggerState(11, false, FUNDING_TRIGGER).state).toBe("off");
    expect(triggerState(10.95, true, FUNDING_TRIGGER).state).toBe("off"); // even executable, the floor is not a signal
  });

  it("watch band: gross in [watch, arm) → watch", () => {
    expect(triggerState(13, false, FUNDING_TRIGGER).state).toBe("watch"); // inclusive at watch bar
    expect(triggerState(14.9, true, FUNDING_TRIGGER).state).toBe("watch");
  });

  it("uses |gross| so negative funding (fat short-pays) is judged on magnitude", () => {
    expect(triggerState(-41, false, FUNDING_TRIGGER).state).toBe("watch");
    expect(triggerState(-20, true, FUNDING_TRIGGER).state).toBe("armed");
  });

  it("calendar thresholds: arm 9.5% (RF+spread), watch 6.3% (RF parity), below = off", () => {
    expect(triggerState(9.5, true, CALENDAR_TRIGGER).state).toBe("armed");
    expect(triggerState(6.3, true, CALENDAR_TRIGGER).state).toBe("watch");
    expect(triggerState(3.6, true, CALENDAR_TRIGGER).state).toBe("off"); // today's compressed basis
  });
});

describe("isEscalation", () => {
  it("first sighting (prev null) alerts only at watch+ , not off", () => {
    expect(isEscalation(null, "off")).toBe(false);
    expect(isEscalation(null, "watch")).toBe(true);
    expect(isEscalation(null, "armed")).toBe(true);
  });
  it("only a RANK INCREASE escalates", () => {
    expect(isEscalation("off", "watch")).toBe(true);
    expect(isEscalation("watch", "armed")).toBe(true);
    expect(isEscalation("off", "armed")).toBe(true);
  });
  it("de-escalation and no-change do NOT alert (no spam when a carry cools or holds)", () => {
    expect(isEscalation("armed", "watch")).toBe(false);
    expect(isEscalation("watch", "off")).toBe(false);
    expect(isEscalation("watch", "watch")).toBe(false);
    expect(isEscalation("armed", "armed")).toBe(false);
  });
});
