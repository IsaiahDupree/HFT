import { describe, it, expect, beforeEach } from "vitest";
import { openCarryDb, insertSnapshot, insertAlert, lastStateFor, recentAlerts, snapshotCount, resolveCarryDbPath, type CarryDb, type SnapshotRow } from "@/lib/exec/carry-monitor-db";

const snap = (over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  ts: 1000, iso: "2026-06-05T00:00:00.000Z", strategy: "funding", venue: "hyperliquid", candidate: "HYPE",
  grossApr: 11, netApr: 8.3, persistence: 0.85, basisBps: 11, depthUsd: 336_000, executable: false, state: "off", reason: "thin", raw: { a: 1 }, ...over,
});

describe("carry-monitor-db (in-memory SQLite)", () => {
  let db: CarryDb;
  beforeEach(() => { db = openCarryDb(":memory:"); });

  it("creates schema and round-trips a snapshot (raw serialized to JSON, executable to 0/1)", () => {
    expect(snapshotCount(db)).toBe(0);
    insertSnapshot(db, snap({ executable: true, raw: { blockers: [] } }));
    expect(snapshotCount(db)).toBe(1);
    const row = db.prepare("SELECT * FROM carry_snapshots LIMIT 1").get() as any;
    expect(row.candidate).toBe("HYPE");
    expect(row.executable).toBe(1);
    expect(JSON.parse(row.raw)).toEqual({ blockers: [] });
  });

  it("lastStateFor returns the MOST RECENT state per candidate, null if unseen", () => {
    expect(lastStateFor(db, "funding", "HYPE")).toBeNull();
    insertSnapshot(db, snap({ ts: 100, state: "off" }));
    insertSnapshot(db, snap({ ts: 200, state: "watch" }));
    insertSnapshot(db, snap({ ts: 150, state: "armed" }));   // older than 200 → ignored
    expect(lastStateFor(db, "funding", "HYPE")).toBe("watch");
    expect(lastStateFor(db, "calendar", "BTC-25SEP26")).toBeNull(); // different candidate
  });

  it("separates state by (strategy, candidate)", () => {
    insertSnapshot(db, snap({ strategy: "funding", candidate: "ETH", state: "off" }));
    insertSnapshot(db, snap({ strategy: "calendar", candidate: "ETH", state: "watch" }));
    expect(lastStateFor(db, "funding", "ETH")).toBe("off");
    expect(lastStateFor(db, "calendar", "ETH")).toBe("watch");
  });

  it("records and reads back escalation alerts, newest first", () => {
    insertAlert(db, { ts: 100, iso: "i1", strategy: "funding", candidate: "STABLE", prevState: null, newState: "watch", grossApr: -41, netApr: 38, message: "fat but not executable" });
    insertAlert(db, { ts: 200, iso: "i2", strategy: "funding", candidate: "HYPE", prevState: "watch", newState: "armed", grossApr: 18, netApr: 15, message: "deploy candidate" });
    const a = recentAlerts(db, 10);
    expect(a).toHaveLength(2);
    expect(a[0].candidate).toBe("HYPE");       // newest first
    expect(a[0].newState).toBe("armed");
    expect(a[1].prevState).toBeNull();
  });
});

describe("resolveCarryDbPath", () => {
  it("honors an explicit CARRY_DB_PATH env over the drive/fallback logic", () => {
    const prev = process.env.CARRY_DB_PATH;
    process.env.CARRY_DB_PATH = "/tmp/explicit-carry.db";
    expect(resolveCarryDbPath()).toBe("/tmp/explicit-carry.db");
    if (prev === undefined) delete process.env.CARRY_DB_PATH; else process.env.CARRY_DB_PATH = prev;
  });
});
