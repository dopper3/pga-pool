# Registers a Windows Scheduled Task that fires auto-poll.ps1 every 2 minutes
# from now through Sun May 17, 2026 23:59 UTC (end of PGA Championship).
#
# Prereqs on the host machine:
#   1. GitHub CLI:    winget install --id GitHub.cli
#   2. Auth gh:       gh auth login   (browser flow, choose HTTPS, paste code)
#   3. Clone repo:    git clone https://github.com/dopper3/pga-pool C:\git\pga-pool
#
# Usage (run from an elevated PowerShell prompt is NOT required — task runs as
# the current user):
#   powershell -ExecutionPolicy Bypass -File install-auto-poll.ps1
#
# To remove:
#   Unregister-ScheduledTask -TaskName pga-pool-auto-poll -Confirm:$false
#
# To inspect the next run / last result:
#   Get-ScheduledTask pga-pool-auto-poll | Get-ScheduledTaskInfo
#
# To inspect failures:
#   Get-Content $env:TEMP\pga-pool-auto-poll.log -Tail 20

$taskName = "pga-pool-auto-poll"
# Launch via the .vbs wrapper so wscript.exe runs the script with no console
# window allocated (otherwise powershell.exe flashes a black box every fire).
$vbsPath = (Resolve-Path (Join-Path $PSScriptRoot "auto-poll-silent.vbs")).Path

# End the repetition at Sun May 17, 2026 23:59 UTC.
$endUtc = [DateTime]::SpecifyKind([DateTime]::Parse("2026-05-17T23:59:00"), [DateTimeKind]::Utc)
$endLocal = $endUtc.ToLocalTime()
$now = Get-Date
$duration = $endLocal - $now
if ($duration -le [TimeSpan]::Zero) {
  throw "End time $endLocal is already in the past - nothing to schedule."
}

$action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "`"$vbsPath`""

$trigger = New-ScheduledTaskTrigger `
  -Once -At $now `
  -RepetitionInterval (New-TimeSpan -Minutes 2) `
  -RepetitionDuration $duration

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Triggers dopper3/pga-pool GitHub Actions workflows every 2 minutes through the end of PGA Championship 2026 (Sun May 17 23:59 UTC). Compensates for unreliable GitHub cron." `
  -Force | Out-Null

Write-Output "Registered '$taskName'. Repeats every 2 min until $endLocal (local)."
Write-Output "Test now:  Start-ScheduledTask -TaskName $taskName"
Write-Output "Logs:      $env:TEMP\pga-pool-auto-poll.log (errors only)"
