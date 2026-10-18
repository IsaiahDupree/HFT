# run-realtime-supervised.ps1
#
# Poor-man's PM2 for the long-running WS worker. Loops:
#   npm run worker:realtime
# restarting on exit with capped exponential backoff. Audit fix PW1.
#
# Designed to be the action of a Windows Task Scheduler task registered with
# `install-realtime-worker.ps1` (runs at user logon, single instance only).
#
# Exit behavior:
#   - Worker exits 0  → restart after BackoffMin (default 1s)
#   - Worker exits >0 → restart after exponential backoff capped at BackoffMax
#   - This script never exits on its own (intentional — keep WS running)
#   - SIGINT / Ctrl+C from the operator stops both worker and this script
#
# Logs land in <repo>/data/scheduler/worker-realtime.<yyyy-MM-dd>.log
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\run-realtime-supervised.ps1

param(
    [int]$BackoffMin = 1,
    [int]$BackoffMax = 30
)

$ErrorActionPreference = 'Continue'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $RepoRoot

$LogDir = Join-Path $RepoRoot 'data\scheduler'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function LogFile {
    Join-Path $LogDir ("worker-realtime.{0:yyyy-MM-dd}.log" -f (Get-Date))
}
function Write-Log([string]$Line) {
    $stamp = (Get-Date).ToString('o')
    Add-Content -Path (LogFile) -Value "[$stamp] $Line"
}

Write-Log "-- supervisor start (BackoffMin=$BackoffMin, BackoffMax=$BackoffMax) --"

$backoff = $BackoffMin
while ($true) {
    Write-Log "starting worker:realtime..."
    $startedAt = Get-Date
    try {
        # Stream worker output into the log so we capture WS heartbeats + tick
        # writes + any startup errors. npm.cmd because we're a PowerShell host
        # and need the shim.
        $proc = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'worker:realtime' `
            -NoNewWindow -PassThru -RedirectStandardOutput "$LogDir\worker-stdout.log" `
            -RedirectStandardError "$LogDir\worker-stderr.log" -Wait
        $exit = $proc.ExitCode
    } catch {
        Write-Log "supervisor: spawn failed: $_"
        $exit = -1
    }
    $duration = ((Get-Date) - $startedAt).TotalSeconds
    Write-Log "worker exited (exit=$exit duration=$([math]::Round($duration,1))s)"

    # Reset backoff if the worker ran for >= 60s before exiting (healthy enough).
    if ($duration -ge 60) { $backoff = $BackoffMin }

    Write-Log "restarting in ${backoff}s..."
    Start-Sleep -Seconds $backoff

    # Exponential backoff capped at BackoffMax.
    $backoff = [Math]::Min($backoff * 2, $BackoffMax)
}
