param(
  [string]$Token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc3NjMyMjcwMCwiZXhwIjoxNzc2NDA5MTAwfQ.7KbZLiK0yUDrWmwvT2zv3dnQ7Y7swrUncDK9EYByl6c',
  [string]$BaseUrl = 'http://localhost:8765'
)

$headers = @{ Authorization = "Bearer $Token"; 'Content-Type' = 'application/json' }

Write-Host "=== TURN 1 ===" -ForegroundColor Cyan
$msg1 = "lass uns einen neuen worflow generieren`n`nbrowser-agent offnet eine instanz auf http://n8n.k2o, dann werden die passenden credentials eingefuegt und nach dem einloggen die seite der project-list geoeffnet"
$body1 = [pscustomobject]@{ message = $msg1 } | ConvertTo-Json -Compress
$content1 = (Invoke-WebRequest -UseBasicParsing -Method Post -Headers $headers -Uri "$BaseUrl/api/chat/stream" -Body $body1).Content

$keyLines1 = ($content1 -split "`n") | Where-Object { $_ -match 'RUN_STARTED|TOOL_CALL_STARTED|TOOL_CALL_ENDED|RUN_FINISHED|RUN_ERROR' }
$keyLines1 | ForEach-Object { Write-Host $_ }

# Extract threadId
$threadIdMatch = ($content1 -split "`n") | Select-String '"threadId"\s*:\s*"([^"]+)"' | Select-Object -First 1
if (-not $threadIdMatch) {
    $threadIdMatch = ($content1 -split "`n") | Select-String 'threadId:([a-f0-9-]{36})' | Select-Object -First 1
}
$threadId = $null
if ($threadIdMatch) {
    if ($threadIdMatch.Line -match '"threadId"\s*:\s*"([^"]+)"') { $threadId = $Matches[1] }
    elseif ($threadIdMatch.Line -match 'threadId:([a-f0-9-]{36})') { $threadId = $Matches[1] }
}

Write-Host ""
Write-Host "threadId: $threadId" -ForegroundColor Yellow

if (-not $threadId) {
    Write-Host "ERROR: Could not extract threadId from turn 1" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== TURN 2 ===" -ForegroundColor Cyan
$msg2 = "ist alles in den cedentials hintelegt und in den site-data"
$body2 = [pscustomobject]@{ sessionId = $threadId; message = $msg2 } | ConvertTo-Json -Compress
$content2 = (Invoke-WebRequest -UseBasicParsing -Method Post -Headers $headers -Uri "$BaseUrl/api/chat/stream" -Body $body2).Content

$keyLines2 = ($content2 -split "`n") | Where-Object { $_ -match 'RUN_STARTED|TOOL_CALL_STARTED|TOOL_CALL_ENDED|RUN_FINISHED|RUN_ERROR|guardrail' }
$keyLines2 | ForEach-Object { Write-Host $_ }

Write-Host ""
# Summary
$t1Delegate = ($content1 -split "`n") | Where-Object { $_ -match 'delegate_to_agent|swarm_maintainer' }
$t2Delegate = ($content2 -split "`n") | Where-Object { $_ -match 'delegate_to_agent|swarm_maintainer' }
$t2Guardrail = ($content2 -split "`n") | Where-Object { $_ -match 'workflow_catalog_check_rejected|tool_free_maintenance' }

Write-Host "=== SUMMARY ===" -ForegroundColor Green
Write-Host "Turn 1 delegate calls: $($t1Delegate.Count)"
Write-Host "Turn 2 delegate calls: $($t2Delegate.Count)"
Write-Host "Turn 2 catalog-rejected guardrails: $($t2Guardrail.Count)"

if ($t2Delegate.Count -gt 0) {
    Write-Host "PASS: Turn 2 delegated correctly" -ForegroundColor Green
} else {
    Write-Host "FAIL: Turn 2 did not delegate" -ForegroundColor Red
}
if ($t2Guardrail.Count -eq 0) {
    Write-Host "PASS: No false catalog rejection on turn 2" -ForegroundColor Green
} else {
    Write-Host "INFO: Guardrail events on turn 2:" -ForegroundColor Yellow
    $t2Guardrail | ForEach-Object { Write-Host "  $_" }
}
