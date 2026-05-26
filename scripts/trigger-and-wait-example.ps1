# Example PowerShell script to trigger and wait for a Newman run.
# Required env vars:
# - NEWMAN_TRIGGER_BASE_URL (e.g., https://your-runner-url)
# - NEWMAN_TRIGGER_TOKEN

$headers = @{
  "Content-Type" = "application/json"
  "x-trigger-token" = $env:NEWMAN_TRIGGER_TOKEN
}

$triggerBody = @{
  mode = "ci"
} | ConvertTo-Json

$triggerUrl = "$($env:NEWMAN_TRIGGER_BASE_URL)/run-tests"
$trigger = Invoke-RestMethod -Method Post -Uri $triggerUrl -Headers $headers -Body $triggerBody

$runId = $trigger.runId
Write-Host "Triggered run ID: $runId"

$status = "running"
while ($status -eq "running") {
  Start-Sleep -Seconds 5
  $statusUrl = "$($env:NEWMAN_TRIGGER_BASE_URL)/runs/$runId"
  $run = Invoke-RestMethod -Method Get -Uri $statusUrl -Headers $headers
  $status = $run.status
  Write-Host "Current status: $status"
}

if ($status -ne "passed") {
  Write-Error "Newman run failed. Run ID: $runId"
  exit 1
}

Write-Host "Newman run passed. Run ID: $runId"
