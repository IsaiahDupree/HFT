# run-reconcile.ps1
#
# Single reconciler pass launcher invoked by Windows Task Scheduler. Runs
#   npm run worker:reconcile
# from the repo root and captures all output to a daily log file.
#
# The reconciler compares LOCAL order/trade state (paper_trades, capsule
# fills) against the actual broker (Polymarket CLOB + Coinbase Advanced
# Trade) and flags drifts — e.g., orders the broker filled but we haven't
# recorded, or vice versa. Without this running, a live capsule's state can
# silently diverge from reality.
#
# Cadence: every 15 minutes is plenty — reconcile reads the last 6 hours of
# fills each pass, so a longer gap just means more catch-up per run, not
# missed data. The launcher is single-instance (MultipleInstances IgnoreNew)
# so an in-flight reconcile won't get clobbered by the next trigger.
#
# Exit codes:
#   0 = reconciler succeeded
#   1 = reconciler reported a failure (one venue down, etc.)
#   3 = launcher itself crashed (env, path, etc.)
#
# Logs land in <repo>/data/scheduler/reconcile.<yyyy-MM-dd>.log

$ErrorActionPreference = 'Stop'
try {
    $RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    Set-Location $RepoRoot

    $LogDir = Join-Path $RepoRoot 'data\scheduler'
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $LogFile = Join-Path $LogDir ("reconcile.{0:yyyy-MM-dd}.log" -f (Get-Date))

    function Write-Log([string]$Line) {
        $stamp = (Get-Date).ToString('o')
        Add-Content -Path $LogFile -Value "[$stamp] $Line"
    }

    Write-Log "-- reconcile start --"
    Write-Log "  cwd=$RepoRoot"

    $out = & npm.cmd run worker:reconcile 2>&1
    $exit = $LASTEXITCODE
    $out | ForEach-Object { Write-Log "  $_" }

    if ($exit -ne 0) {
        Write-Log "reconcile failed (exit=$exit)"
        exit 1
    }

    Write-Log "-- reconcile ok --"
    exit 0
} catch {
    if ($LogFile) { Add-Content -Path $LogFile -Value "[$([DateTime]::Now.ToString('o'))] FATAL: $_" }
    exit 3
}
