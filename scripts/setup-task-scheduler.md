# Auto-poll setup (Windows Task Scheduler)

GitHub Actions cron is best-effort and routinely lags 5–15 minutes during
busy hours. To keep `scores.json` and `entries.json` fresh during the
tournament, run a Windows Scheduled Task on any always-on Windows machine
that triggers all three workflows every 2 minutes.

The workflows themselves only commit if data actually changed, so
over-triggering is harmless — the cost is just a few extra free-tier
Actions minutes.

## One-time setup on the host machine

1. **Install GitHub CLI** (skip if already installed):
   ```powershell
   winget install --id GitHub.cli
   ```
   Open a new PowerShell window so `gh` is on PATH.

2. **Authenticate** as the GitHub account that owns the repo:
   ```powershell
   gh auth login
   ```
   Choose: GitHub.com → HTTPS → Login with browser → paste the one-time code.

3. **Clone the repo** somewhere stable (the path is referenced by the
   scheduled task, so don't move it after install):
   ```powershell
   git clone https://github.com/dopper3/pga-pool C:\git\pga-pool
   ```

4. **Register the scheduled task:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\git\pga-pool\scripts\install-auto-poll.ps1
   ```
   That registers `pga-pool-auto-poll` to fire every 2 min from now through
   Sun May 17 23:59 UTC. It runs hidden (no popup window each fire) under
   the current user — no admin rights required.

## Verify it's working

```powershell
# Force-fire it once to test:
Start-ScheduledTask -TaskName pga-pool-auto-poll

# Check next run / last result:
Get-ScheduledTask pga-pool-auto-poll | Get-ScheduledTaskInfo

# Check the GitHub Actions runs page — should show fresh runs every ~2 min:
gh run list --repo dopper3/pga-pool --limit 10
```

Failures (e.g. gh auth expired) get logged to
`%TEMP%\pga-pool-auto-poll.log`. Successful runs are silent.

## Remove

```powershell
Unregister-ScheduledTask -TaskName pga-pool-auto-poll -Confirm:$false
```

## Why this exists

The three workflows have their own GitHub-side crons:
- `update-scores.yml` — every 15 min through May
- `poll-form.yml` — every 5 min through May
- `poll-showdown.yml` — every 2 min during Sat 22 UTC → Sun 14:58 UTC

In practice GitHub cron is unreliable enough that "every 15 minutes" can
become "every 25 minutes" during a major sporting event when load is high.
External triggering via `gh workflow run` from a Scheduled Task is much
tighter and the workflows are idempotent.
