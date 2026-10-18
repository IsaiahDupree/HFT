/**
 * Resolve a Polymarket handle / URL / partial address to the canonical 40-char
 * Ethereum address.
 *
 * Inputs accepted:
 *   - full URL:       https://polymarket.com/@bonereaper
 *   - URL with tab:   https://polymarket.com/@0xb55fa...?tab=activity
 *   - handle only:    bonereaper, @bonereaper
 *   - partial 0x:     0x732f1 (any prefix length)
 *   - full address:   0x… returned as-is after validation
 *
 * Method: fetch the public profile page and scan the static HTML for all
 * 40-char hex addresses (they're embedded in the Next.js hydration JSON).
 * The page's own profile address appears far more frequently than any other
 * (the user's own address vs. counterparty addresses in trade lists), so
 * the most-frequent match is the canonical one.
 *
 * Pure-ish — caller supplies the fetch function so tests can mock it.
 */

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
const FULL_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export type ResolveOptions = {
  fetchFn?: (url: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;
  userAgent?: string;
};

function normalizeHandle(input: string): string {
  let s = input.trim();
  // Strip protocol + host
  s = s.replace(/^https?:\/\/(www\.)?polymarket\.com\//i, "");
  // Strip any query string
  s = s.replace(/\?.*$/, "");
  // Strip leading @
  s = s.replace(/^@/, "");
  // Strip trailing slash
  s = s.replace(/\/$/, "");
  return s;
}

/**
 * Resolve to a canonical 0x address. Throws if the page can't be fetched
 * or no address is found.
 */
export async function resolveHandleToAddress(
  input: string,
  opts: ResolveOptions = {},
): Promise<string> {
  const handle = normalizeHandle(input);

  // Already a full address — return as-is.
  if (FULL_ADDRESS_RE.test(handle)) {
    return handle.toLowerCase();
  }

  const url = `https://polymarket.com/@${handle}`;
  const ua = opts.userAgent ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  const fetchFn = opts.fetchFn ?? ((u: string) => fetch(u, { headers: { "User-Agent": ua } }) as any);

  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`polymarket.com returned non-OK for ${url}`);
  }
  const html = await res.text();

  const counts = new Map<string, number>();
  for (const match of html.matchAll(ADDRESS_RE)) {
    const addr = match[0].toLowerCase();
    counts.set(addr, (counts.get(addr) ?? 0) + 1);
  }
  if (counts.size === 0) {
    throw new Error(`no 40-char addresses found on ${url} — handle may not exist`);
  }

  // Most-frequent match wins. In practice the page's own profile address
  // appears 50–100× more than any counterparty address.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0][0];
}
