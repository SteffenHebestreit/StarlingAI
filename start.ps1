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

# ── 2. Port preflight — name conflicts up front instead of a raw bind error ───
# Non-fatal: a busy port is expected if StarlingAI is already running.
Section "Checking ports"
foreach ($p in 3001, 3002, 8765) {
  $busy = $false
  try { if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { $busy = $true } } catch {}
  if ($busy) { Warn "Port $p is already in use — if StarlingAI isn't already running, free it or the stack can't bind." }
}

# ── 3. First-run guided setup (inside Docker — no host Node needed) ───────────
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

# ── 4. Compose file stack (Ollama overlay + opt-in RAG/GPU) ───────────────────
$backend = ""
$m = Select-String -Path ".env" -Pattern '^SAI_MODEL_BACKEND=(.*)$' -ErrorAction SilentlyContinue
if ($m) { $backend = $m.Matches[0].Groups[1].Value.Trim() }
$composeFiles = @("-f", "docker-compose.yml")
$profileArgs = @()
if ($backend -eq "ollama") {
  $composeFiles += @("-f", "docker-compose.ollama.yml")
  Ok "Local model backend (Ollama) — model is pulled automatically on first start"
}
# Document-RAG (engram + reranker) is opt-in — the reranker reserves a GPU, so it
# is OFF unless SAI_ENABLE_RAG is set. Add the GPU overlay only when a GPU exists.
$rag = ""
$rm = Select-String -Path ".env" -Pattern '^SAI_ENABLE_RAG=(.*)$' -ErrorAction SilentlyContinue
if ($rm) { $rag = $rm.Matches[0].Groups[1].Value.Trim() }
if ($rag -match '^(1|true|yes|on)$') {
  $profileArgs += @("--profile", "rag")
  $hasGpu = $false
  if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { & nvidia-smi -L *> $null; if ($LASTEXITCODE -eq 0) { $hasGpu = $true } }
  if ($hasGpu) { $composeFiles += @("-f", "docker-compose.gpu.yml"); Ok "Document-RAG enabled — GPU detected (reranker on GPU)" }
  else { Ok "Document-RAG enabled — no GPU, reranker on CPU" }
}

# Host path for sandbox/sub-container bind mounts (mirrors scripts/sai.mjs).
$env:SAI_WORKSPACE_MOUNT_SOURCE = $PSScriptRoot

# ── 5. Build + start ─────────────────────────────────────────────────────────
Section "Building and starting StarlingAI"
Write-Host "First run builds the images and can take several minutes. Subsequent starts are fast." -ForegroundColor DarkGray
& docker compose @composeFiles @profileArgs up -d --build
if ($LASTEXITCODE -ne 0) {
  Warn "Startup failed. Scroll up for the error, fix it, then run the launcher again."
  Read-Host "Press Enter to close"; exit 1
}
Ok "All services are starting"

# ── 6. Wait for the gateway to be healthy BEFORE opening the browser ─────────
Section "Waiting for the gateway"
Write-Host "First start can take a minute while images build and services come up." -ForegroundColor DarkGray
$ready = $false
for ($i = 0; $i -lt 80; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:8765/healthz" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  Write-Host "." -NoNewline; Start-Sleep -Seconds 3
}
Write-Host ""
if ($ready) { Ok "Gateway is healthy" } else { Warn "Gateway not healthy yet (~4 min). It may still be coming up — check: docker compose logs -f gateway" }

# ── 7. Open the dashboard (auto-signed-in via a freshly-minted token) ────────
# Re-mint every start so a returning user is never locked out by an expired token.
Section "Dashboard login"
$token = ""
try { $token = (& docker run --rm -v "${PSScriptRoot}:/work" -w /work node:22-alpine node scripts/gen-token.mjs --ttl 30d 2>$null | Out-String).Trim() } catch {}
$url = if ($token) { "http://localhost:3001/?token=$token" } else { "http://localhost:3001" }
Write-Host $url
Start-Process $url
Write-Host "`nStarlingAI is up.  Dashboard: http://localhost:3001  |  Tutorials: http://localhost:3002" -ForegroundColor Green
Write-Host "To stop it later:  docker compose down`n" -ForegroundColor DarkGray
