# Agents, scenes, and jobs each live in category-based shards — glob them all rather than
# hardcoding a monolith, so the validator stays correct as the layout evolves.
$agentFiles = Get-ChildItem 'F:\StarlingAI\workspace\agents\*.jsonc' | ForEach-Object { $_.FullName } | Sort-Object
$sceneFiles = Get-ChildItem 'F:\StarlingAI\workspace\scenes\*.jsonc' | ForEach-Object { $_.FullName } | Sort-Object
$jobFiles   = Get-ChildItem 'F:\StarlingAI\workspace\jobs\*.jsonc'   | ForEach-Object { $_.FullName } | Sort-Object
$files = $sceneFiles + $jobFiles + $agentFiles
$ok = $true
foreach ($f in $files) {
  $raw = Get-Content $f -Raw
  $stripped = $raw -replace '//[^\r\n]*', ''
  try {
    $null = $stripped | ConvertFrom-Json
    Write-Host "OK: $f"
  } catch {
    Write-Host "ERR: $f"
    Write-Host $_.Exception.Message
    $ok = $false
  }
}
if (-not $ok) { exit 1 }
