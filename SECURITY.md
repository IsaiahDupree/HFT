# Security model

This repo is designed to be safe to publish. The threat that matters most is **accidentally committing a private key or API credential**. Here's how that's prevented and what to double-check before every push.

## What lives where

| Type of secret | Location | Committed? |
|---|---|---|
| Polymarket signer **private key** | `.env.local` | **No** (gitignored) |
| Polymarket relayer API key + signer address | `.env.local` | **No** (gitignored) |
| Polymarket CLOB L2 derived API key/secret/passphrase | `.env.local` (populated by `npm run derive:creds`) | **No** (gitignored) |
| Coinbase CDP API key **private key** (PEM) | `coinbase_cloud_api_key.json` at repo root, OR inline in `.env.local` as `COINBASE_CDP_PRIVATE_KEY` | **No** (gitignored — both paths) |
| Coinbase CDP API key **name** (org/key path) | same file as above | **No** (gitignored) |
| Anthropic Claude OAuth tokens | `~/.claude/.credentials.json` (outside the repo entirely) | **No** (the file is in your home dir) |
| `ANTHROPIC_API_KEY` if you set one | env var or `.env.local` | **No** (gitignored) |
| Local SQLite (`data/polymarket.db`) — contains tracked-wallet addresses + research notes | `data/` | **No** (gitignored — entire `data/` folder) |
| Last Polymarket endpoint-sweep results (may include user-scoped position data) | `docs/test-results.json` | **No** (gitignored) |
| Last Coinbase endpoint-sweep results (may include account balances, order history) | `docs/coinbase-test-results.json` | **No** (gitignored) |

The `data/` folder is **entirely** gitignored — anything you put there is local to your machine.

## What does ship in the repo

- `src/`, `scripts/`, `docs/polymarket/` (mirrored public docs), `docs/research/articles/`
- `.env.local.example` — placeholder values only, never real credentials
- All test fixtures use synthetic data (no real wallets, no real keys)

## Before every `git push`, verify

```bash
# Show what's actually staged:
git status

# Search for accidental secret leakage in staged content:
git diff --cached | grep -iE "PRIVATE_KEY|SECRET|api_key|0x[a-f0-9]{40}|0x[a-f0-9]{64}|sk-[a-zA-Z0-9]" | head

# Empty output = safe to push. If anything matches, STOP and investigate.
```

If you ever realize a secret was committed:

1. **Rotate the credential immediately.** Treat it as compromised even if the repo is private.
2. Don't just delete it in a new commit — git history still has it. Use `git filter-repo` or BFG to scrub the history, force-push, and notify any collaborators to re-clone.

## Why no API keys for Claude

Anthropic API calls in this repo use **Claude OAuth credentials** from the local Claude Code install (`~/.claude/.credentials.json`) rather than `ANTHROPIC_API_KEY`. That avoids:

- A second billing account to track
- A second key to rotate
- Skipping MFA (OAuth requires the desktop login)

`ANTHROPIC_API_KEY` is still accepted as a fallback if explicitly set — see `src/lib/anthropic/auth.ts:getOAuthClient()` for resolution order.

## Reporting

If you find a way to coerce this codebase into leaking a credential, please open a private issue rather than a public PR.
