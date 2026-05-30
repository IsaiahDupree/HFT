/**
 * Tests for the dedup + upsert logic inside `scripts/scan-leaderboard.ts`.
 *
 * Re-implements just the SQL-level effect using the same statements so we
 * verify behavior without spawning the full Polymarket API workflow:
 *   1. New handle → INSERT
 *   2. Existing handle → UPDATE that bumps claimed_profit_usd (MAX semantics)
 *      and fills strategy_label/note only when previously NULL
 *   3. Mixed-case handle is folded to lowercase so the dedup is symmetric
 *   4. proxy_wallet acts as a secondary dedup key
 *
 * Drives the same statements the production script uses against an in-memory
 * SQLite via `tests/helpers/db.ts`.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { makeMemoryDb } from "../helpers/db";
import type Database from "better-sqlite3";

type Candidate = {
  userName: string | null;
  proxyWallet: string;
  appearances: Set<string>;
  bestPnl: number;
  bestVol: number;
};

function upsert(db: Database.Database, c: Candidate): { inserted: boolean; updated: boolean } {
  const handleKey = (c.userName ?? c.proxyWallet).toLowerCase();
  const note = `auto-added by scan-leaderboard: appearances=${[...c.appearances].join(",")}, bestPnl=$${Math.round(c.bestPnl).toLocaleString()}, bestVol=$${Math.round(c.bestVol).toLocaleString()}`;
  const strategyLabel = `auto-leaderboard ${[...c.appearances].sort().join("+")}`;

  const existingHandles = new Set(
    (db.prepare("SELECT handle FROM tracked_wallets").all() as Array<{ handle: string }>).map((r) => r.handle.toLowerCase()),
  );
  const existingWallets = new Set(
    (db.prepare("SELECT proxy_wallet FROM tracked_wallets WHERE proxy_wallet IS NOT NULL").all() as Array<{ proxy_wallet: string }>)
      .map((r) => r.proxy_wallet.toLowerCase()),
  );

  if (existingHandles.has(handleKey) || existingWallets.has(c.proxyWallet.toLowerCase())) {
    db.prepare(
      `UPDATE tracked_wallets
          SET proxy_wallet = COALESCE(proxy_wallet, ?),
              claimed_profit_usd = MAX(COALESCE(claimed_profit_usd, 0), ?),
              strategy_label = COALESCE(strategy_label, ?),
              note = COALESCE(note, ?),
              last_resolved = datetime('now')
        WHERE handle = ? OR proxy_wallet = ?`,
    ).run(c.proxyWallet, c.bestPnl, strategyLabel, note, handleKey, c.proxyWallet);
    return { inserted: false, updated: true };
  }
  db.prepare(
    `INSERT INTO tracked_wallets (handle, proxy_wallet, note, claimed_profit_usd, strategy_label, last_resolved)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(handleKey, c.proxyWallet, note, c.bestPnl, strategyLabel);
  return { inserted: true, updated: false };
}

function makeCandidate(over: Partial<Candidate> & { userName?: string | null; proxyWallet: string }): Candidate {
  return {
    userName: over.userName ?? "alice",
    proxyWallet: over.proxyWallet,
    appearances: over.appearances ?? new Set(["DAY_OVERALL"]),
    bestPnl: over.bestPnl ?? 50_000,
    bestVol: over.bestVol ?? 1_000_000,
  };
}

describe("scan-leaderboard upsert + dedup logic", () => {
  let db: Database.Database;
  beforeEach(() => { db = makeMemoryDb(); });

  it("inserts a brand new handle as one row", () => {
    const r = upsert(db, makeCandidate({ userName: "alice", proxyWallet: "0xaaa1111111111111111111111111111111111111" }));
    expect(r).toEqual({ inserted: true, updated: false });
    const rows = db.prepare("SELECT handle, proxy_wallet, claimed_profit_usd, strategy_label FROM tracked_wallets").all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).handle).toBe("alice");
    expect((rows[0] as any).claimed_profit_usd).toBe(50_000);
  });

  it("re-running on the same handle updates instead of inserting (no duplicates)", () => {
    upsert(db, makeCandidate({ userName: "alice", proxyWallet: "0xaaa1111111111111111111111111111111111111" }));
    const r = upsert(db, makeCandidate({ userName: "alice", proxyWallet: "0xaaa1111111111111111111111111111111111111", bestPnl: 120_000 }));
    expect(r).toEqual({ inserted: false, updated: true });
    const rows = db.prepare("SELECT handle, claimed_profit_usd FROM tracked_wallets").all();
    expect(rows).toHaveLength(1);
    // MAX semantics — claimed_profit_usd should bump up to the higher value
    expect((rows[0] as any).claimed_profit_usd).toBe(120_000);
  });

  it("MAX semantics: a smaller subsequent claimed_profit does NOT downgrade the existing value", () => {
    upsert(db, makeCandidate({ userName: "bob", proxyWallet: "0xbbb1111111111111111111111111111111111111", bestPnl: 500_000 }));
    upsert(db, makeCandidate({ userName: "bob", proxyWallet: "0xbbb1111111111111111111111111111111111111", bestPnl: 100_000 }));
    const row = db.prepare("SELECT claimed_profit_usd FROM tracked_wallets WHERE handle='bob'").get() as { claimed_profit_usd: number };
    expect(row.claimed_profit_usd).toBe(500_000);
  });

  it("mixed-case handle dedups to the same row (lowercase folding)", () => {
    upsert(db, makeCandidate({ userName: "Alice", proxyWallet: "0xaaa2222222222222222222222222222222222222" }));
    const r = upsert(db, makeCandidate({ userName: "alice", proxyWallet: "0xaaa2222222222222222222222222222222222222", bestPnl: 200_000 }));
    expect(r.updated).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM tracked_wallets WHERE LOWER(handle)='alice'").get() as { c: number }).toEqual({ c: 1 });
  });

  it("proxy_wallet alone is enough to dedup — even when handle changes (user renamed themselves)", () => {
    upsert(db, makeCandidate({ userName: "OldName", proxyWallet: "0xddd3333333333333333333333333333333333333" }));
    const r = upsert(db, makeCandidate({ userName: "NewName", proxyWallet: "0xddd3333333333333333333333333333333333333", bestPnl: 800_000 }));
    expect(r.updated).toBe(true);
    // Total row count should still be 1 (no duplicate created on rename)
    expect(db.prepare("SELECT COUNT(*) c FROM tracked_wallets").get() as { c: number }).toEqual({ c: 1 });
    // claimed_profit_usd should reflect the larger value
    const row = db.prepare("SELECT claimed_profit_usd FROM tracked_wallets").get() as { claimed_profit_usd: number };
    expect(row.claimed_profit_usd).toBe(800_000);
  });

  it("strategy_label is preserved if previously set (COALESCE semantics)", () => {
    db.prepare("INSERT INTO tracked_wallets (handle, proxy_wallet, strategy_label) VALUES (?, ?, ?)")
      .run("alice", "0xaaa4444444444444444444444444444444444444", "manually-set crypto specialist");
    upsert(db, makeCandidate({ userName: "alice", proxyWallet: "0xaaa4444444444444444444444444444444444444" }));
    const row = db.prepare("SELECT strategy_label FROM tracked_wallets WHERE handle='alice'").get() as { strategy_label: string };
    expect(row.strategy_label).toBe("manually-set crypto specialist");
  });

  it("appearances set composes into the strategy_label deterministically (sorted)", () => {
    // Two appearances in shuffled order — label should be deterministic and sorted.
    const c1 = makeCandidate({
      userName: "alice", proxyWallet: "0xaaa5555555555555555555555555555555555555",
      appearances: new Set(["WEEK_CRYPTO", "DAY_OVERALL"]),
    });
    upsert(db, c1);
    const row = db.prepare("SELECT strategy_label FROM tracked_wallets WHERE handle='alice'").get() as { strategy_label: string };
    expect(row.strategy_label).toBe("auto-leaderboard DAY_OVERALL+WEEK_CRYPTO");
  });

  it("note field is set on insert and NOT overwritten on update (COALESCE semantics)", () => {
    upsert(db, makeCandidate({
      userName: "alice", proxyWallet: "0xaaa6666666666666666666666666666666666666",
      appearances: new Set(["DAY_OVERALL"]),
    }));
    const firstNote = (db.prepare("SELECT note FROM tracked_wallets WHERE handle='alice'").get() as { note: string }).note;
    expect(firstNote).toMatch(/appearances=DAY_OVERALL/);

    upsert(db, makeCandidate({
      userName: "alice", proxyWallet: "0xaaa6666666666666666666666666666666666666",
      appearances: new Set(["WEEK_OVERALL", "MONTH_OVERALL"]), bestPnl: 999_000,
    }));
    const secondNote = (db.prepare("SELECT note FROM tracked_wallets WHERE handle='alice'").get() as { note: string }).note;
    // Original DAY_OVERALL note survives because COALESCE rejects overwriting non-null values.
    expect(secondNote).toBe(firstNote);
  });
});
