# Example PowerShell script to trigger containerized Newman tests from a release pipeline.
# Required env vars:
# - NEWMAN_TRIGGER_URL (e.g., https://your-runner-url/run-tests)
# - NEWMAN_TRIGGER_TOKEN

$headers = @{
  "Content-Type" = "application/json"
  "x-trigger-token" = $env:NEWMAN_TRIGGER_TOKEN
}

$body = @{
  mode = "ci"
} | ConvertTo-Json

$response = Invoke-RestMethod -Method Post -Uri $env:NEWMAN_TRIGGER_URL -Headers $headers -Body $body
Write-Host "Triggered run ID: $($response.runId)"
Write-Host "Status URL: $($response.statusUrl)"
