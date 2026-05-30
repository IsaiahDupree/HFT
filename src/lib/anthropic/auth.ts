/**
 * Anthropic OAuth client — uses Claude Code's local credential store.
 *
 * Reads `~/.claude/.credentials.json` (the same file Claude Code's CLI writes
 * after `claude login`), refreshes the access token against
 * platform.claude.com when within 5 min of expiry, and persists the new
 * token back so other tools (and the next process) see it.
 *
 * Ported to TypeScript from autonomous-coding-dashboard's
 * `packages/claude-auth/src/index.js` (see
 * https://github.com/IsaiahDupree/autonomous-coding-dashboard).
 * That implementation in turn mirrors the proven pattern from the
 * autonomous-outreach-agent project.
 *
 * Why this exists: on a Claude Max plan, the OAuth flow you've already done
 * via the desktop app / CLI is also the cheapest auth for SDK calls. There's
 * no need to mint a separate ANTHROPIC_API_KEY (which would bill a different
 * account and skip MFA).
 *
 * Usage:
 *   import { getOAuthClient } from "@/lib/anthropic/auth";
 *   const client = await getOAuthClient();
 *   const reply = await client.messages.create({ ... });
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";

const CRED_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const OAUTH_BETA = "oauth-2025-04-20";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

export type OAuthBundle = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
};

type CredsFile = {
  claudeAiOauth?: OAuthBundle;
};

function readCredsFile(): CredsFile | null {
  if (!fs.existsSync(CRED_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CRED_PATH, "utf-8")) as CredsFile;
  } catch {
    return null;
  }
}

function writeCredsBundle(bundle: Partial<OAuthBundle>): void {
  try {
    const creds = readCredsFile() ?? {};
    creds.claudeAiOauth = { ...(creds.claudeAiOauth ?? ({} as OAuthBundle)), ...bundle };
    fs.writeFileSync(CRED_PATH, JSON.stringify(creds), "utf-8");
  } catch (e) {
    // Non-fatal: refresh succeeded in memory; we just couldn't share it with
    // other processes. Next refresh in this process picks up where we left off.
    console.warn(`[claude-auth] could not persist refreshed token: ${(e as Error).message}`);
  }
}

/** Exchange a refresh token for a new access token. Returns null on failure. */
async function refreshOAuthToken(refreshToken: string): Promise<OAuthBundle | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    });
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      // 10s timeout per audit F2 — refresh should be fast; if Anthropic auth
      // hangs, fail fast and let the next tick retry.
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!data.access_token) {
      console.warn(`[claude-auth] refresh failed: ${data.error ?? "no access_token"}`);
      return null;
    }
    const bundle: OAuthBundle = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
    writeCredsBundle(bundle);
    return bundle;
  } catch (e) {
    console.warn(`[claude-auth] refresh error: ${(e as Error).message}`);
    return null;
  }
}

function makeOAuthClient(accessToken: string): Anthropic {
  // Per the OAuth flow: pass the token via `authToken` (Bearer auth), null out
  // `apiKey` so the SDK doesn't try x-api-key, and include the OAuth beta header.
  return new Anthropic({
    authToken: accessToken,
    apiKey: null,
    defaultHeaders: { "anthropic-beta": OAUTH_BETA },
  });
}

/** Returns true if some form of authentication is reachable. */
export function authIsAvailable(): boolean {
  if (process.env.ANTHROPIC_AUTH_TOKEN) return true;
  if (process.env.ANTHROPIC_API_KEY) return true; // fallback path
  const creds = readCredsFile();
  return !!creds?.claudeAiOauth?.accessToken;
}

/** Brief status describing which auth mode is active — useful for logs/UI. */
export function authStatus(): {
  mode: "oauth-file" | "oauth-env" | "api-key" | "none";
  expiresInMin: number | null;
  subscriptionType: string | null;
} {
  const creds = readCredsFile();
  const o = creds?.claudeAiOauth;
  if (o?.accessToken) {
    return {
      mode: "oauth-file",
      expiresInMin: o.expiresAt ? Math.round((o.expiresAt - Date.now()) / 60_000) : null,
      subscriptionType: o.subscriptionType ?? null,
    };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { mode: "oauth-env", expiresInMin: null, subscriptionType: null };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { mode: "api-key", expiresInMin: null, subscriptionType: null };
  }
  return { mode: "none", expiresInMin: null, subscriptionType: null };
}

/**
 * Returns an Anthropic SDK client. Resolution order:
 *   1. `~/.claude/.credentials.json` (auto-refresh if within 5 min of expiry).
 *   2. `ANTHROPIC_AUTH_TOKEN` env var (long-lived OAuth token from
 *      `claude setup-token`).
 *   3. `ANTHROPIC_API_KEY` env var (only if explicitly set — the OAuth path
 *      is preferred because the user is already on a Claude Max plan).
 *   4. Throw with a helpful message.
 */
export async function getOAuthClient(): Promise<Anthropic> {
  const creds = readCredsFile();
  const oauth = creds?.claudeAiOauth;
  if (oauth?.accessToken) {
    const expiringSoon =
      oauth.expiresAt && oauth.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS;
    if (!expiringSoon) return makeOAuthClient(oauth.accessToken);
    if (oauth.refreshToken) {
      const fresh = await refreshOAuthToken(oauth.refreshToken);
      if (fresh) return makeOAuthClient(fresh.accessToken);
    }
    // Refresh failed; the existing token may still work for a few minutes.
    if (oauth.expiresAt > Date.now()) return makeOAuthClient(oauth.accessToken);
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return makeOAuthClient(process.env.ANTHROPIC_AUTH_TOKEN);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    // Last-resort fallback. The OAuth path above is preferred.
    return new Anthropic();
  }
  throw new Error(
    "[claude-auth] No Anthropic credentials available. Run `claude` to log in " +
      "(or `claude setup-token` for a long-lived OAuth token), or set " +
      "ANTHROPIC_API_KEY.",
  );
}

/**
 * Sync fast-path: uses the cached token if still valid; never refreshes.
 * Use this in code paths that can't await but still need a client.
 */
export function getOAuthClientSync(): Anthropic {
  const creds = readCredsFile();
  const oauth = creds?.claudeAiOauth;
  if (oauth?.accessToken && (!oauth.expiresAt || oauth.expiresAt > Date.now())) {
    return makeOAuthClient(oauth.accessToken);
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return makeOAuthClient(process.env.ANTHROPIC_AUTH_TOKEN);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return new Anthropic();
  }
  throw new Error("[claude-auth] No valid Anthropic credentials available — use getOAuthClient() (async) for refresh-on-demand.");
}

/**
 * Proactively refresh the token if it's within 2× the refresh buffer of expiry.
 * Call this on a timer (e.g. every 30 min) inside long-running services so the
 * token never goes stale mid-request.
 */
export async function proactiveRefresh(): Promise<boolean> {
  const creds = readCredsFile();
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.refreshToken) return false;
  const needsRefresh =
    !oauth.expiresAt || oauth.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS * 2;
  if (!needsRefresh) return true;
  const fresh = await refreshOAuthToken(oauth.refreshToken);
  return !!fresh;
}
