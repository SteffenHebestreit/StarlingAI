#!/usr/bin/env bash
# StarlingAI — one-click launcher (macOS / Linux).
#
# The ONLY prerequisite is Docker. No Node, no pnpm, no manual config: the
# guided setup wizard runs inside a throwaway Docker container on first run,
# then the whole stack is built, started, and the dashboard opens.
set -euo pipefail
cd "$(dirname "$0")"

cyan="\033[36m"; green="\033[32m"; yellow="\033[33m"; gray="\033[2m"; reset="\033[0m"
section() { printf "\n${cyan}=== %s ===${reset}\n" "$1"; }
ok()      { printf "${green}OK  %s${reset}\n" "$1"; }
warn()    { printf "${yellow}!!  %s${reset}\n" "$1"; }

printf "\n  StarlingAI launcher\n"

open_url() {
  if command -v open >/dev/null 2>&1; then open "$1"            # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"  # Linux
  else printf "Open this in your browser: %s\n" "$1"; fi
}

# ── 1. Docker present + running ──────────────────────────────────────────────
section "Checking Docker"
if ! command -v docker >/dev/null 2>&1; then
  warn "Docker is not installed."
  echo "Install Docker Desktop / Docker Engine, then run this again: https://www.docker.com/products/docker-desktop/"
  open_url "https://www.docker.com/products/docker-desktop/" || true
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  warn "Docker is installed but not running. Start Docker, then run this again."
  exit 1
fi
ok "Docker is ready"

# ── 2. First-run guided setup (inside Docker — no host Node needed) ───────────
if [ ! -f .env ] || [ ! -f starlingai.json ]; then
  section "First-run setup"
  echo "Launching the guided setup wizard..."
  docker run --rm -it -v "$PWD:/work" -w /work node:22-alpine node scripts/setup-wizard.mjs
  if [ ! -f .env ]; then
    warn "Setup did not complete. Run the launcher again to retry."
    exit 1
  fi
else
  ok "Already configured (.env present) — skipping setup"
fi

# ── 3. Compose file stack (add the Ollama overlay if chosen) ──────────────────
backend="$(sed -n 's/^SAI_MODEL_BACKEND=//p' .env | head -n1 | tr -d '[:space:]')"
compose_files=(-f docker-compose.yml)
if [ "$backend" = "ollama" ]; then
  compose_files+=(-f docker-compose.ollama.yml)
  ok "Local model backend (Ollama) — model is pulled automatically on first start"
fi

# Host path for sandbox/sub-container bind mounts (mirrors scripts/sai.mjs).
export SAI_WORKSPACE_MOUNT_SOURCE="$PWD"

# ── 4. Build + start ─────────────────────────────────────────────────────────
section "Building and starting StarlingAI"
printf "${gray}First run builds the images and can take several minutes. Later starts are fast.${reset}\n"
docker compose "${compose_files[@]}" up -d --build
ok "All services are starting"

# ── 5. Open the dashboard (auto-signed-in via the minted token) ──────────────
token=""
[ -f .starlingai/dashboard-token.txt ] && token="$(tr -d '[:space:]' < .starlingai/dashboard-token.txt)"
url="http://localhost:3001"
[ -n "$token" ] && url="http://localhost:3001/?token=$token"
section "Opening the dashboard"
echo "$url"
open_url "$url" || true
printf "\n${green}StarlingAI is up. To stop it later:  docker compose down${reset}\n\n"
