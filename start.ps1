# StarlingAI — one-click launcher (Windows).
#
# The ONLY prerequisite is Docker Desktop. This script needs no Node, no pnpm,
# and no manual config: it runs the guided setup wizard inside a throwaway
# Docker container on first run, then builds and starts the whole stack and
# opens the dashboard. Double-click start.bat, or run:  powershell -File start.ps1
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Section($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)      { Write-Host "OK  $m" -ForegroundColor Green }
function Warn($m)    { Write-Host "!!  $m" -ForegroundColor Yellow }

Write-Host "`n  StarlingAI launcher" -ForegroundColor White

# ── 1. Docker present + running ──────────────────────────────────────────────
Section "Checking Docker"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Warn "Docker is not installed."
  Write-Host "Install Docker Desktop, then run this again: https://www.docker.com/products/docker-desktop/"
  Start-Process "https://www.docker.com/products/docker-desktop/"
  Read-Host "Press Enter to close"; exit 1
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Warn "Docker is installed but not running. Start Docker Desktop, wait for it to go green, then run this again."
  Read-Host "Press Enter to close"; exit 1
}
Ok "Docker is ready"

# ── 2. First-run guided setup (inside Docker — no host Node needed) ───────────
if (-not (Test-Path ".env") -or -not (Test-Path "starlingai.json")) {
  Section "First-run setup"
  Write-Host "Launching the guided setup wizard..."
  & docker run --rm -it -v "${PSScriptRoot}:/work" -w /work node:22-alpine node scripts/setup-wizard.mjs
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path ".env")) {
    Warn "Setup did not complete. Run the launcher again to retry."
    Read-Host "Press Enter to close"; exit 1
  }
} else {
  Ok "Already configured (.env present) — skipping setup"
}

# ── 3. Compose file stack (add the Ollama overlay if chosen) ──────────────────
$backend = ""
$m = Select-String -Path ".env" -Pattern '^SAI_MODEL_BACKEND=(.*)$' -ErrorAction SilentlyContinue
if ($m) { $backend = $m.Matches[0].Groups[1].Value.Trim() }
$composeFiles = @("-f", "docker-compose.yml")
if ($backend -eq "ollama") {
  $composeFiles += @("-f", "docker-compose.ollama.yml")
  Ok "Local model backend (Ollama) — model is pulled automatically on first start"
}

# Host path for sandbox/sub-container bind mounts (mirrors scripts/sai.mjs).
$env:SAI_WORKSPACE_MOUNT_SOURCE = $PSScriptRoot

# ── 4. Build + start ─────────────────────────────────────────────────────────
Section "Building and starting StarlingAI"
Write-Host "First run builds the images and can take several minutes. Subsequent starts are fast." -ForegroundColor DarkGray
& docker compose @composeFiles up -d --build
if ($LASTEXITCODE -ne 0) {
  Warn "Startup failed. Scroll up for the error, fix it, then run the launcher again."
  Read-Host "Press Enter to close"; exit 1
}
Ok "All services are starting"

# ── 5. Open the dashboard (auto-signed-in via the minted token) ──────────────
$token = ""
if (Test-Path ".starlingai\dashboard-token.txt") { $token = (Get-Content ".starlingai\dashboard-token.txt" -Raw).Trim() }
$url = if ($token) { "http://localhost:3001/?token=$token" } else { "http://localhost:3001" }
Section "Opening the dashboard"
Write-Host $url
Start-Process $url
Write-Host "`nStarlingAI is up. To stop it later:  docker compose down`n" -ForegroundColor Green
