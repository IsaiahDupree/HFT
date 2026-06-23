# Data Locations — HFT-work

**Status (2026-06-22): data ARCHIVED to external drive. Repo holds code only.**

## Where the data lives

| What | Location | Size |
|------|----------|------|
| All `HFT-work` data | `/Volumes/My Passport/trading-data-archive/HFT-work/data/` | **1.6 GB** |
| `cascade-klines/`, paper dbs | under that dir | — |

`./data` in this repo is a **symlink** → `/Volumes/My Passport/trading-data-archive/HFT-work/data`.
`du -sh data/` reports 1.6 GB by following the symlink; the local footprint is ~0.

## Writers (archive state)

`shadow-wallet.ts`, `maker-paper-daemon.ts`, `binary-pair-maker-paper.ts` write here. Stopped for cold
archival. **Requires `/Volumes/My Passport` mounted** when running.

⚠️ The `data` symlink IS the repoint mechanism. Do NOT `rm -rf data/*` — it follows the link and deletes the
real archive on MyPassport. To relocate the archive, change the symlink target, don't delete the data.

> Note: a *different* repo at `~/Documents/Software/HFT` (Python `book-snapshot`/`carry`/`basis` daemons)
> writes its own `HFT/data/*.db` and is unrelated to this archive.
