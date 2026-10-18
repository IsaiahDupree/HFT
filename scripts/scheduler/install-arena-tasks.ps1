# install-arena-tasks.ps1
#
# Registers a Windows Scheduled Task that calls run-arena-tick.ps1 every 5
# minutes. Idempotent: removes any existing task with the same name before
# re-registering.
#
# Default cadence is 5 minutes; override with -IntervalMinutes <n>.
# Default task name is "PolymarketArenaTick".
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install-arena-tasks.ps1
#   powershell -ExecutionPolicy Bypass -File .\install-arena-tasks.ps1 -IntervalMinutes 10
#   powershell -ExecutionPolicy Bypass -File .\install-arena-tasks.ps1 -TaskName "MyArena"

param(
    [int]$IntervalMinutes = 5,
    [string]$TaskName = 'PolymarketArenaTick'
)

$ErrorActionPreference = 'Stop'

$Launcher = Join-Path $PSScriptRoot 'run-arena-tick.ps1'
if (-not (Test-Path $Launcher)) {
    throw "launcher missing: $Launcher"
}

# Remove any existing task with the same name (idempotent).
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Removing existing task '$TaskName'..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Build the action: powershell.exe -ExecutionPolicy Bypass -File <launcher>
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""

# Trigger: now + 1 minute, repeating every IntervalMinutes forever (well, 9999 days).
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1))
$trigger.Repetition = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 9999) | Select-Object -ExpandProperty Repetition

# Run whether user logged in or not, but don't require admin or stored password.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
    -MultipleInstances IgnoreNew

# Run as the current interactive user.
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Runs PolymarketAutomation snapshot worker + arena:tick every $IntervalMinutes min. Auto-evolve fires inside arena:tick at ARENA_EVOLVE_EVERY." | Out-Null

Write-Host "Task '$TaskName' installed — runs every $IntervalMinutes minute(s)." -ForegroundColor Green
# Single-quoted to avoid PowerShell parsing '<repo>' / '<date>' as
# redirection operators (the '<' is reserved for future use).
Write-Host '  Logs:   (repo)/data/scheduler/arena-tick.(date).log'
Write-Host "  Manage: schtasks /Query /TN $TaskName    or    Get-ScheduledTask -TaskName $TaskName"
Write-Host '  Remove: powershell -File uninstall-arena-tasks.ps1'
