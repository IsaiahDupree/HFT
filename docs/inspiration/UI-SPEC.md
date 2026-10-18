# Video-inspired UI spec — Codex 5.5 vs Claude Opus 4.7 Polymarket Trading Challenge

Direct observations from 4 frames + auto-captioned transcript of https://www.youtube.com/watch?v=6UBGecQTsZE.
(Claude vision via OAuth got rate-limited after we used our session budget on this task, so the
frames were inspected directly in the Claude Code conversation rather than via the script.)

## Domain insight (most important takeaway)

**The interesting crypto market on Polymarket is the rolling "Will BTC be Up or Down in the next 5 minutes?" binary.** Both AI agents in the video build bots that:
- Watch the **Chainlink BTC/USD** price (Polymarket's settlement source) live
- Compute an **edge** ≈ `P(Up | current position vs window-start price, time remaining, volatility) − Polymarket implied price`
- Only fire when `edge ≥ fees + slippage` (~1.5% Polymarket fee + ~0.5% slippage)
- Size **half-Kelly** with hard caps: `≤ $3.25/order, ≤ $5.25/market, ≤ $8.25 total open`
- Use a **6-second-before-close** gate so they bet on near-decided windows
- Reject if **Chainlink quote is > 2.5s stale**
- Stop opening new positions in the **last 8 seconds** of a window

## UI elements borrowed from the video

| Element | Video shows | Apply to /crypto |
|---|---|---|
| **STANDBY → LIVE pill** | Status flips with a countdown when bot arms | Top of each crypto card: `STANDBY` (yellow) or `LIVE` (green) per product |
| **Window countdown timer** | "60:00" hour countdown + per-window 5-min countdown | Per-card: time-to-next-5min-tick countdown for the Up/Down windows |
| **Preflight checklist with ✓** | `geoblock allowed ✓ / WALLET gas > 0.2 MATIC ✓ / CLOB auth valid ✓` | "Trade readiness" checklist: data freshness ≤ N seconds ✓, capsule under daily cap ✓, kill switch clear ✓ |
| **Tight position caps shown** | `≤ $3.25 per order, ≤ $5.25 per market, ≤ $8.25 total open` | Show the capsule's per-order / per-product / total caps right where decisions happen |
| **Safety rails callout** | "Stale-data gate / Last-8-seconds lockout / Drawdown stop" | Compact "safety rails" panel listing all active gates with one-liners |
| **Live W/L scoreboard** | "today's scoreboard: 1 win / 8 losses on Up bets" | Per-agent and per-product W/L stats for the trading day |
| **Plain-English one-sentence summary** | "It uses live Bitcoin price to calculate the true odds of each 5-min market, and only places small bets when Polymarket is selling those odds at a discount" | Each crypto card has a one-line "what we're looking for" caption |
| **Tabular monospace dollar formatting** | `$51.06`, `20.0000 MATIC`, `50.02 pUSD` | Already mono, but tighten formatting and align decimal points |
| **Side-by-side comparison view** | Claude terminal left, Codex terminal right | For crypto: "Coinbase truth | Polymarket implied" side-by-side per product |
| **Edge calculation shown** | "Bot estimates Up has a 70% chance... Polymarket lets us buy Up at 58c... 12c gross edge" | Per-window edge calc card with our momentum signal as the truth source |

## Concrete layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Crypto trading challenge — live                                          │
│ Every 5 min Polymarket opens "Will BTC be Up or Down?" — we play those.  │
├──────────────────────────────────────────────────────────────────────────┤
│ ╭─ BTC ─────────────────╮ ╭─ ETH ─────────────────╮ ╭─ SOL ───────────╮  │
│ │ [LIVE]   60s ▲▲       │ │ [STANDBY] 60s         │ │ [LIVE]   60s ▼  │  │
│ │ $77,255  +0.34% 5m    │ │ $2,108   -0.10% 5m    │ │ $145.20 +1.2%5m │  │
│ │ vel +0.34% acc +0.05% │ │ vel -0.10% acc +0.02% │ │ vel +1.2% +0.4% │  │
│ │ ▁▂▃▄▅▆▇█▆▄▂           │ │ ▇▆▅▄▃▂▁▂▃▄           │ │ ▁▂▄█▆▃▂▁▂▃     │  │
│ │ ────────────────      │ │ ────────────────      │ │ ─────────────── │  │
│ │ Our estimate: Up 68%  │ │ Our estimate: Down 53%│ │ Up 71%          │  │
│ │ PM implied:    Up 52% │ │ PM implied:    Up 49% │ │ PM implied: 64% │  │
│ │ Edge (gross): +16pt   │ │ Edge:          -2pt   │ │ Edge:        +7 │  │
│ │ → FIRE LONG @ 52c     │ │ → SKIP (no edge)      │ │ → FIRE LONG @64c│  │
│ ╰───────────────────────╯ ╰───────────────────────╯ ╰─────────────────╯  │
├──────────────────────────────────────────────────────────────────────────┤
│ TRADE READINESS                          POSITION CAPS (per capsule)     │
│ ✓ data freshness < 10s                   per order:   $3.25 / $25 max    │
│ ✓ daily spend $0.00 < $100 cap           per product: $5.25 / $50 max    │
│ ✓ kill switch clear                      total open:  $8.25 / $25 max    │
│ ✓ Coinbase JWT valid                                                     │
├──────────────────────────────────────────────────────────────────────────┤
│ TODAY'S SCOREBOARD                                                       │
│ Agent              W/L     Net P&L   Avg edge captured                   │
│ g4-c2-mom-btc      3/2     +$1.40    +4.2pt                              │
│ g3-x-rand-7        0/1     -$0.45    —                                   │
└──────────────────────────────────────────────────────────────────────────┘
```

## Color palette borrowed

The video uses macOS terminal aesthetic:
- BG: near-black
- FG: white / off-white
- Confirmations / "Yes" / Up: bright green (close to `#46d39a`)
- Warnings / "No" / Down: red (close to `#ff6e6e`)
- Highlights (key terms, file paths): cyan / teal
- Headers: cyan / magenta
- Time / metadata: dim gray

Our existing `globals.css` palette already matches — just lean into it harder. The
`pill-green/-red/-amber/-blue` classes are exactly the right vocabulary.

## What's intentionally NOT borrowed

- The video bots use **Chainlink** as the truth source because Polymarket settles from
  Chainlink. We use **Coinbase spot** (close enough for now; a Chainlink oracle adapter
  is a follow-up if our agents start systematically losing the settlement coin-flip).
- The video's per-window 5-minute betting requires Polymarket's specific "BTC Up/Down"
  markets which appear and resolve every 5 minutes. Our snapshot worker currently pulls
  the broader "Crypto" tag; we'd add a `ARENA_POLY_TAGS=crypto-btc-updown` once we
  identify the right Gamma tag for those specific markets.
- "5h limit" warnings — that's Claude Code-specific, not for our UI.
