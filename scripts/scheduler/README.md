# Arena scheduler — Windows Task Scheduler wiring

Three PowerShell scripts that let the arena run unattended on Windows.

```
scripts/scheduler/
├── run-arena-tick.ps1            # the launcher (called every N minutes)
├── install-arena-tasks.ps1       # registers the Scheduled Task
├── uninstall-arena-tasks.ps1     # removes it
└── README.md
```

## Install

```powershell
# from any working dir (the script resolves the repo root from its own location)
powershell -ExecutionPolicy Bypass -File .\scripts\scheduler\install-arena-tasks.ps1

# or with a custom cadence
powershell -ExecutionPolicy Bypass -File .\scripts\scheduler\install-arena-tasks.ps1 -IntervalMinutes 10
```

The installer registers a task named `PolymarketArenaTick` that runs every 5
minutes (configurable). Each run:

1. `npm run worker:snapshot` — pulls 20 Polymarket + 3 Coinbase price snapshots
2. `npm run arena:tick`      — every alive agent decides; auto-evolve fires
   when the generation's `tick_count` crosses `ARENA_EVOLVE_EVERY` (default 50)

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scheduler\uninstall-arena-tasks.ps1
```

## Inspect

```powershell
Get-ScheduledTask -TaskName PolymarketArenaTick | Get-ScheduledTaskInfo
schtasks /Query /TN PolymarketArenaTick /V /FO LIST
```

## Logs

Each tick appends to:

```
<repo>\data\scheduler\arena-tick.<yyyy-MM-dd>.log
```

The directory is auto-created on first run and is gitignored (it lives under
`data/`, which the repo-level `.gitignore` already excludes).

## Run manually

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\scheduler\run-arena-tick.ps1
```

Exit codes:
- `0` — snapshot + tick both succeeded
- `1` — snapshot failed
- `2` — arena:tick failed (snapshot was ok)
- `3` — fatal error before either command ran

## Notes

- The task runs as the interactive user (you), no stored password required.
  This means it only fires while you're logged in or have an active session.
- Time limit per run is 4 minutes; if a tick takes longer it gets killed.
- `MultipleInstances=IgnoreNew` so a slow tick can't pile up multiple
  concurrent runs.
- Battery: runs on battery if needed (you're not paying for compute).
