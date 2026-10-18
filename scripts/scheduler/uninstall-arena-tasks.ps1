# uninstall-arena-tasks.ps1
#
# Removes the PolymarketArenaTick scheduled task (or a custom name via -TaskName).
# Idempotent — exits 0 even if the task wasn't there.

param([string]$TaskName = 'PolymarketArenaTick')

$ErrorActionPreference = 'Stop'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Task '$TaskName' removed." -ForegroundColor Green
} else {
    Write-Host "No task named '$TaskName' was registered. Nothing to do." -ForegroundColor Yellow
}
