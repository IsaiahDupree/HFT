#!/usr/bin/env bash
# Downloads every Polymarket doc page (English only) as raw .md via Mintlify export.
# Re-runs idempotently — overwrites whatever is there.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URLS="$ROOT/docs/polymarket/_urls.txt"
OUT="$ROOT/docs/polymarket"
BASE="https://docs.polymarket.com"

fetch_one() {
  local path="$1"
  local dest="$OUT/$path.md"
  mkdir -p "$(dirname "$dest")"
  local code
  code=$(curl -sL -o "$dest" -w "%{http_code}" "$BASE/$path.md")
  if [[ "$code" != "200" ]]; then
    printf '[FAIL %s] %s\n' "$code" "$path" >&2
    rm -f "$dest"
    return 1
  fi
  printf '[ ok ] %s (%s bytes)\n' "$path" "$(wc -c <"$dest")"
}
export -f fetch_one
export OUT BASE

# 12 parallel curls — polite, fast.
xargs -a "$URLS" -P 12 -I{} bash -c 'fetch_one "$@"' _ {}
echo "---"
echo "Downloaded: $(find "$OUT" -name '*.md' -not -name '_*' | wc -l) files"
