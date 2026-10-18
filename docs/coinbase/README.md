# Coinbase Advanced Trade — Local Documentation Mirror

This folder is a **read-only** offline mirror of selected Coinbase Advanced Trade API documentation pages, fetched on **2026-05-25** for reference while working on this workspace.

## What's mirrored

9 documents covering:

- **Overviews:** `overview.md`, `rest-api.md`, `sandbox.md`, `faq.md`
- **WebSocket:** `websocket-overview.md`, `websocket-rate-limits.md`
- **Guides:** `guides-orders.md`
- **Auth:** `auth-jwt.md` (cross-product CDP JWT auth)
- **API reference root:** `api-reference-introduction.md`

The full set of source URLs (one per line) is in `_urls.txt`.

## Canonical source

The authoritative documentation lives at **https://docs.cdp.coinbase.com** — always treat the live site as source of truth. These local copies may go stale as the API evolves.

## Refreshing

To re-pull, iterate over the URLs in `_urls.txt` and use WebFetch (or `curl` + an HTML-to-markdown converter) to regenerate each file. The naming convention is loose; see the heading-to-file mapping above.

## Notes

- Some pages (notably the API reference index) render entirely client-side and returned partial content via non-browser fetch. Those files include a `⚠️` note at the top pointing back to the canonical URL.
- This mirror is intentionally **read-only** — do not edit these files; refresh them instead.
