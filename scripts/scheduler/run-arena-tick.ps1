# run-arena-tick.ps1
#
# Single tick launcher invoked by Windows Task Scheduler. Runs
#   npm run worker:snapshot && npm run arena:tick
# from the repo root, capturing all output to a daily log file. Auto-evolve
# is triggered inside arena-tick when ARENA_EVOLVE_EVERY is crossed.
#
# Exit codes:
#   0 = both commands succeeded
#   1 = snapshot failed
#   2 = arena:tick failed (snapshot ok)
#   3 = unexpected error
#
# Logs land in <repo>/data/scheduler/arena-tick.<yyyy-MM-dd>.log

$ErrorActionPreference = 'Stop'
try {
    $RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
    Set-Location $RepoRoot

    $LogDir = Join-Path $RepoRoot 'data\scheduler'
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $LogFile = Join-Path $LogDir ("arena-tick.{0:yyyy-MM-dd}.log" -f (Get-Date))

    function Write-Log([string]$Line) {
        $stamp = (Get-Date).ToString('o')
        Add-Content -Path $LogFile -Value "[$stamp] $Line"
    }

    Write-Log "-- tick start --"
    Write-Log "  cwd=$RepoRoot"

    # Snapshot first.
    $snap = & npm.cmd run worker:snapshot 2>&1
    $snapExit = $LASTEXITCODE
    $snap | ForEach-Object { Write-Log "  [snapshot] $_" }
    if ($snapExit -ne 0) {
        Write-Log "snapshot failed (exit=$snapExit)"
        exit 1
    }

    # Then arena tick (also auto-triggers evolve when threshold crossed).
    $tick = & npm.cmd run arena:tick 2>&1
    $tickExit = $LASTEXITCODE
    $tick | ForEach-Object { Write-Log "  [tick] $_" }
    if ($tickExit -ne 0) {
        Write-Log "arena:tick failed (exit=$tickExit)"
        exit 2
    }

    Write-Log "-- tick ok --"
    exit 0
} catch {
    if ($LogFile) { Add-Content -Path $LogFile -Value "[$([DateTime]::Now.ToString('o'))] FATAL: $_" }
    exit 3
}
