# install-realtime-worker.ps1
#
# Registers a Windows Scheduled Task that runs `run-realtime-supervised.ps1`
# at user logon and keeps it alive. The supervisor handles restarts internally
# (poor-man's PM2), so this task is mostly a "start on logon" wrapper.
#
# - Trigger: AtLogon for the current user
# - MultipleInstances: IgnoreNew — second logon never double-starts the worker
# - ExecutionTimeLimit: 0 (unlimited — the supervisor is supposed to run forever)
#
# Idempotent: removes any existing task with the same name before re-registering.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install-realtime-worker.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-realtime-worker.ps1 -TaskName "MyRealtime"

param(
    [string]$TaskName = 'PolymarketRealtimeWorker'
)

$ErrorActionPreference = 'Stop'

$Launcher = Join-Path $PSScriptRoot 'run-realtime-supervised.ps1'
if (-not (Test-Path $Launcher)) {
    throw "supervisor missing: $Launcher"
}

# Remove any existing task with the same name (idempotent).
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$TaskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""

# Trigger: at logon for the current user.
$trigger = New-ScheduledTaskTrigger -AtLogon

# Settings: no time limit (supervisor loops forever), single instance,
# allow start on battery, restart if it crashes.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Days 9999) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Runs PolymarketAutomation WS worker:realtime under a supervisor that respawns on crash. Logs to data/scheduler/worker-realtime.<date>.log." | Out-Null

Write-Host "Task '$TaskName' installed — starts at logon, supervisor restarts on crash." -ForegroundColor Green
# Single-quoted lines so PowerShell doesn't try to interpret < as a
# redirection operator on the literal '<repo>' / '<date>' placeholders.
Write-Host '  Logs:   (repo)/data/scheduler/worker-realtime.(date).log'
Write-Host "  Manage: Get-ScheduledTask -TaskName $TaskName"
Write-Host "  Start:  Start-ScheduledTask -TaskName $TaskName"
Write-Host '  Remove: powershell -ExecutionPolicy Bypass -File .\uninstall-realtime-worker.ps1'
