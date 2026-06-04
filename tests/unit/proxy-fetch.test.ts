import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { proxiedHosts, willProxy, dataProxyStatus, DEFAULT_PROXIED_HOSTS, _resetDataProxyAgentForTests } from "@/lib/data/proxy-fetch";

// Save/restore ONLY the keys this file touches — never reassign process.env wholesale
// (that can race other test files that read env in the same worker).
const KEYS = ["DATA_PROXY_URL", "POLYMARKET_PROXY_URL", "DATA_PROXY_HOSTS"] as const;
const SAVE: Record<string, string | undefined> = {};
beforeEach(() => {
  _resetDataProxyAgentForTests();
  for (const k of KEYS) { SAVE[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) { if (SAVE[k] === undefined) delete process.env[k]; else process.env[k] = SAVE[k]; }
  _resetDataProxyAgentForTests();
});

describe("proxy-fetch host routing — properties", () => {
  it("DEFAULT_PROXIED_HOSTS covers Binance spot + futures", () => {
    expect(DEFAULT_PROXIED_HOSTS).toContain("api.binance.com");
    expect(DEFAULT_PROXIED_HOSTS).toContain("fapi.binance.com");
  });

  it("willProxy is false when no proxy URL is configured, even for an allow-listed host", () => {
    expect(willProxy("https://api.binance.com/api/v3/klines")).toBe(false);
  });

  it("willProxy is true for an allow-listed host once a proxy is configured", () => {
    process.env.POLYMARKET_PROXY_URL = "http://u:p@host:6462";
    expect(willProxy("https://api.binance.com/api/v3/klines?symbol=BTCUSDT")).toBe(true);
    expect(willProxy("https://fapi.binance.com/fapi/v1/fundingRate")).toBe(true);
  });

  it("never proxies a non-allow-listed host (Coinbase, the mirror, Anthropic)", () => {
    process.env.POLYMARKET_PROXY_URL = "http://u:p@host:6462";
    expect(willProxy("https://api.coinbase.com/v2/time")).toBe(false);
    expect(willProxy("https://data-api.binance.vision/api/v3/klines")).toBe(false);
    expect(willProxy("https://api.anthropic.com/v1/messages")).toBe(false);
  });

  it("matches subdomains of an allow-listed host but not look-alikes", () => {
    process.env.POLYMARKET_PROXY_URL = "http://u:p@host:6462";
    expect(willProxy("https://stream.fapi.binance.com/ws")).toBe(true);     // subdomain ✓
    expect(willProxy("https://api.binance.com.evil.test/x")).toBe(false);   // suffix attack ✗
  });

  it("DATA_PROXY_URL takes precedence and a custom DATA_PROXY_HOSTS overrides the default list", () => {
    process.env.DATA_PROXY_URL = "http://u:p@host:1";
    process.env.DATA_PROXY_HOSTS = "example.com, foo.test";
    expect(proxiedHosts()).toEqual(["example.com", "foo.test"]);
    expect(willProxy("https://example.com/x")).toBe(true);
    expect(willProxy("https://api.binance.com/x")).toBe(false); // no longer in the list
  });

  it("dataProxyStatus reflects enabled/host and is disabled without creds", () => {
    expect(dataProxyStatus().enabled).toBe(false);
    process.env.POLYMARKET_PROXY_URL = "http://u:p@1.2.3.4:6462";
    const st = dataProxyStatus();
    expect(st.enabled).toBe(true);
    expect(st.host).toBe("1.2.3.4:6462");
  });
});
