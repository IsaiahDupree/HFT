# Lag-Aware Copy-Backtest — 2026-06-11

**Question (from `SWEEP-2026-06-10.md`):** the three conditional candidates are live-game sports takers whose
edge is ENTRY TIMING. How much edge survives a realistic copy delay at executable prices, per wallet, at
5s / 30s / 60s / 300s? Stance: `TRADING_POLICY.md` — pro-trading, anti-delusion; only the data vetoes.

**Tooling:** `scripts/_copy-lag-backtest.ts` (new scratch, read-only against external APIs; reuses
`collapseSluggedTrades` + `parseGammaResolvedMarket` from `src/lib/wallets/copy-backtest.ts`).
Raw outputs: `data/copy-lag-2026-06-11-{ethanaz,ethanaz-min2k,alwaysfade,alwaysfade-min1k,0x418d51e1}.json`.

## Method (no lookahead anywhere)

- **Leader fills:** `data-api /trades?user=…` fully paginated (offset hard-caps at 3000; all three wallets'
  relevant histories fit — ethanaz ~1.9k trades back to 2026-01-04, 0x418d51e1 all 156 trades to 2024-07,
  alwaysfade all 43). Slugged orders collapsed into logical bets (1h window, repo-standard dedup).
- **Copy entry:** the copier sees the leader's fill at t and enters at the executable price at t+delay.
  Priced from CLOB `prices-history` **1-minute bars** (`startTs/endTs` + `fidelity=1` — verified the finest the
  historical API serves), first bar at-or-after t+delay, **plus a 1¢ spread-crossing cost** (copier is a taker;
  NBA books are ~1 tick wide). Taker fee = $0 (Polymarket sports today); gas relayer-subsidized.
