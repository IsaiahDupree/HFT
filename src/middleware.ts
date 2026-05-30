/**
 * Next.js middleware — guards /api/** routes from unauthenticated callers.
 *
 * Per the security audit (docs/audits/2026-05-25-arena.md #1 HIGH), the
 * existing API surface lets anyone with network access to localhost mutate
 * the trading system: place orders via /api/venue/submit, pause capsules,
 * halt risk, flip the Coinbase kill switch, etc.
 *
 * Rules:
 *   - GET requests are public (read-only; the UI hits these from any client).
 *   - Mutating verbs (POST/PUT/PATCH/DELETE) require either:
 *       a) Bearer token matching ARENA_API_TOKEN env var, OR
 *       b) NEXT_PUBLIC_ALLOW_UNAUTHED_LOCAL=1 (dev shortcut; never set in prod)
 *   - When ARENA_API_TOKEN is unset AND the dev bypass is unset, ALL mutating
 *     requests are rejected. This is the secure default — refuse to run
 *     without one of (token configured, dev bypass explicit).
 *
 * Failure mode 401 with a JSON body so the UI can show a useful error.
 */
import { NextRequest, NextResponse } from "next/server";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(req: NextRequest): NextResponse | undefined {
  // Only guard /api/**. Other routes (pages, static) are out of scope.
  if (!req.nextUrl.pathname.startsWith("/api/")) return;
  // GETs are read-only; let the UI fetch them without a token.
  if (!MUTATING_METHODS.has(req.method)) return;

  // Dev bypass — explicit opt-in; never set this in production.
  if (process.env.NEXT_PUBLIC_ALLOW_UNAUTHED_LOCAL === "1") return;

  const required = process.env.ARENA_API_TOKEN;
  if (!required) {
    return NextResponse.json(
      { ok: false, error: "ARENA_API_TOKEN env var not configured. Set it, or set NEXT_PUBLIC_ALLOW_UNAUTHED_LOCAL=1 for local dev." },
      { status: 401 },
    );
  }

  const header = req.headers.get("authorization") ?? "";
  const presented = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  if (!presented || presented !== required) {
    return NextResponse.json(
      { ok: false, error: "Missing or invalid Authorization: Bearer <token>" },
      { status: 401 },
    );
  }

  // Authorized — fall through to the route handler.
  return;
}

export const config = {
  // Apply to every /api/** route. The function itself short-circuits on
  // method/path, but the matcher restricts which requests Next.js invokes
  // the middleware for in the first place.
  matcher: ["/api/:path*"],
};
