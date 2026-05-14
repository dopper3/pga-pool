# Triggers all three pga-pool GitHub Actions workflows. Idempotent — each
# workflow only commits if data actually changed. Intended to be run every
# ~2 minutes by Windows Task Scheduler during PGA Championship week to
# compensate for GitHub cron lag.
#
# Failures are logged to %TEMP%\pga-pool-auto-poll.log (errors only — quiet
# on success to avoid log spam at 2-minute cadence).

$repo = "dopper3/pga-pool"
$workflows = @(
  "Update PGA Championship scores",
  "Poll Google Form",
  "Poll Sunday Showdown form"
)
$logFile = Join-Path $env:TEMP "pga-pool-auto-poll.log"

foreach ($wf in $workflows) {
  $result = & gh workflow run $wf --repo $repo 2>&1
  if ($LASTEXITCODE -ne 0) {
    "$(Get-Date -Format o) FAIL `"$wf`" : $result" | Add-Content -Path $logFile
  }
}
