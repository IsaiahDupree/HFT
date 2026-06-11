# Polymarket Wallet-Discovery Sweep — Round 2 (2026-06-11)

**Goal:** hunt the corners the PnL leaderboards miss: (1) the crypto 5-min Up/Down binaries (our maker lane —
series LIVE again as of 2026-06-10), (2) the VOLUME leaderboard (high-frequency grinders the PnL boards
undersell), (3) more instances of the "small near-cert taker" lane (yesterday's aekghas pattern).
**Stance:** `TRADING_POLICY.md` — pro-trading, anti-delusion. Round 1: `docs/wallets/SWEEP-2026-06-10.md`
(101 wallets; none re-examined here — all round-1 addresses + coinman2 + Inaccuratestake were hard-excluded).

## Method

New read-only scratch scripts `scripts/_sweep-round2.ts` + `scripts/_sweep-round2c.ts`
(raw output: `data/sweep-2026-06-11-round2.json`, `…-round2c.json`). Same per-wallet machinery as round 1:
activity event mix (MERGE/SPLIT/MAKER_REBATE/REWARD ⇒ maker fingerprint), 500-trade tape,
closed-positions realized stats (`wallet-verification.ts` — realized PnL, NOT leaderboard ROI),
`lb-api` all-time profit+volume (margin on volume; the survivorship cross-check), `user-pnl-api` span + max
drawdown. Browser UA on all raw calls (Python-urllib default UA is edge-blocked). `scan:leaderboard` was NOT
used (known UNIQUE-constraint crash on duplicate userNames) — leaderboards were read directly via
`poly.traderLeaderboard`, no DB writes.

- **Channel A:** 66 resolved `btc/eth-updown-5m-<epoch>` windows (12 consecutive most-recent + 1/hour back 22h,
  per asset), trades fetched with `takerOnly=false` so both sides of each fill appear → recurring counterparties.
- **Channel B:** DAY/WEEK/MONTH × top-50 `orderBy=VOL` leaderboards → exclude round-1 wallets → gate on
  lb-api **all-time realized profit > $10k** → deep-profile.
- **Channel C:** 60 markets resolved in the last 10 days with volume ≥ $100k (non-updown), most-recent 500
  trades each (= the near-resolution tape), BUY fills at 0.94–0.995 → recurring near-cert buyers.
  *Scope note:* the first attempt (events endDate-desc) found 0 qualifying markets — the recently-resolved
  event stream is flooded with sub-$1k updown/ITF markets; fixed via `gamma /markets?volume_num_min=100000`.

**Counts examined vs surviving (explicit):**

| channel | universe seen | recurring/gated | deep-profiled | candidates/intel surviving |
|---|---|---|---|---|
| A crypto 5-min | 3,189 distinct wallets, 33,000 fills, 66 windows | 509 recurring (≥6 windows) | top 18 | 3 small profitable makers, **0 profitable takers** |
| B VOL boards | 87 distinct (12 already examined round 1) | 75 checked → 49 all-time > $10k (26 failed) | 21 (top-15 by profit + 6 hand-picked; 28 survivors not profiled — cut) | 2 watch (EB99999, 0x6db568e6) + 1 modest (Binotto) + maker benchmarks |
| C near-cert | 705 distinct near-cert buyers, 60 markets | 9 recurring (≥4 mkts, ≥$3k) | 8 (1 dup = swisstony) | 1 micro-grinder (Yearof96, UNVERIFIED); lane evidence MIXED |

Total NEW wallets deep-profiled this round: **47**. Verification gates as round 1: realized PnL (lb-api
all-time is the binding number), span ≥ 90d for VERIFIED else UNVERIFIED, capital-flow/ROI distortion avoided
by never using leaderboard ROI, two-gate honesty (mechanics AND edge).

## Headline findings

1. **No consistently profitable TAKER exists on the 5-min crypto binaries in our sample.** Of 509 recurring
   wallets, the top-18 recurring split into: small profitable makers (+$19k…+$24k lifetime), one large LOSING
   maker (-$1.29M on $186M volume), one breakeven penny-quoter, and a **farm of ~10 near-identical dust bots**
   (same activity fingerprint: ~280 TRADE/220 REDEEM per 500 events, ~187 ev/h, spans 3–26d) buying 1-cent
   tails every window — all between -$913 and +$706 lifetime, i.e. breakeven noise (likely one operator,
   plausibly farming activity). **Evidence against the taker-sniping lane being occupied profitably** — which
   is good news for the maker lane: nobody we can see is reliably picking off stale quotes. Caveat: 22h of
   windows, recurrence ≥6 required; a rare, selective sniper wouldn't recur enough to be caught by this net.
2. **The VOL leaderboard is maker country, and the all-time cross-check keeps catching mirages — in both
   directions.** 26 of 75 checked VOL wallets have negative/sub-$10k lifetime realized profit despite huge
   volume. Countryside is the reverse mirage: -$997k on the WEEK board but +$3.43M lifetime (215d). And
   mooseborzoi (channel C) shows +$7.2M on its recent-50 closed positions against **-$1.97M lifetime** —
   round 1's lesson again.
3. **The "small near-cert taker" lane is NOT structurally free money.** Of 9 recurring 95–99c buyers across
   60 markets: 3 long-span positives (wowfarm +$59k/529d, apucimama +$62k/227d — both maker-hybrids whose
   profit can't be attributed to the near-cert lane alone; Yearof96 +$1.9k/32d pure), versus **richerZ
   -$94k over 514 days** and t6z454t65z -$24k/111d grinding the exact same lane, plus a 560d breakeven
   (anon.1980.123, 97% of buys ≥0.90). Long-lived losers in the lane are direct counterevidence to "structural
   edge": selection of WHICH near-certs to take is the edge, the price band itself isn't. aekghas remains
   an outlier to track, not a thesis proof.

## Channel A — crypto 5-min Up/Down binaries (the maker lane)

66 windows (33 BTC + 33 ETH) sampled across ~22h on 2026-06-10/11; every window had trades (series fully
live), 500-fill page each = 33,000 fills, 3,189 distinct wallets, 509 recurring (≥6 windows). Top 18 recurring
deep-profiled:

| wallet | class | all-time | vol | margin | span | updown share (recent 50) | verdict |
|---|---|---|---|---|---|---|---|
| `0xe9076a87…` | maker (2-sided 59%) | **-$1,285,544** | $186M | -0.7% | 89d | mixed crypto+sports | DEAD (lifetime negative; recent-50 +$556k = mirage) |
| `0x3139bb6f…` | maker | +$24,028 | $6.9M | +0.35% | 82d | 50/50 | PROFITABLE MAKER (UNVERIFIED, 82d) |
| `0x8fa76864…` | maker | +$21,821 | $5.9M | +0.37% | 58d | 50/50 | PROFITABLE MAKER (UNVERIFIED, 58d) |
| `0x2e9b93fa…` | maker (1-sided + MERGE) | +$19,397 | $18.6M | +0.10% | 71d | 50/50 | PROFITABLE MAKER (UNVERIFIED, 71d) |
| `0x2ed94d1a…` | penny-quoter (0.01–0.05) | -$878 | $7.9M | ~0% | 153d | 50/50 | BREAKEVEN |
| ~10 dust bots (`0x5b756c1d…`, `0x78a6d8b6…`, `0xd8a927c0…`, `0xefdeab0f…`, `0x17e6a2f9…`, `0x856e29c4…`, `0xf06d99fb…`, `0x81ad7ff3…`, `0x0c853317…`, `0x831d8fb6…`, `0x60cf0702…`, `0xabea4e4e…`, `0xd3d4238e…`) | 1c-tail takers | -$913…+$706 | $60k–$532k | ~0% | 3–72d | ~100% | BREAKEVEN FARM (likely one operator) |

Plus, via channel B but belonging here: **Bonereaper `0xeebde7a0…` — the crypto-updown maker benchmark:
+$998,619 lifetime on $144M volume (0.69% margin) in 77 days, max drawdown -$8,704**, ~23.9k trades/day,
median clip $14, recent-50 positions 100% crypto-updown. And **Sharky6999 `0x751a2b86…`**: +$902k over 519d,
0.43% margin, 56% crypto tape (updown + dip/reach markets), MAKER_REBATE/SPLIT/MERGE events → VERIFIED
long-span crypto maker, slower style (19.8 tpd, $121 clips).

## Maker calibration intel (what profitable updown makers' fills say)

Sampled-fill statistics from our 66 windows (fill-level, 500-row pages — order sizes ≥ fill sizes; treat as
lower bounds on clip, upper bounds on cadence):

| wallet | lifetime margin | fills/window | median fill | p90 fill | fill-price p10→p90 | near-mid share (0.4–0.6) | 2-sided windows | median inter-fill gap |
|---|---|---|---|---|---|---|---|---|
| `0x3139bb6f…` (+$24k) | 0.35% | 4.6 | $2 | $9 | 0.02→0.99 | 6% | 55% | 3s |
| `0x8fa76864…` (+$22k) | 0.37% | 3.7 | $1 | $10 | 0.02→0.99 | 5% | 48% | 3s |
| `0x2e9b93fa…` (+$19k) | 0.10% | 13.4 | $3 | $17 | 0.08→0.98 | 11% | 0% (1-sided + MERGE) | <1s |
| `0xe9076a87…` (**-$1.29M**) | -0.7% | 4.0 | $9 | $58 | 0.03→0.99 | 5% | 59% | 13s |
| `0x2ed94d1a…` (-$1k) | ~0% | 10.6 | <$1 | $1 | 0.01→0.05 | 0% | 0% | <1s |

What this calibrates for our own maker:

- **Clip size: stay tiny.** The profitable trio's median FILL is $1–3 (p90 ≤ $17); Bonereaper's all-tape
  median clip is $14. The one wallet running ~4x bigger fills ($9 median, $58 p90) is the -$1.29M loser —
  bigger resting size in a 5-min binary is pure adverse-selection surface. Target: $5–25 resting clips,
  not $50+.
- **Quote the whole lifecycle, not just the open.** Profitable makers' fills span 0.02→0.99 — they keep
  quoting as the binary converges toward 0/1 through the window, with only 5–11% of fills near mid. Most
  of the fill count happens in the wings; the wings are where takers cross.
- **Requote speed: seconds.** Median intra-window inter-fill gap is ~3s for the winners vs 13s for the big
  loser. The 5-min window prices off the live Chainlink feed; a quote stale by >5–10s is the thing that gets
  picked off. Sub-5s requote (or cancel-on-move) is the bar.
- **Two viable inventory styles:** (a) classic two-sided in ~50–60% of windows (0x3139bb6f, 0x8fa76864);
  (b) one-sided-per-window + MERGE to flatten (0x2e9b93fa — 7 MERGE events in its last 500, thinnest margin
  of the trio but biggest volume). Bonereaper's maxDD (-$8.7k while earning $999k) shows the payoff of strict
  inventory control either way.
- **Realistic take: 0.1–0.7% of volume.** Best-in-class (Bonereaper) nets 0.69% on $1.9M/day churn ≈
  $13k/day. The small wallets net ~0.35% on $80–260k/day churn ≈ $300–900/day. Our maker's economics must
  clear infra+gas at ~0.3% of volume to be in business; anything modeled above 1% is delusion by these comps.
- **Counterexamples to respect:** -0.7% on $186M (e9076a87) proves volume ≠ edge; the 153d penny-quoter
  proves tail-only quoting ≈ $0. Edge lives in mid-life requote speed and inventory discipline, not in
  showing up.

## Channel B — VOL leaderboard (PnL boards undersell these)

87 distinct wallets across DAY/WEEK/MONTH VOL top-50; 12 already covered in round 1 (incl. asjabaasj,
alwayslatetotheparty, afkpnl); 75 profit-checked; 49 survived the all-time > $10k gate; 21 profiled.
Established makers dominate (margins 0.4–1.5% on $47M–$874M lifetime volume): swisstony (+$9.54M, 305d),
RN1 (+$9.49M, 336d), Countryside (+$3.43M, 215d), 0x2c335066 (+$2.37M), elmcap2 (+$1.92M, 560d), denizz
(+$1.36M, 560d, politics), curie, Sisyphus., ndb1, Q96s3kwozynxpau, oieshfn345 — all VERIFIED-span profitable,
all MAKER-EXCLUDED for copying (their fills are the edge; coinman2 logic).

The non-maker standouts:

| wallet | class | all-time | vol | margin | span | profile | verdict |
|---|---|---|---|---|---|---|---|
| `0x5d0f03cf…` EB99999 | taker | +$962,420 | $11.2M | **8.6%** | 54d | politics-macro, $2,080 median clip, 2.4 tpd, win 0.56, maxDD -$608k | **WATCH — UNVERIFIED (54d)**; re-check ~2026-07-17 |
| `0x6db568e6…` | maker-hybrid (17% MERGE) | +$1,583,130 | $21.9M | **7.2%** | 54d | sports, buyShare 1.00 + MERGE = buy-both-sides-cheap-then-merge at $518 clips | **WATCH — UNVERIFIED (54d)**; live validation of the merge-maker lane at 7% margin |
| `0xdd9ed02b…` Binotto | taker | +$205,925 | $22.4M | 0.92% | **560d** | longshot buyer (recent-50 win 0.18 yet +$378k), politics+sports, $21 median clip | MODEST — verified span, thin margin; queue for `classify:wallet` |
| `0xa2cd4ccd…` | taker | +$237,643 | $16.4M | 1.45% | 41d | $25k clips, 61% of buys ≥0.90 (near-cert whale) | UNVERIFIED (too new) |
| `0x408fe71e…` Winnerdinnerchickenjr | taker | +$199,413 | $592k | 33.7% | **0d** | n=1 position | EXCLUDED — one-bet wonder (Inaccuratestake pattern) |
| `0x157efb90…` | taker | +$470,342 | $1.6M | 29.3% | **1d** | n=2, $10k clips, -$67k intraday DD | EXCLUDED — fresh whale on a tail |

`0x6db568e6…` matters strategically even though it's uncopyable: it is doing, today, at 7.2% margin, the
**merge-maker mechanic** our audit picked as the primary Polymarket lane — buy YES+NO below $1 combined,
merge, redeem. Its existence (and Bonereaper's) says the lane still pays in 2026-06 conditions.

## Channel C — the small near-cert taker lane (aekghas corroboration test)

60 resolved markets (last 10d, ≥$100k vol, non-updown), final-tape BUYs at 0.94–0.995: 705 distinct wallets,
9 recurring (≥4 markets, ≥$3k). Profiled (swisstony also recurred — already covered):

| wallet | class | all-time | span | near-cert sample | verdict for the lane |
|---|---|---|---|---|---|
| `0x2ada299a…` wowfarm | maker (rebates) | +$58,980 | 529d | 9 mkts, $7.1k @ .986 | positive BUT maker-hybrid — profit not attributable to lane |
| `0x5aa98152…` apucimama | maker (2-sided HFT) | +$62,082 | 227d | 7 mkts, $6.2k @ .962 | positive BUT maker-hybrid |
| `0x4b8cecc2…` Yearof96 | **taker** | +$1,878 | 32d | 5 mkts, $8.5k @ .970; 99% of buys ≥0.90; 48/50 recent = high-entry winners | **pure lane grinder, profitable, tiny — UNVERIFIED (32d)** |
| `0x7b740922…` | maker (MERGE-heavy) | +$26,795 | **7d** | 9 mkts, $4.1k @ .966 | too new; merge-arb bot |
| `0x46992d0e…` anon.1980.123 | taker-ish (97% buys ≥0.90) | -$2,397 | 560d | 4 mkts, $29k @ .984 | **560d of near-cert grinding = breakeven** |
| `0xd487f513…` t6z454t65z | taker-ish (86% buys ≥0.90) | **-$24,460** | 111d | 6 mkts, $27k @ .985 (esports) | lane LOSER |
| `0xdf434cab…` richerZ | taker-ish (82% buys ≥0.90) | **-$94,132** | **514d** | 6 mkts, $10.3k @ .987 | **long-lived lane LOSER — key counterevidence** |
| `0x84cfffc3…` mooseborzoi | maker | **-$1,969,377** | 47d | 7 mkts, $3.8k | DEAD (recent-50 shows +$7.2M — mirage exhibit #2) |

**Lane verdict: MIXED, leaning against "structural".** The only pure, profitable, multi-hundred-day,
near-cert-dedicated wallet found is… none. Survivors are maker-hybrids or 32 days old; the dedicated
long-span grinders (richerZ 514d, anon.1980.123 560d) are net negative-to-flat. Buying 95–99c per se carries
no edge after adverse selection on the losers (one 0.97 loss erases ~32 wins of 3¢). The 2dollar-bot
near-cert lane survives only with a real filter on WHICH near-certs (aekghas's geopolitical NO-buying may be
that filter — still only 13 bets, still UNVERIFIED). Do not scale that lane on structural grounds alone.

## Two-gate summary (honesty check)

| Gate | Bonereaper | 0x6db568e6 | EB99999 | Binotto | Yearof96 |
|---|---|---|---|---|---|
| 1. Mechanically copyable | ✗ maker | ✗ maker/merge | ✓ slow taker, $2k clips, liquid politics | ✓ slow taker | ✓ slow taker |
| 2. Verified realized edge (≥90d + enough bets) | ✗ 77d (huge n) | ✗ 54d | ✗ 54d | ✓ 560d but PF thin (0.9% margin) | ✗ 32d, tiny |

**Zero unconditional copy candidates from 47 new wallets — same shape as round 1 (0/101).** The value of this
round is intel, not copy targets: (a) maker calibration numbers above, (b) confirmation the merge-maker lane
pays at 0.7–7% margins today, (c) the taker-sniping lane on 5-min binaries appears unoccupied, (d) the
near-cert lane is selection-driven, not structural.

## Next actions
1. Feed the calibration table into the maker design: $5–25 clips, sub-5s requote/cancel-on-move, quote the
   full window lifecycle, inventory cap sized to Bonereaper-style DD ratio (DD ≤ 1% of cumulative take).
2. Re-examine after span gates mature: EB99999 + 0x6db568e6 ~2026-07-17 (90d); Yearof96 ~2026-08-10;
   joblessfinalboss 2026-07-10 (round 1).
3. `npm run classify:wallet -- --persist` on Binotto (longshot-taker typology, 560d) — lowest-priority of the
   watchlist but the only verified-span taker found in two rounds.
4. Re-run channel A in ~1 week with a longer window sample (and consider `observe:wallet` on Bonereaper,
   0x3139bb6f, 0x8fa76864 to time-series their quoting through volatile vs calm windows).
5. Fix `scan-leaderboard.ts` UNIQUE-constraint bug properly (`INSERT … ON CONFLICT(handle) DO UPDATE`) before
   the next persisted scan.

## Tooling notes from this round
- `gamma /events?closed=true&order=endDate` is unusable for "recently resolved big markets" — flooded by
  sub-$1k updown/ITF events (first 300 events contained zero ≥$100k markets). Use
  `gamma /markets?closed=true&volume_num_min=…&end_date_min/max` instead (worked first try).
- `data-api /trades?market=<cond>&takerOnly=false` returns both sides of fills on a market — this is how the
  maker side of the 5-min binaries was observed. Default (`takerOnly=true`) hides makers.
- 5-min updown slugs are deterministic: `{btc,eth,sol,hype,xrp}-updown-5m-<unix window start>` (300s grid),
  pre-created ~24h ahead; `gamma /events?slug=` resolves them with conditionId in one call.
- Channel-A fill stats are 500-row samples per window: fill-level, not order-level. Clip medians are lower
  bounds on resting order size.
- Scratch scripts kept re-runnable: `scripts/_sweep-round2.ts`, `scripts/_sweep-round2c.ts`.
