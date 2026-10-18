# Security — running other people's code, protecting credentials

This skill complements [SKILL.md](./SKILL.md) and the repo's [SECURITY.md](../../SECURITY.md). Where the latter covers OUR app's secret handling, this file is about **defending against the wider Polymarket-tooling ecosystem** — where malware-laden repos and star-farmed clones are an active threat.

Sources: [Lunar 2026-03-30 article](../research/lunar-2026-03-30-mass-analysis.md), our own audit experience.

## The threat that's already happened

**December 2025: `polymarket-copy-trading-bot` on GitHub contained malware.** Professional README. Working code. Real API connections. Hidden inside a dependency: code that read `.env`, extracted the private key, and sent it to a remote server. The bot worked. The wallet drained.

Per the Lunar article: **664 malicious repos** identified on GitHub at time of writing, **14,285 people** downloaded malware before discovery. Our verification deliberately did NOT call up `RaphaelKrutLandau/polymarket-copy-trading-bot` for that reason.

## Hard rules

1. **Never use your main wallet** for any bot you didn't write yourself. Use a dedicated Polygon wallet funded only with the working capital you're willing to lose.
2. **Audit every dependency before install**: `pip list`, `npm ls --depth=2`, check the package's GitHub for a real history (not 3 commits all from yesterday).
3. **Repo created after Feb 2026 with 500+ stars → likely star-farmed.** Real organic repos accrue stars gradually; ten new repos with identical README structure all gaining hundreds of stars in a week is a coordination campaign.
4. **Limit USDC approvals with [Revoke.cash](https://revoke.cash).** Default approvals are unlimited; restrict them per-spender per-amount.
5. **Start at $100–300 of working capital** until a bot has run 2+ weeks of paper or tiny-live trades. Scale only after observing behavior, not before.

## How our architecture enforces this

The above isn't aspirational — it's what the venue router + capsules + stages already enforce:

| Threat | Mitigated by |
|---|---|
| Untrusted code submits a huge order | `RISK_MAX_ORDER_USD` (default $250) caps any single submit |
| Untrusted code spams orders to drain the wallet | `RISK_MAX_ORDERS_PER_MIN` (default 60) rate-limits |
| Untrusted code accidentally goes live | `ALLOW_TRADE=1` / `COINBASE_ALLOW_TRADE=1` must be explicitly set; capsule `allowed_venues` must include the venue |
| Untrusted code targets a forbidden market | `RISK_FORBIDDEN_SYMBOLS` blocklist |
| Bot's `.env` gets exfiltrated | `data/`, `.env.local`, `coinbase_cloud_api_key.json` are gitignored AND the dedicated-wallet rule means the leaked key controls bounded capital |
| Bot rewrites its own config based on LLM output | Capsule + stage are stored in SQLite, not env — an LLM can't silently widen the cap by editing a file |

Don't add capability paths that bypass these. If a script needs to trade, route through `getDefaultRouter().submit()` so all 5 gates fire. See [venue-router.md](./venue-router.md).

## Star-farmed repo heuristic — a 30-second sniff test

When evaluating a repo someone DM'd you or that's trending on Twitter:

1. Check `Insights → Contributors`. Single committer with 50 commits in 2 days?
2. Check `Insights → Network`. Is it a fork of a known good repo? (Usually yes — the malware variant is a fork with one extra commit.)
3. Diff against the upstream: `git diff upstream/main HEAD`. Anything reading `.env`, `os.environ`, or doing a `requests.post()` to a non-API host?
4. Look at the dependencies. `requirements.txt` with pinned obscure packages? Search each on PyPI for download counts + reverse-deps.
5. Check the README. Affiliate links to telegram/kreo/discord? Marketing-heavy with claimed PnL screenshots? Real infrastructure doesn't market itself like this.

If 2+ flags fire, **don't install**. Read the code in the GitHub UI instead.

## What to do if you suspect compromise

1. **Engage the kill switch immediately**: `curl -X POST http://localhost:3000/api/risk/halt -H 'content-type: application/json' -d '{"reason":"suspected wallet compromise","mode":"liquidate"}'`. This cancels every open order on every adapter + sets `RiskEngine.halted=true`.
2. Move funds out of the affected wallet: standard Metamask "Send" to a fresh address.
3. Revoke all token approvals from the compromised wallet via Revoke.cash.
4. Audit `evolution_log` and `order_events` for the last 48h — look for `submit-ok` / `arb-executed` / `cb-executed` rows you don't remember authorizing.
5. Rotate any other credentials that touched the compromised machine (CLOB L2, Coinbase CDP key, Anthropic OAuth).

## Verifying high-PnL claims you see online

Don't trust the screenshot. The article we ingested cites four wallets with $2M–$36M figures, but none are independently verified.

The right check:

```bash
# resolve handle → address via leaderboard
npx tsx scripts/analyze-tracked-wallet.ts <handle>
# then verify on Polygonscan + sum closed-positions cashPnl
curl -s "https://data-api.polymarket.com/closed-positions?user=<address>&limit=500" | \
  jq '[.[].cashPnl] | add'
```

If the API number disagrees with the social-media claim by >2×, treat the claim as marketing.
