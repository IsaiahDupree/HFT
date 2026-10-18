# uninstall-realtime-worker.ps1
#
# Removes the scheduled task installed by install-realtime-worker.ps1.
# Companion to that script — same task name, idempotent.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\uninstall-realtime-worker.ps1
#   powershell -ExecutionPolicy Bypass -File .\uninstall-realtime-worker.ps1 -TaskName "MyRealtime"

param(
    [string]$TaskName = 'PolymarketRealtimeWorker'
)

$ErrorActionPreference = 'Stop'

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Task '$TaskName' not found (already uninstalled)." -ForegroundColor Yellow
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Task '$TaskName' uninstalled." -ForegroundColor Green
Write-Host "Note: any running supervisor process will continue until you kill it."
Write-Host "  Find it: Get-Process powershell | Where-Object { `$_.MainWindowTitle -like '*realtime*' }"
