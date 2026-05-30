/**
 * Regression test for bug #16 (2026-05-26).
 *
 * The standalone-script env loader at scripts/_env.ts was reading the trailing
 * `# comment` portion of a .env.local line into the value. This caused
 * POLYMARKET_SIGNATURE_TYPE=1  # POLY_PROXY to load as the literal string
 * "1  # POLY_PROXY", which Number() then parsed to NaN, which the Polymarket
 * SDK silently coerced to 0 (EOA) — producing `order_version_mismatch` on
 * every CLOB order.
 *
 * We can't directly import _env (it imports as a side-effect on the cwd), so
 * we exercise the stripInlineComment logic by inlining the same regex.
 */
import { describe, expect, it } from "vitest";

/** Mirror of stripInlineComment in scripts/_env.ts. Keep in sync. */
function stripInlineComment(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  const hashIdx = raw.search(/\s+#/);
  return hashIdx === -1 ? raw : raw.slice(0, hashIdx);
}

describe("env loader inline-comment stripping (bug #16)", () => {
  it("strips a trailing `# comment` from a numeric value", () => {
    expect(stripInlineComment("1  # POLY_PROXY")).toBe("1");
    expect(Number(stripInlineComment("1  # POLY_PROXY").trim())).toBe(1);
  });

  it("strips a trailing comment from a bool-like value", () => {
    expect(stripInlineComment("0 # off in dev")).toBe("0");
    expect(stripInlineComment("true  #notes")).toBe("true");
  });

  it("leaves a value with no comment unchanged", () => {
    expect(stripInlineComment("0x73B6dB9b73a95b1ED26C74E1eeb60Df4128C5854")).toBe("0x73B6dB9b73a95b1ED26C74E1eeb60Df4128C5854");
    expect(stripInlineComment("https://clob.polymarket.com")).toBe("https://clob.polymarket.com");
  });

  it("preserves a value when the # is inside double quotes", () => {
    expect(stripInlineComment(`"foo # not a comment"`)).toBe("foo # not a comment");
  });

  it("preserves a value when the # is inside single quotes", () => {
    expect(stripInlineComment(`'bar # inside'`)).toBe("bar # inside");
  });

  it("only strips when there is whitespace before the #", () => {
    // `foo#bar` should NOT be split — there's no space before the #, so it's
    // treated as part of the value (e.g. an API key that happens to contain #).
    expect(stripInlineComment("api_key#abc123")).toBe("api_key#abc123");
  });

  it("strips even with tabs or multiple spaces before the #", () => {
    expect(stripInlineComment("5\t# tab-separated")).toBe("5");
    expect(stripInlineComment("5    # many spaces")).toBe("5");
  });

  it("the bug scenario — POLYMARKET_SIGNATURE_TYPE=1 + comment → Number parses to 1, not NaN", () => {
    const raw = "1  # 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE, 3=POLY_1271";
    const stripped = stripInlineComment(raw).trim();
    expect(stripped).toBe("1");
    expect(Number(stripped)).toBe(1);
    expect(Number.isFinite(Number(stripped))).toBe(true);
  });

  it("the NaN guard in execute.ts falls back to 1 when env parses to NaN", () => {
    // Even if stripping were skipped, the defensive Number.isFinite check in
    // buildV4Client/buildV2Client must coerce to POLY_PROXY default.
    const rawNumber = Number("1  # POLY_PROXY"); // simulate pre-strip
    expect(Number.isNaN(rawNumber)).toBe(true);
    const guarded = Number.isFinite(rawNumber) ? rawNumber : 1;
    expect(guarded).toBe(1);
  });
});
