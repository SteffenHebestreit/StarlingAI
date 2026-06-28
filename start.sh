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

# ── 2. Port preflight — name conflicts up front instead of a raw bind error ───
# Non-fatal: a busy port is expected if StarlingAI is already running.
section "Checking ports"
# A successful TCP connect to the port means something is already listening.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in 3001 3002 8765; do
  if port_busy "$p"; then
    warn "Port $p is already in use — if StarlingAI isn't already running, free it (or set the matching port) or the stack can't bind."
  fi
done

# ── 3. First-run guided setup (inside Docker — no host Node needed) ───────────
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

# ── 4. Compose file stack (Ollama overlay + opt-in RAG/GPU) ───────────────────
backend="$(sed -n 's/^SAI_MODEL_BACKEND=//p' .env | head -n1 | tr -d '[:space:]')"
compose_files=(-f docker-compose.yml)
profile_args=()
if [ "$backend" = "ollama" ]; then
  compose_files+=(-f docker-compose.ollama.yml)
  ok "Local model backend (Ollama) — model is pulled automatically on first start"
fi
# Document-RAG (engram + reranker) is opt-in — the reranker reserves a GPU, so it
# is OFF unless SAI_ENABLE_RAG is set. Add the GPU overlay only when a GPU exists.
rag="$(sed -n 's/^SAI_ENABLE_RAG=//p' .env | head -n1 | tr -d '[:space:]')"
case "$rag" in
  1|true|yes|on|TRUE|Yes|On)
    profile_args+=(--profile rag)
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
      compose_files+=(-f docker-compose.gpu.yml); ok "Document-RAG enabled — GPU detected (reranker on GPU)"
    else
      ok "Document-RAG enabled — no GPU, reranker on CPU"
    fi
    ;;
esac

# Host path for sandbox/sub-container bind mounts (mirrors scripts/sai.mjs).
export SAI_WORKSPACE_MOUNT_SOURCE="$PWD"

# ── 5. Build + start ─────────────────────────────────────────────────────────
section "Building and starting StarlingAI"
printf "${gray}First run builds the images and can take several minutes. Later starts are fast.${reset}\n"
docker compose "${compose_files[@]}" "${profile_args[@]}" up -d --build
ok "All services are starting"

# ── 6. Wait for the gateway to be healthy BEFORE opening the browser ─────────
# (Opening immediately shows a connection-refused/blank page for the first minute.)
section "Waiting for the gateway"
printf "${gray}First start can take a minute while images build and services come up.${reset}\n"
ready=""
for _ in $(seq 1 80); do
  if curl -sf http://localhost:8765/healthz >/dev/null 2>&1; then ready=1; break; fi
  printf "."; sleep 3
done
printf "\n"
if [ -n "$ready" ]; then ok "Gateway is healthy"; else warn "Gateway not healthy yet (~4 min). It may still be coming up — check: docker compose logs -f gateway"; fi

# ── 7. Open the dashboard (auto-signed-in via a freshly-minted token) ────────
# Re-mint every start so a returning user is never locked out by an expired token.
section "Dashboard login"
token="$(docker run --rm -v "$PWD:/work" -w /work node:22-alpine node scripts/gen-token.mjs --ttl 30d 2>/dev/null | tr -d '[:space:]' || true)"
url="http://localhost:3001"
[ -n "$token" ] && url="http://localhost:3001/?token=$token"
echo "$url"
open_url "$url" || true
printf "\n${green}StarlingAI is up.${reset}  Dashboard: http://localhost:3001  ·  Tutorials: http://localhost:3002\n"
printf "${gray}To stop it later:  docker compose down${reset}\n\n"
