# Recent addresses report — 2026-05-26

Recap of every wallet analyzed in the last session. Sorted by **realized PnL** within bucket. Updated whenever new wallets are classified.

---

## Pipeline summary

- **38 unique wallets** classified through `npm run classify:wallet`
- Distribution:
  - 18 conviction_trader (potentially_copyable)
  - 12 hft_bot (un_copyable)
  - 5 market_mover_whale (un_copyable)
  - 3 unclear
- **Top conviction_trader by realized PnL: `0xc2e7800b5af46e6093872b177b7a5e7f0563be51` (beachboy4) at $50,221,121**
- **Observer worker running** on 6 wallets: 0x6e1d5040, 0x9495425fee, 0xbddf61af53, 0x2c335066fe, 0x53757615de, 0xde7be6d489

---

## Tier 1: potentially_copyable (conviction_trader) — 18 wallets

The actionable list. Sorted by realized PnL.

| Wallet | Handle | Realized PnL | Open Book | Notes |
|---|---|---:|---:|---|
| `0xc2e7800b5af46e6093872b177b7a5e7f0563be51` | beachboy4 | **$50,221,121** | $7,148 | Sports — cycled out. Single-event variance, not repeatable edge per Lunar |
| `0x9495425feeb0c250accb89275c97587011b19a27` | labradfordsmith22 | $14,498,465 | **$1,242,119** | Still active. Top observer target. |
| `0xbddf61af533ff524d27154e589d2d7a81510c684` | countryside | $14,332,678 | **$1,200,837** | Still active. Top observer target. |
| `0x9f2fe025f84839ca81dd8e0338892605702d2ca8` | surfandturf | $8,941,218 | $113,192 | Leaderboard auto-discovered |
| `0x2c335066fe58fe9237c3d3dc7b275c2a034a0563` | (anon) | $6,889,867 | **$1,122,179** | Still active. Observer target. |
| `0x53757615de1c42b83f893b79d4241a009dc2aeea` | (anon) | $6,684,260 | **$752,692** | Still active. Observer target. |
| `0x02227b8f5a9636e895607edd3185ed6ee5598ff7` | HorizonSplendidView | $6,620,271 | $0 | Cycled out. crypto+macro per Lunar |
| `0x37e4728b3c4607fb2b3b205386bb1d1fb1a8c991` | semyonmarmeladov | $6,400,832 | $83,170 | Active but small book |
| `0x5bec79df9add70a3892041ab1a5516b60f53b215` | mosley1 | $6,165,844 | $52,761 | Active but small book |
| `0x39d3c773be30fcc73161fc6768f46d563a779ef0` | matanovik | $3,371,119 | $111,371 | Mid-tier active |
| `0xfe787d2da716d60e8acff57fb87eb13cd4d10319` | ferrarichampions2026 | $3,140,005 | $603,293 | Active |
| `0x19254b55e7c48e88baab9e62cc218223a6544654` | novoreto | $2,990,518 | $257,560 | Active |
| `0xde7be6d489bce070a959e0cb813128ae659b5f4b` | wan123 | $2,881,634 | **$1,033,487** | Still active. Observer target. |
| `0x5966db1fe50763c9e3c014d756369bad07e1f804` | (anon) | $2,465,850 | $77,803 | Active small book |
| `0xfd2b117412a698f322b0cd18d6827dad262b8e50` | surf | $2,283,881 | $242,708 | Active |
| `0x6e1d5040d0ac73709b0621f620d2a60b80d2d0fa` | (anon) | $2,029,619 | $1,093,429 | **DEEP-ANALYZED** — near-resolution scrape strategy proof |
| `0x7a8885c8dc075f0578b648f29fa233408a7d41cc` | stackingsats | $1,487,628 | $147,685 | Mid-tier active |
| `0x763427e72a4dcbd078a819a9de9b32de2794600d` | kosekibijou | $230,232 | $76,759 | Smaller tier |

