import { describe, expect, it } from "vitest";
import { resolveHandleToAddress } from "@/lib/wallets/resolve-handle";

const FAKE_HTML = `
  <html><body>
  <script>
    {"profile":{"address":"0xabcdef0123456789abcdef0123456789abcdef01"}}
    {"counterparty":"0x1111111111111111111111111111111111111111"}
    {"counterparty":"0x2222222222222222222222222222222222222222"}
    profile-ref: 0xabcdef0123456789abcdef0123456789abcdef01
    profile-ref: 0xabcdef0123456789abcdef0123456789abcdef01
    profile-ref: 0xabcdef0123456789abcdef0123456789abcdef01
    profile-ref: 0xabcdef0123456789abcdef0123456789abcdef01
  </script>
  </body></html>
`;

function mockFetch(html: string, ok = true) {
  return async (_url: string) => ({
    ok,
    text: async () => html,
  });
}

describe("resolveHandleToAddress", () => {
  it("returns the most-frequent 40-char address in the page HTML", async () => {
    const addr = await resolveHandleToAddress("@bonereaper", { fetchFn: mockFetch(FAKE_HTML) });
    expect(addr).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("accepts a full URL", async () => {
    const addr = await resolveHandleToAddress("https://polymarket.com/@xyz", {
      fetchFn: mockFetch(FAKE_HTML),
    });
    expect(addr).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("accepts a URL with query string + http (not https)", async () => {
    const addr = await resolveHandleToAddress("http://polymarket.com/@xyz?tab=activity", {
      fetchFn: mockFetch(FAKE_HTML),
    });
    expect(addr).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("returns a full address as-is (lowercased) without fetching", async () => {
    let fetched = false;
    const addr = await resolveHandleToAddress("0xAbCdEf0123456789abcdef0123456789abcdef01", {
      fetchFn: async () => {
        fetched = true;
        return { ok: true, text: async () => "" };
      },
    });
    expect(addr).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(fetched).toBe(false);
  });

  it("handles a 39-char truncated address by resolving it via the handle endpoint", async () => {
    // The 39-char string is not a valid address, so we hit polymarket — which
    // returns a page with the full 40-char canonical address.
    const truncated = "0xabcdef0123456789abcdef0123456789abcdef0"; // 39 chars
    const addr = await resolveHandleToAddress(truncated, { fetchFn: mockFetch(FAKE_HTML) });
    expect(addr).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
  });

  it("strips leading @ and trailing slash from handles", async () => {
    let receivedUrl = "";
    const addr = await resolveHandleToAddress("@bonereaper/", {
      fetchFn: async (url: string) => {
        receivedUrl = url;
        return { ok: true, text: async () => FAKE_HTML };
      },
    });
    expect(addr).toBe("0xabcdef0123456789abcdef0123456789abcdef01");
    expect(receivedUrl).toBe("https://polymarket.com/@bonereaper");
  });

  it("throws when the fetch returns non-OK", async () => {
    await expect(
      resolveHandleToAddress("@doesnotexist", { fetchFn: mockFetch("", false) }),
    ).rejects.toThrow(/non-OK/);
  });

  it("throws when no addresses found in the HTML", async () => {
    await expect(
      resolveHandleToAddress("@empty", { fetchFn: mockFetch("<html>no addresses here</html>") }),
    ).rejects.toThrow(/no 40-char addresses found/);
  });

  it("picks the right address when multiple appear similar counts (tie-broken by first seen)", async () => {
    const html = `
      0x1111111111111111111111111111111111111111
      0x2222222222222222222222222222222222222222
      0x1111111111111111111111111111111111111111
    `;
    const addr = await resolveHandleToAddress("@tie", { fetchFn: mockFetch(html) });
    expect(addr).toBe("0x1111111111111111111111111111111111111111");
  });
});
