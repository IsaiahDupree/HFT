#!/usr/bin/env bash
# download-binance-history.sh — archive Binance public market data (keyless bulk
# ZIPs from data.binance.vision) to an external drive, sha256-verified + resumable.
# This is the "download + store on the passport" half; load into the warehouse with
# scripts/load-binance-history.ts.
#
#   scripts/download-binance-history.sh \
#     --symbols BTCUSDT,ETHUSDT,SOLUSDT --intervals 1d,1h,1m \
#     --from 2021-06 --to 2026-05 --market spot --type klines \
#     --dest "/Volumes/My Passport/hft-data/binance"
#
# --type aggTrades/trades have no interval dir (perp aggTrades carry the maker/taker
# aggressor sign the OFI/VPIN models need). --market: spot | futures/um | futures/cm.
# Idempotent: an already-present, non-empty target file is skipped. Missing future
# months are reported, not fatal.
set -uo pipefail

SYMBOLS="BTCUSDT"; INTERVALS="1d"; FROM=""; TO=""; MARKET="spot"; TYPE="klines"; DEST=""
while [ $# -gt 0 ]; do case "$1" in
  --symbols) SYMBOLS="$2"; shift 2;;
  --intervals) INTERVALS="$2"; shift 2;;
  --from) FROM="$2"; shift 2;;
  --to) TO="$2"; shift 2;;
  --market) MARKET="$2"; shift 2;;
  --type) TYPE="$2"; shift 2;;
  --dest) DEST="$2"; shift 2;;
  *) echo "unknown arg $1"; exit 1;;
esac; done
[ -n "$DEST" ] || { echo "need --dest <dir>"; exit 1; }
[ -n "$FROM" ] && [ -n "$TO" ] || { echo "need --from YYYY-MM --to YYYY-MM"; exit 1; }
BASE="https://data.binance.vision/data/${MARKET}/monthly/${TYPE}"

months() { # FROM TO -> YYYY-MM lines
  local y=${1%-*} m=$((10#${1#*-})) ey=${2%-*} em=$((10#${2#*-}))
  while [ "$y" -lt "$ey" ] || { [ "$y" -eq "$ey" ] && [ "$m" -le "$em" ]; }; do
    printf '%04d-%02d\n' "$y" "$m"
    m=$((m+1)); if [ "$m" -gt 12 ]; then m=1; y=$((y+1)); fi
  done
}

total=0; got=0; skip=0; miss=0; bad=0
IFS=',' read -ra SYMS <<< "$SYMBOLS"
IFS=',' read -ra IVS <<< "$INTERVALS"
[ "$TYPE" = "klines" ] || IVS=("-")   # non-kline types have no interval dimension

for sym in "${SYMS[@]}"; do
  for iv in "${IVS[@]}"; do
    if [ "$TYPE" = "klines" ]; then sub="$sym/$iv"; else sub="$sym"; fi
    outdir="$DEST/$MARKET/$TYPE/$sub"; mkdir -p "$outdir"
    while read -r ym; do
      total=$((total+1))
      if [ "$TYPE" = "klines" ]; then fn="${sym}-${iv}-${ym}.zip"; else fn="${sym}-${TYPE}-${ym}.zip"; fi
      out="$outdir/$fn"
      if [ -s "$out" ]; then skip=$((skip+1)); continue; fi
      url="$BASE/$sub/$fn"
      if curl -fsSL --max-time 600 "$url" -o "$out.tmp" 2>/dev/null \
         && curl -fsSL --max-time 60 "$url.CHECKSUM" -o "$out.sum" 2>/dev/null; then
        exp=$(awk '{print $1}' "$out.sum"); act=$(shasum -a 256 "$out.tmp" | awk '{print $1}')
        if [ "$exp" = "$act" ]; then mv "$out.tmp" "$out"; rm -f "$out.sum"; got=$((got+1));
          echo "  ✓ $fn ($(du -h "$out" | cut -f1))"
        else echo "  ✗ CHECKSUM MISMATCH $fn"; rm -f "$out.tmp" "$out.sum"; bad=$((bad+1)); fi
      else
        rm -f "$out.tmp" "$out.sum"; miss=$((miss+1))   # month not published (future / pre-listing)
      fi
    done < <(months "$FROM" "$TO")
  done
done
echo ""
echo "done: $got downloaded · $skip already-present · $miss missing(future/pre-listing) · $bad checksum-fail · of $total target months"
echo "archive: $DEST/$MARKET/$TYPE"
echo "load → npx tsx scripts/load-binance-history.ts --archive \"$DEST\" --market $MARKET"