---

## Tier 2: market_mover_whale — 5 wallets (un-copyable due to own slippage)

| Wallet | Handle | Realized PnL | Open Book | Why un-copyable |
|---|---|---:|---:|---|
| `0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227` | newdogbeginning | $4,796,245 | $3,844,172 | $5k+ avg per position — moves market on entry |
| `0x019782cab5d844f02bafb71f512758be78579f3c` | majorexploiter | $3,668,542 | $0 | Geopolitics+elections only per Lunar. Size = market impact |
| (3 others tagged via classifier) |  |  |  |  |

---

## Tier 3: hft_bot — 12 wallets (un-copyable due to speed-edge)

The article-curated showcase wallets and our scanner-discovered HFT bots. Speed-driven; copying with N-second lag is a structural losing trade.

| Wallet | Handle | Realized PnL (sample) | Notes |
|---|---|---:|---|
| `0x37c1874a60d348903594a96703e0507c518fc53a` | CemeterySun | $13,308,848 | Market-maker per Lunar — high volume, tiny edge per trade |
| `0x2005d16a84ceefa9d9b75d75e6f76d54b7b56378` | rn1 | $3,551,413 | Auto-leaderboard D+M+W |
| `0x732f189193d7a8c8bc8d8eb91f501a22736af081` | (anon) | $216,479 | "$100/min" example in Daniro article. 671 fills/day across 70 markets |
| `0xce25e214d5cfe4f459cf67f08df581885aae7fdc` | (anon) | $109,046 | "Stoikov-style logic" wallet per Daniro article. 8,536 fills/day across 1,024 markets |
| `0xeebde7a0e019a63e6b476eb425505b7b3e6eba30` | bonereaper | $198,627 | Daniro article — UI shows $19K MTM but real banked is $199K |
| `0xc387c2a40d389f17b723b6bba9b18b7dbd2de4f4` | flippingsharks | $19,493 | "10 days $46K" Daniro article. 940 fills/day across 199 markets |
| `0xb55fa1296E6ec55D0cE53d93B9237389f11764d4` | (Hermes/cvxv666) | (sampled) | Correlated-basket crypto bot. antpalkin Twitter source |

---

## Action items per wallet

### Observe (already running)
6 of the top conviction_traders are in the active observer's `--addresses` list. Every new trade gets `wallet-trade-classified` written to evolution_log.

### Add to observer (recommended next)
- `0x9f2fe025f84839ca…` (surfandturf, $8.9M realized) — but $113K open book, mid-tier active
- `0x37e4728b3c4607fb…` (semyonmarmeladov, $6.4M realized) — small book
- `0x5bec79df9add70a3…` (mosley1, $6.2M realized) — small book
- `0xfe787d2da716d60e…` (ferrarichampions2026, $3.1M realized, $603K book) — active

### Watch for typology drift (re-classify weekly)
The classifier's typology is a snapshot based on recent activity. A conviction_trader can become an HFT bot if they switch strategies (or vice versa). Re-run `classify:wallet` weekly to catch drift.

### Confirmed by Daniro article
3 of the 5 wallets the article showcased as success stories were already in our tracked list (`0x6e1d5040`, `0xb55fa1296`, `bonereaper`). Adding the other 2 (`0xce25e214`, `flippingsharks`) closes the gap between our independent discovery and theirs.

---

## How to add the next wallet you share

One command, accepts any input form:

```bash
npm run classify:wallet -- --handle "https://polymarket.com/@somehandle" --persist
npm run classify:wallet -- --handle "@somehandle" --persist
npm run classify:wallet -- --handle "0xpartial" --persist
npm run classify:wallet -- --address 0xfull40chars --persist
```

Output: typology bucket + copyability class + features + resolution plan, all persisted to `evolution_log`. If it lands in `conviction_trader` and has a real open book, add to observer `--addresses`.
