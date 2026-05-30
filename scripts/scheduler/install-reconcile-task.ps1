# install-reconcile-task.ps1
#
# Registers a Windows Scheduled Task that calls run-reconcile.ps1 every 15
# minutes. Companion to install-arena-tasks.ps1 — without this, the
# reconciler is orphaned (the npm script exists but nothing invokes it).
#
# Idempotent: removes any existing task with the same name before
# re-registering. Single-instance: an in-flight pass blocks the next.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install-reconcile-task.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-reconcile-task.ps1 -IntervalMinutes 30

param(
    [int]$IntervalMinutes = 15,
    [string]$TaskName = 'PolymarketReconcile'
)

$ErrorActionPreference = 'Stop'

$Launcher = Join-Path $PSScriptRoot 'run-reconcile.ps1'
if (-not (Test-Path $Launcher)) {
    throw "launcher missing: $Launcher"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$TaskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""

$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2))
$trigger.Repetition = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 9999) | Select-Object -ExpandProperty Repetition

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Runs PolymarketAutomation reconcile worker every $IntervalMinutes min — compares local order state against broker reality (Polymarket + Coinbase) and flags drifts." | Out-Null

Write-Host "Task '$TaskName' installed - runs every $IntervalMinutes minute(s)." -ForegroundColor Green
Write-Host '  Logs:   (repo)/data/scheduler/reconcile.(date).log'
Write-Host "  Manage: schtasks /Query /TN $TaskName    or    Get-ScheduledTask -TaskName $TaskName"
Write-Host '  Remove: Unregister-ScheduledTask -TaskName PolymarketReconcile -Confirm:$false'