- **Settlement:** hold to resolution (Gamma winning index — matches the leaders' observed behavior); if the
  leader exits early via SELL ≥50% of the buy, the copy mirrors the exit at t_sell+delay (bid side, −1¢).
- **Leader benchmark:** the leader's own vwap fills settled identically **on the exact same bet set**, $100
  equal-weight per bet for both. (Equal-weight leader ROI ≈ their lb-api margins — 5.3% vs 5.0% for ethanaz,
  14.6% vs 13.3% for alwaysfade's conviction clips — sanity holds.)
- **Skeptic controls:** *shuffle* = random entry times in the same token/market window (20 draws/bet), settle
  at resolution — isolates timing from side-selection; *beta* = buy the at-entry favorite at the same delayed
  times — checks "is it just favorites win?". **Advocate check:** size-filtered runs (`--min-usd`), because a
  real copier filters out the leaders' tiny probe bets; missing-data buckets marked UNMEASURED, never dead.

### Fidelity honesty — what 5s/30s actually means here

The CLOB historical API serves **nothing finer than 1-minute bars**, and the `data-api /trades` market tape
hard-caps at offset 3000 (only the most recent ~3.5k prints per market are reachable; `after`/`before` params
are silently ignored). Therefore:

- **60s and 300s are honestly measured on the full bet sets** (achieved delay avg ~90s for the 60s bucket and
  ~330s for the 300s bucket — bar granularity; treat "60s" as 60–180s and "300s" as 300–420s).
- **5s and 30s are measured only on the tape-reachable subset** (bets close enough to a market's final ~3.5k
  prints), priced from side-attributed actual prints. That subset skews to recent/late-game entries and is
  reported with its n — it is evidence, not the verdict. Where the subset is unrepresentative the 5s/30s cell
  is **UNMEASURED**, not extrapolated.

---

## 1. ethanaz `0xf28e42d20e4826f2b10a24bc952001697947cab2` — in-game NBA live trader

Full reachable history 2026-01-04 → 2026-06-11: 1,927 trades → 1,198 logical bets; 944 scored
(254 unresolved markets skipped, 70 uncopyable at >0.985 after spread). 974/974 tokens had price bars.

| delay | n | avg entry slippage vs leader | copy ROI / $100-bet | leader ROI (same bets) |
|---|---|---|---|---|
| 5s (tape subset, recent 40 mkts) | 34 | +1.7¢ | +22.2% | (subset leader ≈ +18% — hot recent window) |
| 30s (tape subset) | 30 | +3.9¢ | +24.0% | 〃 |
| **60s (full set)** | **944** | **+2.0¢ (1.0¢ drift + 1.0¢ spread)** | **−2.6%** | **+5.3% (win 47.1%)** |
| **300s (full set)** | **909** | **+2.6¢** | **−2.5%** | **+7.6%** |

Controls (d=60 set): shuffle **+1.9%**, beta **−2.1%**. Conviction filter (≥$2k, n=375): copy **+4.3%** @60s,
**+6.5%** @300s vs leader +8.0/+8.7%; shuffle on that subset **+17.5%** (random timing on his conviction sides
beats the lagged copy — the conviction alpha is SIDE selection, and earlier-than-him is better than later).

**Reading:** his entry impulse is real (+1.0–1.6¢ drift within 90–330s of his fills) — and that is exactly the
problem: the lagged copier pays the impulse plus the spread, turning +5.3% of leader edge into **−2.6%**, *below
even the random-timing baseline*. The +22% tape-subset numbers replicate on bar-priced scoring of the same
recent markets (+18.1%, n=41) — it is a hot June/playoffs window, not finer-delay magic: monthly delayed-copy
ROI swings −19% (Jan) to +21% (Dec) around the −2.6% mean. With 944 bets this is the best-powered result in the
study.

**Verdict: EDGE DIES AT ≤60s** (full mix; PF 9.66 headroom does NOT survive the first minute). The ≥$2k subset
is marginal-positive (+4–6%) but the shuffle control attributes it to side selection during a winning regime —
demote to NOT-COPYABLE-TIMING per the sweep's pre-registered falsifier; only a forward shadow on conviction
clips could revive it.

## 2. alwaysfade `0xe5b70fd855af9258d9463992e4f1ed7987905ee3` — selective live-NBA dip buyer

Full history (43 trades → 34 logical bets; 26 scored, 8 unresolved). Caveat from the sweep stands: tiny n.

| delay | n | avg entry slippage | copy ROI | leader ROI (same bets) |
|---|---|---|---|---|
| 5s (tape subset) | 10 | −0.3¢ | −59.9% | (subset = recent **$5–$500 probe bets**, the leader's own losers) |
| 30s (tape subset) | 10 | −1.4¢ | −85.5% | 〃 |
| **60s (all bets)** | **26** | **+0.8¢** | **−0.9%** | **+2.7% (win 34.6%)** |
| **300s (all bets)** | **25** | **+1.4¢** | **−4.5%** | **+6.8%** |
| **60s (clips ≥$1k, n=19)** | **19** | **+1.1¢** | **+10.1%** | **+14.6% (win 42.1%)** |
| **300s (clips ≥$1k)** | **19** | **+1.1¢** | **+10.2%** | **+14.6%** |

Controls (≥$1k set): shuffle **+7.3%**, beta **−22.9%**. (Unfiltered controls: shuffle −15.6%, beta −8.6%.)

**Reading:** the advocate case from the sweep measures out — his conviction dip entries (0.11–0.43) leave so
much headroom that the copy ROI is **flat from 60s to 300s** (+10.1% → +10.2%); dip windows last minutes, slippage
is ~1¢. The probe bets (~$5–500) are noise and a real copier filters them by size. Skeptic: (a) n=19 — a couple
of tail losses erase a 42%-win/+10% line; (b) shuffle gets +7.3%, so most of the surviving edge is *which side
he picks during the game*, timing adds only ~3pp; (c) the 5s/30s cells cover only the probe bets — fine-delay
behavior of the conviction clips is **UNMEASURED** (their mid-game entries sit behind the 3000-print tape cap).

**Verdict: CONDITIONALLY COPYABLE AT ≤300s** (delay-insensitive within measurement), on a **size-filtered
(≥$1k) rule only** — but UNMEASURED at fine delays and statistically thin. Exactly the case the sweep assigned
to forward shadow-tracking; do not size in on n=19.

## 3. `0x418d51e13d019913bb027db22ecc723fe1ad88a3` — slow NBA/MLB moneyline value

Full ~2-year history (156 trades → 129 logical bets; 103 scored, 24 unresolved, 7 leader early-exits mirrored).

| delay | n | avg entry slippage | copy ROI | leader ROI (same bets) |
|---|---|---|---|---|
| 5s (tape subset, recent 30 mkts) | 16 | +0.2¢ | +33.4% | (recent subset ran hot) |
| 30s (tape subset) | 15 | −0.2¢ | +47.3% | 〃 |
| **60s (full set)** | **103** | **+0.5¢ (drift −0.5¢ + spread 1¢)** | **+13.5%** | **+14.8% (win 63.1%)** |
| **300s (full set)** | **104** | **+0.9¢** | **+13.5%** | **+14.7%** |

Controls: shuffle **+14.8%** (= the copy, = the leader), beta **−0.6%**.

**Reading:** the copy retains **91% of the leader's edge at 60s and at 300s** — and the negative drift (−0.5¢)
says price tends to come back to him after entry: value entries, not momentum. The shuffle control is the key
skeptic finding cut both ways: random entry times on *his chosen sides* do exactly as well (+14.8%), so the
alpha is **side selection, not timing** — which is precisely what makes it mechanically copyable at ANY delay
a human or bot can achieve. Beta ≈ 0 rules out "he just buys favorites." Remaining skeptics from the sweep
still stand: n=103 over 2 years, PF 1.48 (modest), and the classifier's insider-signature flag (recent 100%
streak on $8k clips) — in-sample selection alpha at this n can also be a lucky-side run; only forward,
independent resolution settles it.

**Verdict: COPYABLE AT ≤300s** (delay-insensitive; the only candidate whose measured copy ROI ≈ leader ROI).
Promote to forward shadow at the head of the queue.

---

## Summary

| wallet | 5s | 30s | 60s | 300s | verdict |
|---|---|---|---|---|---|
| ethanaz | subset-only (+22%, hot window) | subset-only | **−2.6%** (n=944) | **−2.5%** | **EDGE DIES AT ≤60s** — demoted per pre-registered falsifier |
| alwaysfade ≥$1k clips | UNMEASURED (tape cap) | UNMEASURED | **+10.1%** (n=19) | **+10.2%** | **COPYABLE AT ≤300s (conditional — thin n, shadow first)** |
| alwaysfade all bets | −60% (probe bets) | −86% | −0.9% (n=26) | −4.5% | dead unfiltered — size filter is load-bearing |
| 0x418d51e1 | +33% (n=16 subset) | +47% | **+13.5%** (n=103) | **+13.5%** | **COPYABLE AT ≤300s — promote to forward shadow** |

The sweep's structural hypothesis is now measured, and it splits the cohort exactly along timing-dependence:
the high-frequency in-game reader (ethanaz) is uncopyable because his edge IS the next 60 seconds; the two
slow, selective bettors survive lag because their edge is *which side*, not *when* — but both carry sample-size
or insider-flag caveats that only a forward track can clear. This is consistent with the prior cohort's forward
falsification and the coinman2/maker lesson: speed edges don't copy; selection edges might.

**Honesty ledger:** in-sample, survivorship-selected leaders (leaderboard winners); 60s/300s buckets are really
60–180s/300–420s (1-min bar granularity); 5s/30s only measurable on biased tape subsets; spread modeled flat at
1¢/leg (thin late-game or MLB books can be wider); unresolved/open markets (254 ethanaz, 8 alwaysfade, 24
0x418d51e1 bets) excluded; equal-weight $100 sizing (leader dollar-weighting differs); no copier market-impact
modeled (fine at $100, not at the leaders' clip sizes).

## Forward shadow-tracking — what settles this

Run (do NOT start without deciding ownership of the daemon):

```bash
npm run observe:wallet -- --addresses 0xe5b70fd855af9258d9463992e4f1ed7987905ee3,0x418d51e13d019913bb027db22ecc723fe1ad88a3 --interval 30
```

(ethanaz optional as a falsification control — expect his shadow-copy to lose.) `observe-wallet.ts` today
detects + classifies new trades (dedup by txHash, persists `wallet-trade-classified` events) but does **not**
yet record our achievable copy price. For the 2-week shadow to be decisive it must record, per detected leader
trade: (1) detection latency (leader fill ts vs our poll ts — the real-world "delay" this backtest parameterized);
(2) CLOB best ask + spread for the same token at detection and at +60s/+300s (`poly.price`/`poly.spread` — live
polling gives the 5s/30s fidelity history cannot); (3) leader bet size (to apply the ≥$1k filter for alwaysfade);
(4) resolution outcome joined later via Gamma. Success criteria, pre-registered: **0x418d51e1** shadow-copy ROI
at recorded-latency entry > +5% over ≥25 new bets; **alwaysfade** ≥$1k-clip follow-edge > 0 over ≥20 new
positions (per the sweep's falsifier); **ethanaz** shadow expected ≤0 (control). Kill on the data, either way.

## Tooling notes from this run

- **Bug (real, repo-wide):** Gamma `/markets` no longer honors comma-joined `condition_ids` — returns `[]`
  silently. Repeated `condition_ids=` params work. `poly.marketsByCondition` (src/lib/polymarket/client.ts:79)
  is therefore broken, which silently zeroes the resolved-mode of `npm run copy:backtest`
  (scripts/copy-backtest.ts) — every market shows "unresolved." Fix the client to repeat the param.
- `data-api /trades` offset hard-caps at 3000 (`{"error":"max historical activity offset of 3000 exceeded"}`);
  `after`/`before`/time filters are ignored.
- CLOB `prices-history` accepts `startTs`/`endTs` + `fidelity=1` → true 1-min bars for arbitrary historical
  windows (the repo client only exposes `interval`, which downsamples long ranges to ~10-min bars).
