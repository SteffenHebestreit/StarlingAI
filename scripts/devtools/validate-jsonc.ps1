$files = @(
  'F:\StarlingAI\workspace\scenes\10-scenes.jsonc',
  'F:\StarlingAI\workspace\jobs\10-jobs.jsonc',
  'F:\StarlingAI\workspace\agents\20-subagents-general.jsonc'
)
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
