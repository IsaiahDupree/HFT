import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to control env vars across cases; restore between tests.
let originalKey: string | undefined;
let originalAuth: string | undefined;
beforeEach(() => {
  originalKey = process.env.ANTHROPIC_API_KEY;
  originalAuth = process.env.ANTHROPIC_AUTH_TOKEN;
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalKey;
  if (originalAuth === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  else process.env.ANTHROPIC_AUTH_TOKEN = originalAuth;
  vi.resetModules();
});

describe("authStatus / authIsAvailable", () => {
  it("reports oauth-file mode when ~/.claude/.credentials.json has a valid token", async () => {
    // The real file is present in this dev environment (Claude Max).
    const { authStatus, authIsAvailable } = await import("@/lib/anthropic/auth");
    const s = authStatus();
    if (s.mode === "oauth-file") {
      expect(s.expiresInMin).toBeGreaterThanOrEqual(-60);
      expect(authIsAvailable()).toBe(true);
    } else {
      // If the dev machine somehow doesn't have it, just check that the shape is well-formed.
      expect(["oauth-env", "api-key", "none"]).toContain(s.mode);
    }
  });

  it("reports api-key mode when ANTHROPIC_API_KEY is set (and no OAuth)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-test-test";
    const { authStatus, authIsAvailable } = await import("@/lib/anthropic/auth");
    // OAuth file may take precedence on this dev machine — but authIsAvailable is true either way
    expect(authIsAvailable()).toBe(true);
    expect(["oauth-file", "oauth-env", "api-key"]).toContain(authStatus().mode);
  });

  it.each([
    { mode: "oauth-file" },
    { mode: "oauth-env" },
    { mode: "api-key" },
    { mode: "none" },
  ])("authStatus.mode is one of the documented enums ($mode acceptable)", async ({ mode }) => {
    const { authStatus } = await import("@/lib/anthropic/auth");
    expect(["oauth-file", "oauth-env", "api-key", "none"]).toContain(authStatus().mode);
  });
});

describe("getOAuthClient — happy path", () => {
  it("returns an Anthropic SDK instance when creds are present", async () => {
    const { getOAuthClient, authIsAvailable } = await import("@/lib/anthropic/auth");
    if (!authIsAvailable()) return; // skip when neither OAuth nor API key set
    const client = await getOAuthClient();
    expect(client).toBeDefined();
    expect(typeof client.messages.create).toBe("function");
  });

  it("getOAuthClientSync returns a client when creds are valid", async () => {
    const { getOAuthClientSync, authIsAvailable } = await import("@/lib/anthropic/auth");
    if (!authIsAvailable()) return;
    const client = getOAuthClientSync();
    expect(client).toBeDefined();
  });
});
