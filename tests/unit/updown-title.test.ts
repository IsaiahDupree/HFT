/**
 * Tests for the Up/Down title duration parser. Regression suite for the 5-min
 * series strike bug (2026-06-11): a fixed-duration assumption derived strikes
 * from the wrong candle across an entire night of G2 paper sessions.
 */
import { describe, it, expect } from "vitest";
import { rangeDurationMinutes } from "@/lib/strategies/updown-title";

describe("rangeDurationMinutes", () => {
  it("parses the 5-minute series (the bug that started this file)", () => {
    expect(rangeDurationMinutes("Bitcoin Up or Down - June 10, 11:30PM-11:35PM ET")).toBe(5);
    expect(rangeDurationMinutes("Ethereum Up or Down - June 11, 1:05AM-1:10AM ET")).toBe(5);
  });

  it("parses the 15-minute series", () => {
    expect(rangeDurationMinutes("Bitcoin Up or Down - June 10, 11:15PM-11:30PM ET")).toBe(15);
    expect(rangeDurationMinutes("Bitcoin Up or Down - June 10, 11:45PM-12:00AM ET")).toBe(15);
  });

  it("parses the hourly series (no range)", () => {
    expect(rangeDurationMinutes("Bitcoin Up or Down - June 10, 11PM ET")).toBe(60);
    expect(rangeDurationMinutes("Ethereum Up or Down - June 11, 9AM ET")).toBe(60);
  });

  it("handles the midnight wrap", () => {
    expect(rangeDurationMinutes("Bitcoin Up or Down - June 10, 11:55PM-12:00AM ET")).toBe(5);
  });

  it("range start inherits the end's AM/PM when omitted", () => {
    expect(rangeDurationMinutes("Bitcoin Up or Down - June 10, 11:15-11:30PM ET")).toBe(15);
  });

  it("crosses noon correctly", () => {
    expect(rangeDurationMinutes("Bitcoin Up or Down - June 10, 11:55AM-12:00PM ET")).toBe(5);
  });

  it("returns null on unmatchable titles (never guess a strike)", () => {
    expect(rangeDurationMinutes("Will BTC be above $62,000 on June 11?")).toBeNull();
    expect(rangeDurationMinutes("Bitcoin Up or Down")).toBeNull();
    expect(rangeDurationMinutes("")).toBeNull();
  });
});
